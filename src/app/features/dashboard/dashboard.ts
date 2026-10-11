import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type {
  AppNotification,
  ClaimWithRelations,
  ItemWithReporter,
  MatchWithItems,
} from '../../core/models/database.types';
import { AuthService } from '../../core/services/auth.service';
import { ClaimsService } from '../../core/services/claims.service';
import { ItemsService } from '../../core/services/items.service';
import { MatchingService } from '../../core/services/matching.service';
import { NotificationsService } from '../../core/services/notifications.service';
import { TimeAgoPipe } from '../../shared/pipes/time-ago.pipe';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../shared/components/error-state/error-state';
import { ItemCardComponent } from '../../shared/components/item-card/item-card';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { MatchScoreComponent } from '../../shared/components/match-score/match-score';
import { StatusBadgeComponent } from '../../shared/components/status-badge/status-badge';

/**
 * Student dashboard (spec §24): personal counts, latest matches, claims in
 * progress and unread notifications — all read live from the database.
 */
@Component({
  selector: 'app-dashboard',
  imports: [
    RouterLink, ItemCardComponent, MatchScoreComponent, StatusBadgeComponent, TimeAgoPipe,
    LoadingSpinnerComponent, EmptyStateComponent, ErrorStateComponent,
  ],
  templateUrl: './dashboard.html',
})
export class DashboardComponent implements OnInit {
  private readonly items = inject(ItemsService);
  private readonly matches = inject(MatchingService);
  private readonly claims = inject(ClaimsService);
  readonly notifications = inject(NotificationsService);
  readonly auth = inject(AuthService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly stats = signal<{ lost: number; found: number; active: number; returned: number; closed: number } | null>(null);
  readonly myItems = signal<ItemWithReporter[]>([]);
  readonly myMatches = signal<MatchWithItems[]>([]);
  readonly myClaims = signal<ClaimWithRelations[]>([]);
  readonly latestNotifications = signal<AppNotification[]>([]);

  readonly firstName = computed(() => (this.auth.profile()?.full_name ?? 'Campus member').split(' ')[0]);
  readonly pendingClaims = computed(() => this.myClaims().filter((claim) => claim.status === 'pending').length);
  readonly strongMatches = computed(() => this.myMatches().filter((match) => match.score >= 75).length);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const profile = this.auth.profile();
    if (!profile) {
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    try {
      const [stats, items, matches, claims, notifications] = await Promise.all([
        this.items.myStats(profile.user_id),
        this.items.search({ reportedBy: profile.user_id, sort: 'newest', pageSize: 6 }),
        this.matches.myMatches(profile.user_id),
        this.claims.mine(profile.user_id),
        this.notifications.list(profile.user_id, 5),
      ]);

      this.stats.set(stats);
      this.myItems.set(items.rows);
      this.myMatches.set(matches);
      this.myClaims.set(claims);
      this.latestNotifications.set(notifications);
      await this.notifications.refreshUnread(profile.user_id);
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load your dashboard.');
    } finally {
      this.loading.set(false);
    }
  }

  /** The other side of a match, as seen by this student. */
  otherItem(match: MatchWithItems): ItemWithReporter | null | undefined {
    const mine = match.lost_item?.reported_by === this.auth.profile()?.user_id ? 'lost' : 'found';
    return mine === 'lost' ? match.found_item : match.lost_item;
  }

  matchesFor(itemId: string): number {
    return this.myMatches().filter(
      (match) => match.lost_item_id === itemId || match.found_item_id === itemId,
    ).length;
  }

  refresh(): void {
    void this.load();
  }
}
