import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { environment } from '../../../../environments/environment';
import type { ItemCategory } from '../../../core/models/database.types';
import { ITEM_CATEGORIES } from '../../../core/models/database.types';
import type {
  ClaimWithRelations,
  ItemWithReporter,
  MatchWithItems,
  PublicClaimHistory,
} from '../../../core/models/database.types';
import { AuthService } from '../../../core/services/auth.service';
import { ClaimsService } from '../../../core/services/claims.service';
import { ConfirmService } from '../../../core/services/confirm.service';
import { ItemsService } from '../../../core/services/items.service';
import { MatchingService } from '../../../core/services/matching.service';
import { REPORT_REASONS, ReportsService } from '../../../core/services/reports.service';
import { ToastService } from '../../../core/services/toast.service';
import { DateLabelPipe } from '../../../shared/pipes/date-label.pipe';
import { TimeAgoPipe } from '../../../shared/pipes/time-ago.pipe';
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../../shared/components/error-state/error-state';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner';
import { MatchBreakdownComponent } from '../../../shared/components/match-breakdown/match-breakdown';
import { MatchScoreComponent } from '../../../shared/components/match-score/match-score';
import { StatusBadgeComponent } from '../../../shared/components/status-badge/status-badge';

/** Item details, safe public claim history, claim submission, and owner actions. */
@Component({
  selector: 'app-item-detail',
  imports: [
    FormsModule, RouterLink, DateLabelPipe, TimeAgoPipe, StatusBadgeComponent, MatchScoreComponent,
    MatchBreakdownComponent, LoadingSpinnerComponent, ErrorStateComponent, EmptyStateComponent,
  ],
  templateUrl: './item-detail.html',
})
export class ItemDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly items = inject(ItemsService);
  private readonly matches = inject(MatchingService);
  private readonly claims = inject(ClaimsService);
  private readonly reports = inject(ReportsService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  readonly auth = inject(AuthService);

  readonly categories = ITEM_CATEGORIES;
  readonly reasons = REPORT_REASONS;

  readonly item = signal<ItemWithReporter | null>(null);
  readonly relatedMatches = signal<MatchWithItems[]>([]);
  readonly itemClaims = signal<PublicClaimHistory[]>([]);
  /** Full claim details are loaded only for the claimant who owns this row. */
  readonly myClaim = signal<ClaimWithRelations | null>(null);
  readonly privateFoundLocation = signal<string | null>(null);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly notFound = signal(false);
  readonly openBreakdownFor = signal<string | null>(null);

  // Claim submission / response evidence. These values are never public.
  readonly claimMessage = signal('');
  readonly claimLocationAnswer = signal('');
  readonly claimBusy = signal(false);

  // Public report edit fields.
  readonly editing = signal(false);
  readonly editBusy = signal(false);
  readonly editTitle = signal('');
  readonly editCategory = signal<ItemCategory>('Other');
  readonly editDescription = signal('');
  readonly editLocation = signal('');
  readonly editDate = signal('');
  readonly editKeywords = signal('');
  readonly editCharacteristics = signal('');
  readonly editCollectionInstructions = signal('');

  // Finder-confirmed, database-backed physical handover.
  readonly handoverBusy = signal(false);

  // Abuse report form.
  readonly reportOpen = signal(false);
  readonly reportReason = signal<string>(REPORT_REASONS[0]);
  readonly reportDetails = signal('');
  readonly reportBusy = signal(false);

  readonly itemId = computed(() => this.route.snapshot.paramMap.get('id') ?? '');
  readonly isOwner = computed(() => {
    const current = this.item();
    const profile = this.auth.profile();
    return !!current && !!profile && current.reported_by === profile.user_id;
  });
  readonly canClaim = computed(() => {
    const current = this.item();
    const claim = this.myClaim();
    const claimClosed = !claim || claim.status === 'cancelled' || claim.status === 'rejected';
    return (
      this.auth.isLoggedIn() &&
      !!current &&
      !this.isOwner() &&
      !this.auth.isAdmin() &&
      current.type === 'found' &&
      (current.status === 'active' || current.status === 'matched' || current.status === 'claimed') &&
      claimClosed
    );
  });
  readonly canEdit = computed(() => this.isOwner() && this.auth.isLoggedIn());
  readonly canRespondToClaim = computed(() => this.myClaim()?.status === 'needs_info');
  readonly canConfirmHandover = computed(() => {
    const current = this.item();
    return !!current
      && this.isOwner()
      && current.type === 'found'
      && current.status === 'claimed'
      && current.handed_over_at === null
      && this.itemClaims().some((claim) => claim.status === 'approved');
  });
  readonly today = new Date().toISOString().slice(0, 10);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.notFound.set(false);

    try {
      await this.auth.whenReady();
      const item = await this.items.getById(this.itemId());
      if (!item) {
        this.notFound.set(true);
        return;
      }
      this.item.set(item);
      this.resetEditForm(item);

      const profile = this.auth.profile();
      const isFinder = !!profile && item.reported_by === profile.user_id;
      const [matchRows, publicClaims, ownClaim, exactLocation] = await Promise.all([
        this.matches.forItem(item.id),
        this.claims.forItem(item.id),
        profile ? this.claims.mineForItem(item.id, profile.user_id) : Promise.resolve(null),
        isFinder && item.type === 'found'
          ? this.items.getPrivateFoundLocation(item.id)
          : Promise.resolve(null),
      ]);
      this.relatedMatches.set(matchRows);
      this.itemClaims.set(publicClaims);
      this.myClaim.set(ownClaim);
      this.privateFoundLocation.set(exactLocation);
      if (ownClaim) {
        this.claimMessage.set(ownClaim.message);
        this.claimLocationAnswer.set(ownClaim.lost_location_answer);
      } else {
        this.claimMessage.set('');
        this.claimLocationAnswer.set('');
      }
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load this item.');
    } finally {
      this.loading.set(false);
    }
  }

  private resetEditForm(item: ItemWithReporter): void {
    this.editTitle.set(item.title);
    this.editCategory.set(item.category);
    this.editDescription.set(item.description);
    this.editLocation.set(item.location);
    this.editDate.set(item.date_occurred);
    this.editKeywords.set(item.keywords ?? '');
    this.editCharacteristics.set(item.identifying_characteristics ?? '');
    this.editCollectionInstructions.set(item.collection_instructions ?? '');
  }

  /* ------------------------------------------------------------------ */
  /* claims                                                             */
  /* ------------------------------------------------------------------ */

  async submitClaim(): Promise<void> {
    const profile = this.auth.profile();
    const current = this.item();
    if (!profile || !current) {
      return;
    }
    if (this.claimMessage().trim().length < 15) {
      this.toast.warning('Please describe the item and your proof of ownership (at least 15 characters).');
      return;
    }
    if (this.claimLocationAnswer().trim().length < 3) {
      this.toast.warning('Please enter where you believe you lost the item (at least 3 characters).');
      return;
    }

    this.claimBusy.set(true);
    try {
      await this.claims.submit(current.id, this.claimMessage(), this.claimLocationAnswer(), profile.user_id);
      this.toast.success('Claim submitted privately for administrator review.');
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not submit the claim.');
    } finally {
      this.claimBusy.set(false);
    }
  }

  async respondToClaim(): Promise<void> {
    const claim = this.myClaim();
    if (!claim) {
      return;
    }
    if (this.claimMessage().trim().length < 15 || this.claimLocationAnswer().trim().length < 3) {
      this.toast.warning('Provide an explanation (15+ characters) and your believed lost location (3+ characters).');
      return;
    }
    this.claimBusy.set(true);
    try {
      await this.claims.respond(claim.id, this.claimMessage(), this.claimLocationAnswer());
      this.toast.success('Your response was sent privately to the administrator queue.');
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not send your response.');
    } finally {
      this.claimBusy.set(false);
    }
  }

  async cancelClaim(): Promise<void> {
    const claim = this.myClaim();
    if (!claim) {
      return;
    }
    const answer = await this.confirm.confirm({
      title: 'Withdraw this claim?',
      message: 'The claim and its private evidence will remain in the audit history, but its status will become cancelled.',
      confirmLabel: 'Withdraw claim',
      danger: true,
    });
    if (!answer.confirmed) {
      return;
    }

    try {
      await this.claims.cancel(claim.id);
      this.toast.info('Claim withdrawn.');
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not withdraw the claim.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* finder actions                                                     */
  /* ------------------------------------------------------------------ */

  async confirmHandover(): Promise<void> {
    const current = this.item();
    if (!current || !this.canConfirmHandover() || this.handoverBusy()) {
      return;
    }
    const approvedClaim = this.itemClaims().find((claim) => claim.status === 'approved');
    const answer = await this.confirm.confirm({
      title: 'Confirm the item was handed over?',
      message:
        `Confirm only after you have physically given "${current.title}" to ` +
        `${approvedClaim?.claimant_name ?? 'the approved claimant'}. The system will record your account and the time, mark the item returned, and notify relevant users.`,
      confirmLabel: 'Handed over',
    });
    if (!answer.confirmed) {
      return;
    }

    this.handoverBusy.set(true);
    try {
      await this.items.confirmHandover(current.id);
      this.toast.success('Handover recorded. The item is now returned and the claimant was notified.');
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'The handover could not be recorded.');
    } finally {
      this.handoverBusy.set(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* owner report actions                                               */
  /* ------------------------------------------------------------------ */

  async saveEdit(): Promise<void> {
    const current = this.item();
    if (!current) {
      return;
    }
    if (this.editTitle().trim().length < 3 || this.editDescription().trim().length < 10) {
      this.toast.warning('A title (3+ characters) and a description (10+ characters) are required.');
      return;
    }
    if (this.editKeywords().trim().length > 250 || this.editCharacteristics().trim().length > 500) {
      this.toast.warning('Keywords must be 250 characters or fewer and characteristics 500 or fewer.');
      return;
    }
    if (current.type === 'found' && this.editCollectionInstructions().trim().length > 0
        && this.editCollectionInstructions().trim().length < 10) {
      this.toast.warning('Collection instructions must contain at least 10 characters.');
      return;
    }

    this.editBusy.set(true);
    try {
      const updated = await this.items.update(current.id, {
        title: this.editTitle().trim(),
        category: this.editCategory(),
        description: this.editDescription().trim(),
        location: this.editLocation().trim(),
        date_occurred: this.editDate(),
        keywords: this.editKeywords().trim(),
        identifying_characteristics: this.editCharacteristics().trim(),
        collection_instructions: current.type === 'found'
          ? this.editCollectionInstructions().trim() || null
          : null,
      });
      this.editing.set(false);
      this.toast.success('Report details saved.');
      try {
        const candidates = await this.matches.runForItem(updated);
        this.toast.info(candidates.length
          ? `${candidates.length} possible match(es) after re-scoring.`
          : 'No new match was stored; any previous pair remains deduplicated.');
      } catch (caught) {
        this.toast.warning(`Report saved, but matching could not be stored: ${caught instanceof Error ? caught.message : 'matching failed'}`);
      }
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not save the report.');
    } finally {
      this.editBusy.set(false);
    }
  }

  async closeItem(): Promise<void> {
    const current = this.item();
    if (!current) {
      return;
    }
    const answer = await this.confirm.confirm({
      title: 'Close this report?',
      message: 'Closing keeps the record but removes it from active matching. You can reopen it later.',
      confirmLabel: 'Close report',
    });
    if (!answer.confirmed) {
      return;
    }
    try {
      await this.items.close(current.id);
      this.toast.info('Report closed.');
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not close the report.');
    }
  }

  async reopenItem(): Promise<void> {
    const current = this.item();
    if (!current) {
      return;
    }
    try {
      await this.items.reopen(current.id);
      const updated = await this.items.getById(current.id);
      if (updated) {
        try {
          await this.matches.runForItem(updated);
        } catch (caught) {
          this.toast.warning(`Report reopened, but matching could not be stored: ${caught instanceof Error ? caught.message : 'matching failed'}`);
        }
      }
      this.toast.success('Report reopened.');
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not reopen the report.');
    }
  }

  async removeItem(): Promise<void> {
    const current = this.item();
    if (!current) {
      return;
    }
    const answer = await this.confirm.confirm({
      title: 'Delete this report?',
      message: 'The report and its related claims are permanently removed. This cannot be undone.',
      confirmLabel: 'Delete report',
      danger: true,
    });
    if (!answer.confirmed) {
      return;
    }
    try {
      await this.items.remove(current.id);
      this.toast.success('Report deleted.');
      await this.router.navigate(['/my-reports']);
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not delete the report.');
    }
  }

  /* ------------------------------------------------------------------ */
  /* matches                                                            */
  /* ------------------------------------------------------------------ */

  async setMatchStatus(match: MatchWithItems, status: 'accepted' | 'dismissed'): Promise<void> {
    try {
      await this.matches.setStatus(match.id, status);
      this.toast.success(status === 'accepted' ? 'Match accepted.' : 'Match dismissed.');
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not update the match.');
    }
  }

  toggleBreakdown(matchId: string): void {
    this.openBreakdownFor.set(this.openBreakdownFor() === matchId ? null : matchId);
  }

  /* ------------------------------------------------------------------ */
  /* abuse report                                                       */
  /* ------------------------------------------------------------------ */

  async submitReport(): Promise<void> {
    const profile = this.auth.profile();
    const current = this.item();
    if (!profile || !current) {
      return;
    }
    this.reportBusy.set(true);
    try {
      await this.reports.submit({
        itemId: current.id,
        reason: this.reportReason(),
        description: this.reportDetails(),
        reportedBy: profile.user_id,
      });
      this.reportOpen.set(false);
      this.reportDetails.set('');
      this.toast.success('Thank you — an administrator will review this listing.');
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not send the report.');
    } finally {
      this.reportBusy.set(false);
    }
  }

  /** Display name for the other side of a match. */
  matchOtherTitle(match: MatchWithItems): string {
    const other = this.item()?.type === 'lost' ? match.found_item : match.lost_item;
    return other?.title ?? 'Unknown item';
  }

  matchOtherId(match: MatchWithItems): string {
    const other = this.item()?.type === 'lost' ? match.found_item : match.lost_item;
    return other?.id ?? '';
  }

  matchOtherImage(match: MatchWithItems): string | null {
    const other = this.item()?.type === 'lost' ? match.found_item : match.lost_item;
    return other?.image_url ?? null;
  }

  breakdownFor(match: MatchWithItems) {
    return (match.matching_details?.breakdown ?? []).map((row) => ({
      key: row.key as 'category' | 'title' | 'description' | 'location' | 'date',
      label: row.label,
      points: row.points,
      maxPoints: row.maxPoints,
      explanation: row.explanation,
    }));
  }

  readonly appName = environment.appName;
}
