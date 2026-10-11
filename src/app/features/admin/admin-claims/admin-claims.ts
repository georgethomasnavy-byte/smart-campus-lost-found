import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { ClaimReviewDecision, ClaimStatus, ClaimWithRelations } from '../../../core/models/database.types';
import { AuthService } from '../../../core/services/auth.service';
import { ClaimsService } from '../../../core/services/claims.service';
import { ConfirmService } from '../../../core/services/confirm.service';
import { ToastService } from '../../../core/services/toast.service';
import { TimeAgoPipe } from '../../../shared/pipes/time-ago.pipe';
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../../shared/components/error-state/error-state';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner';
import { StatusBadgeComponent } from '../../../shared/components/status-badge/status-badge';

/**
 * Private administrator claim review. An approval is an ownership decision
 * only; a separate finder-confirmed RPC records the later physical handover.
 */
@Component({
  selector: 'app-admin-claims',
  imports: [
    FormsModule, RouterLink, StatusBadgeComponent, TimeAgoPipe, LoadingSpinnerComponent,
    EmptyStateComponent, ErrorStateComponent,
  ],
  templateUrl: './admin-claims.html',
})
export class AdminClaimsComponent implements OnInit {
  private readonly claims = inject(ClaimsService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);

  readonly statusFilter = signal<ClaimStatus | ''>('pending');
  readonly rows = signal<ClaimWithRelations[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  readonly pendingCount = computed(() =>
    this.rows().filter((row) => row.status === 'pending' || row.status === 'needs_info').length,
  );

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.rows.set(await this.claims.queue(this.statusFilter() || undefined));
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load the private claim queue.');
    } finally {
      this.loading.set(false);
    }
  }

  changeFilter(value: string): void {
    this.statusFilter.set(value as ClaimStatus | '');
    void this.load();
  }

  async approve(claim: ClaimWithRelations): Promise<void> {
    const answer = await this.confirm.confirm({
      title: 'Approve ownership claim?',
      message:
        `This records that ${claim.claimant?.full_name ?? 'the claimant'} is approved to receive ` +
        `"${claim.item?.title ?? 'the item'}". It does NOT mark the item returned. ` +
        'The finder must separately confirm the physical handover after giving the item to the claimant.',
      confirmLabel: 'Approve ownership',
      noteLabel: 'Private note for the claimant (optional)',
      notePlaceholder: 'Record the evidence reviewed or safe next steps.',
    });
    if (!answer.confirmed) {
      return;
    }
    await this.review(claim, 'approved', answer.note);
  }

  async reject(claim: ClaimWithRelations): Promise<void> {
    const answer = await this.confirm.confirm({
      title: 'Reject this claim?',
      message: 'This records a rejection with an audit entry and privately notifies the claimant. It does not delete the claim or mark the item returned.',
      confirmLabel: 'Reject claim',
      danger: true,
      noteLabel: 'Private reason (recommended)',
      notePlaceholder: 'Explain briefly what evidence did not match.',
    });
    if (!answer.confirmed) {
      return;
    }
    await this.review(claim, 'rejected', answer.note);
  }

  async requestMoreInfo(claim: ClaimWithRelations): Promise<void> {
    const answer = await this.confirm.confirm({
      title: 'Request more information?',
      message: 'The claimant will be asked privately for updated ownership details. Their claim remains open and the item is not returned.',
      confirmLabel: 'Request information',
      noteLabel: 'Question or missing evidence (required)',
      notePlaceholder: 'Ask for a detail needed to verify ownership.',
    });
    if (!answer.confirmed) {
      return;
    }
    if (answer.note.trim().length < 5) {
      this.toast.warning('Please enter a request of at least 5 characters.');
      return;
    }
    await this.review(claim, 'needs_info', answer.note);
  }

  private async review(
    claim: ClaimWithRelations,
    decision: ClaimReviewDecision,
    notes: string,
  ): Promise<void> {
    if (!this.auth.isLoggedIn() || !this.auth.isAdmin()) {
      this.toast.error('Administrator access is required to review claims.');
      return;
    }

    this.busyId.set(claim.id);
    try {
      await this.claims.review(claim.id, decision, notes || null);
      const confirmation = decision === 'approved'
        ? 'Ownership approved. The finder must still confirm the physical handover.'
        : decision === 'needs_info'
          ? 'A private request for more information was sent to the claimant.'
          : 'Claim rejected and recorded in the audit history.';
      this.toast.success(confirmation);
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not record the decision.');
    } finally {
      this.busyId.set(null);
    }
  }
}
