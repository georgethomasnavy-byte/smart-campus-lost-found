import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { MatchWithItems } from '../../core/models/database.types';
import { AuthService } from '../../core/services/auth.service';
import { MatchingService } from '../../core/services/matching.service';
import { ToastService } from '../../core/services/toast.service';
import { levelLabel, scoreToLevel } from '../../core/matching/matching.engine';
import { TimeAgoPipe } from '../../shared/pipes/time-ago.pipe';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../shared/components/error-state/error-state';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';
import { MatchBreakdownComponent } from '../../shared/components/match-breakdown/match-breakdown';
import { MatchScoreComponent } from '../../shared/components/match-score/match-score';
import { StatusBadgeComponent } from '../../shared/components/status-badge/status-badge';

type MatchFilter = 'all' | 'strong' | 'possible' | 'low' | 'dismissed';

/**
 * "Possible matches" page (spec §20) — the student-facing view of everything
 * the deterministic engine produced for their own reports.
 */
@Component({
  selector: 'app-matches',
  imports: [
    FormsModule, RouterLink, MatchScoreComponent, MatchBreakdownComponent, StatusBadgeComponent,
    TimeAgoPipe, LoadingSpinnerComponent, EmptyStateComponent, ErrorStateComponent,
  ],
  templateUrl: './matches.html',
})
export class MatchesComponent implements OnInit {
  private readonly matching = inject(MatchingService);
  private readonly toast = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly filter = signal<MatchFilter>('all');
  readonly items = signal<MatchWithItems[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly openBreakdownFor = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  readonly counts = computed(() => {
    const rows = this.items();
    return {
      all: rows.filter((row) => row.status !== 'dismissed').length,
      strong: rows.filter((row) => row.score >= 75 && row.status !== 'dismissed').length,
      possible: rows.filter((row) => row.score >= 60 && row.score < 75 && row.status !== 'dismissed').length,
      low: rows.filter((row) => row.score < 60 && row.status !== 'dismissed').length,
      dismissed: rows.filter((row) => row.status === 'dismissed').length,
    };
  });

  readonly visible = computed(() => {
    const rows = this.items();
    switch (this.filter()) {
      case 'strong':
        return rows.filter((row) => row.score >= 75 && row.status !== 'dismissed');
      case 'possible':
        return rows.filter((row) => row.score >= 60 && row.score < 75 && row.status !== 'dismissed');
      case 'low':
        return rows.filter((row) => row.score < 60 && row.status !== 'dismissed');
      case 'dismissed':
        return rows.filter((row) => row.status === 'dismissed');
      default:
        return rows.filter((row) => row.status !== 'dismissed');
    }
  });

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
      this.items.set(await this.matching.myMatches(profile.user_id));
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load your matches.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Which of the two items belongs to the signed-in student. */
  myItem(match: MatchWithItems) {
    const userId = this.auth.profile()?.user_id;
    return match.lost_item?.reported_by === userId ? match.lost_item : match.found_item;
  }

  otherItem(match: MatchWithItems) {
    const userId = this.auth.profile()?.user_id;
    return match.lost_item?.reported_by === userId ? match.found_item : match.lost_item;
  }

  toggleBreakdown(matchId: string): void {
    this.openBreakdownFor.set(this.openBreakdownFor() === matchId ? null : matchId);
  }

  async setStatus(match: MatchWithItems, status: 'accepted' | 'dismissed'): Promise<void> {
    this.busyId.set(match.id);
    try {
      await this.matching.setStatus(match.id, status);
      this.toast.success(
        status === 'accepted'
          ? 'Match accepted — open the other report to claim or contact the reporter.'
          : 'Match dismissed. It is hidden from your list.',
      );
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not update the match.');
    } finally {
      this.busyId.set(null);
    }
  }

  breakdown(match: MatchWithItems) {
    return (match.matching_details?.breakdown ?? []).map((row) => ({
      key: row.key as 'category' | 'title' | 'description' | 'location' | 'date',
      label: row.label,
      points: row.points,
      maxPoints: row.maxPoints,
      explanation: row.explanation,
    }));
  }

  levelText(score: number): string {
    return levelLabel(scoreToLevel(score));
  }

  suggestedAction(match: MatchWithItems): string {
    const mine = this.myItem(match);
    if (mine?.type === 'lost') {
      return 'If this is your item, open the found report and submit a claim describing it.';
    }
    return 'Someone may have lost this item. Open their lost report and check the details.';
  }
}
