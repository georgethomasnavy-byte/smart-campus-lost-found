import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { Profile, UserRole } from '../../../core/models/database.types';
import { AdminService } from '../../../core/services/admin.service';
import { AuthService } from '../../../core/services/auth.service';
import { ConfirmService } from '../../../core/services/confirm.service';
import { ToastService } from '../../../core/services/toast.service';
import { DateLabelPipe } from '../../../shared/pipes/date-label.pipe';
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../../shared/components/error-state/error-state';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner';
import { StatusBadgeComponent } from '../../../shared/components/status-badge/status-badge';

/** Search campus members and grant/revoke the separately protected admin role. */
@Component({
  selector: 'app-admin-users',
  imports: [
    FormsModule, RouterLink, DateLabelPipe, StatusBadgeComponent, LoadingSpinnerComponent,
    EmptyStateComponent, ErrorStateComponent,
  ],
  templateUrl: './admin-users.html',
})
export class AdminUsersComponent implements OnInit {
  private readonly admin = inject(AdminService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly rows = signal<Profile[]>([]);
  readonly activity = signal<Map<string, { items: number; claims: number }>>(new Map());
  readonly search = signal('');
  readonly roleFilter = signal<UserRole | ''>('');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  readonly adminCount = computed(() => this.rows().filter((row) => row.role === 'admin').length);
  readonly studentCount = computed(() => this.rows().filter((row) => row.campus_role === 'student').length);
  readonly facultyCount = computed(() => this.rows().filter((row) => row.campus_role === 'faculty').length);
  readonly staffCount = computed(() => this.rows().filter((row) => row.campus_role === 'staff').length);

  readonly visible = computed(() => {
    const term = this.search().trim().toLowerCase();
    return this.rows().filter((row) => {
      const matchesTerm =
        !term || row.full_name.toLowerCase().includes(term) || row.email.toLowerCase().includes(term);
      const matchesRole = !this.roleFilter()
        || (this.roleFilter() === 'admin' ? row.role === 'admin' : row.campus_role === this.roleFilter());
      return matchesTerm && matchesRole;
    });
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [rows, activity] = await Promise.all([this.admin.users(), this.admin.userActivity()]);
      this.rows.set(rows);
      this.activity.set(activity);
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load users.');
    } finally {
      this.loading.set(false);
    }
  }

  activityFor(userId: string): { items: number; claims: number } {
    return this.activity().get(userId) ?? { items: 0, claims: 0 };
  }

  isSelf(profile: Profile): boolean {
    return profile.user_id === this.auth.profile()?.user_id;
  }

  async changeRole(profile: Profile, role: UserRole): Promise<void> {
    if (this.isSelf(profile)) {
      this.toast.warning('You cannot change your own role. Ask another administrator.');
      return;
    }

    const restoring = profile.role === 'admin' && role !== 'admin';
    const answer = await this.confirm.confirm({
      title: role === 'admin' ? 'Grant administrator rights?' : 'Remove administrator rights?',
      message: role === 'admin'
        ? `${profile.full_name} will receive administrator privileges. Their ${profile.campus_role} campus identity will be preserved.`
        : restoring
          ? `${profile.full_name} will lose administrator privileges and return to the ${role} campus role. This does not remove their account or reports.`
          : `${profile.full_name}'s campus role will change from ${profile.campus_role} to ${role}.`,
      confirmLabel: role === 'admin' ? 'Make administrator' : restoring ? `Restore ${role}` : `Set ${role}`,
      danger: restoring,
      noteLabel: 'Reason (recorded in the audit log)',
      notePlaceholder: 'Optional reason for this role change.',
    });
    if (!answer.confirmed) {
      return;
    }

    this.busyId.set(profile.user_id);
    try {
      await this.admin.setRole(profile.user_id, role, answer.note);
      this.toast.success(role === 'admin'
        ? `${profile.full_name} is now an administrator.`
        : restoring
          ? `Administrator access removed; ${profile.full_name} is restored as ${role}.`
          : `${profile.full_name}'s campus role is now ${role}.`);
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not change the role.');
    } finally {
      this.busyId.set(null);
    }
  }
}
