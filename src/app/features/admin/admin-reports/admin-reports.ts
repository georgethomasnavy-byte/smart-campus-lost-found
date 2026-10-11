import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { AbuseReportStatus, AbuseReportWithRelations } from '../../../core/models/database.types';
import { AuthService } from '../../../core/services/auth.service';
import { ConfirmService } from '../../../core/services/confirm.service';
import { ReportsService } from '../../../core/services/reports.service';
import { ToastService } from '../../../core/services/toast.service';
import { TimeAgoPipe } from '../../../shared/pipes/time-ago.pipe';
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../../shared/components/error-state/error-state';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner';
import { StatusBadgeComponent } from '../../../shared/components/status-badge/status-badge';

/** Abuse-report queue (spec §23): review, dismiss or action a listing. */
@Component({
  selector: 'app-admin-reports',
  imports: [
    FormsModule, RouterLink, StatusBadgeComponent, TimeAgoPipe, LoadingSpinnerComponent,
    EmptyStateComponent, ErrorStateComponent,
  ],
  templateUrl: './admin-reports.html',
})
export class AdminReportsComponent implements OnInit {
  private readonly reports = inject(ReportsService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);

  readonly statusFilter = signal<AbuseReportStatus | ''>('pending');
  readonly rows = signal<AbuseReportWithRelations[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.rows.set(await this.reports.queue(this.statusFilter() || undefined));
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load abuse reports.');
    } finally {
      this.loading.set(false);
    }
  }

  changeFilter(value: string): void {
    this.statusFilter.set(value as AbuseReportStatus | '');
    void this.load();
  }

  async resolve(report: AbuseReportWithRelations, status: 'reviewed' | 'dismissed' | 'actioned'): Promise<void> {
    const reviewer = this.auth.profile();
    if (!reviewer) {
      return;
    }

    const titles: Record<typeof status, string> = {
      reviewed: 'Mark as reviewed',
      dismissed: 'Dismiss this report',
      actioned: 'Mark as actioned',
    };

    const answer = await this.confirm.confirm({
      title: titles[status],
      message:
        status === 'actioned'
          ? 'Use this once you have dealt with the listing (rejected, deleted or contacted the reporter).'
          : status === 'dismissed'
            ? 'The report will be closed without further action. The listing stays visible.'
            : 'The report will be marked as reviewed. The listing is unchanged.',
      confirmLabel: 'Confirm',
      danger: status === 'actioned',
    });
    if (!answer.confirmed) {
      return;
    }

    this.busyId.set(report.id);
    try {
      await this.reports.review(report.id, status, reviewer.user_id);
      this.toast.success('Report updated.');
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not update the report.');
    } finally {
      this.busyId.set(null);
    }
  }
}
