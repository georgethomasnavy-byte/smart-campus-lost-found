import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ClaimWithRelations } from '../../../core/models/database.types';
import { AuthService } from '../../../core/services/auth.service';
import { ClaimsService, type PublicClaimHistoryWithItem } from '../../../core/services/claims.service';
import { ConfirmService } from '../../../core/services/confirm.service';
import { ToastService } from '../../../core/services/toast.service';
import { TimeAgoPipe } from '../../../shared/pipes/time-ago.pipe';
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../../shared/components/error-state/error-state';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner';
import { StatusBadgeComponent } from '../../../shared/components/status-badge/status-badge';

/** A member's private claims plus public-only claim activity on their found reports. */
@Component({
  selector: 'app-my-claims',
  imports: [
    RouterLink, StatusBadgeComponent, TimeAgoPipe, LoadingSpinnerComponent,
    EmptyStateComponent, ErrorStateComponent,
  ],
  templateUrl: './my-claims.html',
})
export class MyClaimsComponent implements OnInit {
  private readonly claims = inject(ClaimsService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly tab = signal<'mine' | 'received'>('mine');
  readonly mine = signal<ClaimWithRelations[]>([]);
  /** Safe public history only; private message/evidence/notes are never fetched here. */
  readonly received = signal<PublicClaimHistoryWithItem[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  readonly pendingCount = computed(() =>
    this.mine().filter((claim) => claim.status === 'pending' || claim.status === 'needs_info').length,
  );

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    await this.auth.whenReady();
    const profile = this.auth.profile();
    if (!profile) {
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    try {
      const [mine, received] = await Promise.all([
        this.claims.mine(profile.user_id),
        this.claims.received(profile.user_id),
      ]);
      this.mine.set(mine);
      this.received.set(received);
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load your claims.');
    } finally {
      this.loading.set(false);
    }
  }

  async withdraw(claim: ClaimWithRelations): Promise<void> {
    const answer = await this.confirm.confirm({
      title: 'Withdraw this claim?',
      message: 'The claim will be cancelled. You can submit a new one while the item is still available.',
      confirmLabel: 'Withdraw',
      danger: true,
    });
    if (!answer.confirmed) {
      return;
    }

    this.busyId.set(claim.id);
    try {
      await this.claims.cancel(claim.id);
      this.toast.info('Claim withdrawn.');
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not withdraw the claim.');
    } finally {
      this.busyId.set(null);
    }
  }
}
