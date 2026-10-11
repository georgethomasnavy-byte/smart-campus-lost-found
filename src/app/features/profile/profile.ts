import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';
import { ItemsService } from '../../core/services/items.service';
import { ToastService } from '../../core/services/toast.service';
import { DateLabelPipe } from '../../shared/pipes/date-label.pipe';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { StatusBadgeComponent } from '../../shared/components/status-badge/status-badge';

/** Profile page: member details, password reset and activity summary. */
@Component({
  selector: 'app-profile',
  imports: [FormsModule, RouterLink, DateLabelPipe, StatusBadgeComponent, LoadingSpinnerComponent],
  templateUrl: './profile.html',
})
export class ProfileComponent implements OnInit {
  readonly auth = inject(AuthService);
  private readonly items = inject(ItemsService);
  private readonly toast = inject(ToastService);

  readonly collegeDomain = computed(() => this.auth.collegeDomain());
  readonly supportEmail = environment.supportEmail;

  readonly fullName = signal('');
  readonly phone = signal('');
  readonly saving = signal(false);
  readonly resetting = signal(false);
  readonly stats = signal<{ lost: number; found: number; active: number; returned: number; closed: number } | null>(null);
  readonly loadingStats = signal(true);

  readonly profile = this.auth.profile;
  readonly roles = computed(() => {
    const campusRole = this.profile()?.campus_role ?? 'student';
    const campusLabel = campusRole.charAt(0).toUpperCase() + campusRole.slice(1);
    return this.auth.isAdmin() ? `Administrator · ${campusLabel}` : campusLabel;
  });

  ngOnInit(): void {
    const profile = this.auth.profile();
    this.fullName.set(profile?.full_name ?? '');
    this.phone.set(profile?.phone ?? '');
    void this.loadStats();
  }

  private async loadStats(): Promise<void> {
    const profile = this.auth.profile();
    if (!profile) {
      this.loadingStats.set(false);
      return;
    }
    try {
      this.stats.set(await this.items.myStats(profile.user_id));
    } catch {
      this.stats.set(null);
    } finally {
      this.loadingStats.set(false);
    }
  }

  async save(): Promise<void> {
    if (this.fullName().trim().length < 3) {
      this.toast.warning('Your name must be at least 3 characters long.');
      return;
    }

    this.saving.set(true);
    try {
      await this.auth.updateProfile({ full_name: this.fullName().trim(), phone: this.phone().trim() || null });
      this.toast.success('Profile updated.');
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not save your profile.');
    } finally {
      this.saving.set(false);
    }
  }

  /** Password changes go through Supabase Auth's e-mail flow — never stored here. */
  async sendPasswordReset(): Promise<void> {
    const email = this.auth.profile()?.email;
    if (!email) {
      return;
    }
    this.resetting.set(true);
    try {
      await this.auth.sendPasswordReset(email);
      this.toast.success(`Password reset link sent to ${email}.`);
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not send the reset e-mail.');
    } finally {
      this.resetting.set(false);
    }
  }

}
