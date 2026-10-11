import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { ActivityLogWithUser } from '../../../core/models/database.types';
import { ActivityLogService } from '../../../core/services/activity-log.service';
import { TimeAgoPipe } from '../../../shared/pipes/time-ago.pipe';
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../../shared/components/error-state/error-state';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner';

/** Audit trail (spec §27) — readable by administrators only, append-only. */
@Component({
  selector: 'app-admin-logs',
  imports: [FormsModule, RouterLink, TimeAgoPipe, LoadingSpinnerComponent, EmptyStateComponent, ErrorStateComponent],
  templateUrl: './admin-logs.html',
})
export class AdminLogsComponent implements OnInit {
  private readonly logs = inject(ActivityLogService);

  readonly rows = signal<ActivityLogWithUser[]>([]);
  readonly actions = signal<string[]>([]);
  readonly actionFilter = signal('');
  readonly entityFilter = signal('');
  readonly limit = signal(200);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [rows, actions] = await Promise.all([
        this.logs.list({
          action: this.actionFilter() || undefined,
          entityType: this.entityFilter() || undefined,
          limit: this.limit(),
        }),
        this.actions().length ? Promise.resolve(this.actions()) : this.logs.actions(),
      ]);
      this.rows.set(rows);
      this.actions.set(actions);
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load the activity log.');
    } finally {
      this.loading.set(false);
    }
  }

  /** jsonb `details` rendered as one readable line. */
  detailsText(details: Record<string, unknown> | null): string {
    if (!details) {
      return '—';
    }
    const pairs = Object.entries(details).map(([key, value]) => {
      const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
      return `${key}: ${text}`;
    });
    return pairs.length ? pairs.join(' · ') : '—';
  }

  iconFor(action: string): string {
    if (action.includes('claim')) return 'bi-clipboard-check';
    if (action.includes('match')) return 'bi-bullseye';
    if (action.includes('item')) return 'bi-box-seam';
    if (action.includes('profile') || action.includes('login') || action.includes('logout')) return 'bi-person';
    if (action.includes('report')) return 'bi-flag';
    if (action.includes('role') || action.includes('admin')) return 'bi-shield-lock';
    return 'bi-activity';
  }
}
