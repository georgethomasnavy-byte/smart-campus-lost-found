/**
 * Runs the rule-based matching engine and stores its results.
 *
 * Flow when a report is created (spec §15/§16):
 *   1. load open reports of the OPPOSITE type  (server-side query, capped)
 *   2. score each pair with the pure engine in core/matching
 *   3. persist the worthwhile pairs in `matches` (duplicate-safe)
 *   4. the database trigger notifies both parties when the score reaches the
 *      notification threshold, and logs each newly inserted match
 *
 * The engine itself is deterministic and AI-free; this service only moves
 * data in and out of Postgres.
 */
import { Injectable, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import type { Item, Match, MatchWithItems } from '../models/database.types';
import type { ItemSummary, MatchCandidate } from '../models/common.model';
import {
  MATCH_CANDIDATE_LIMIT,
  MIN_MATCH_SCORE,
} from '../matching/matching.config';
import { buildMatchDetails, findMatches } from '../matching/matching.engine';
import { ItemsService } from './items.service';
import { SupabaseService } from './supabase.service';

@Injectable({ providedIn: 'root' })
export class MatchingService {
  private readonly supabase = inject(SupabaseService);
  private readonly items = inject(ItemsService);

  /** Never compare against reports that are finished with. */
  private readonly closedStatuses = ['returned', 'rejected', 'closed'] as const;

  /* ------------------------------------------------------------------ */
  /* running the engine                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Score a freshly created report against the opposite pool and return the
   * candidates that scored well enough to be worth showing.
   */
  async findCandidatesFor(item: ItemSummary): Promise<MatchCandidate[]> {
    const oppositeType = item.type === 'lost' ? 'found' : 'lost';

    const { data, error } = await this.supabase.client
      .from('items')
      .select('id,type,title,category,description,location,date_occurred,keywords,identifying_characteristics,status')
      .eq('type', oppositeType)
      .not('status', 'in', `(${this.closedStatuses.join(',')})`)
      .neq('id', item.id)
      .order('created_at', { ascending: false })
      .limit(MATCH_CANDIDATE_LIMIT)
      .returns<ItemSummary[]>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }

    return findMatches(item, data ?? [], MIN_MATCH_SCORE);
  }

  /**
   * Score and PERSIST the matches for a report.  Safe to call twice: the
   * unique constraint on (lost_item_id, found_item_id) plus
   * `ignoreDuplicates` means a pair can never be stored twice.
   */
  async runForItem(item: ItemSummary): Promise<Match[]> {
    const candidates = await this.findCandidatesFor(item);
    if (candidates.length === 0) {
      return [];
    }

    const rows = candidates.map((candidate) => {
      const lost = item.type === 'lost' ? item : candidate.item;
      const found = item.type === 'found' ? item : candidate.item;
      return {
        lost_item_id: lost.id,
        found_item_id: found.id,
        score: candidate.score,
        matching_details: buildMatchDetails(candidate.score, candidate.level, candidate.breakdown),
        status: 'suggested' as const,
      };
    });

    const { data, error } = await this.supabase.client
      .from('matches')
      .upsert(rows, { onConflict: 'lost_item_id,found_item_id', ignoreDuplicates: true })
      .select('*')
      .returns<Match[]>();

    if (error) {
      // The caller keeps the already-saved report and shows an honest matching
      // failure state; do not turn a persistence/notification failure into
      // "no matches" or claim that users were notified.
      throw new Error(SupabaseService.message(error));
    }
    return data ?? [];
  }

  /* ------------------------------------------------------------------ */
  /* reading matches                                                    */
  /* ------------------------------------------------------------------ */

  /** Every suggested/accepted match that involves one of the user's items. */
  async myMatches(userId: string): Promise<MatchWithItems[]> {
    const { data: mine, error: mineError } = await this.supabase.client
      .from('items')
      .select('id')
      .eq('reported_by', userId)
      .returns<Array<Pick<Item, 'id'>>>();

    if (mineError) {
      throw new Error(SupabaseService.message(mineError));
    }

    const ids = (mine ?? []).map((row) => row.id);
    if (ids.length === 0) {
      return [];
    }

    const { data, error } = await this.supabase.client
      .from('matches')
      .select('*')
      .or(`lost_item_id.in.(${ids.join(',')}),found_item_id.in.(${ids.join(',')})`)
      .order('score', { ascending: false })
      .returns<Match[]>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }

    return this.hydrate(data ?? []);
  }

  /** Matches for one specific report (shown on the item detail page). */
  async forItem(itemId: string): Promise<MatchWithItems[]> {
    const { data, error } = await this.supabase.client
      .from('matches')
      .select('*')
      .or(`lost_item_id.eq.${itemId},found_item_id.eq.${itemId}`)
      .order('score', { ascending: false })
      .returns<Match[]>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return this.hydrate(data ?? []);
  }

  /** Admin view: every match in the system, strongest first. */
  async all(limit = 100): Promise<MatchWithItems[]> {
    const { data, error } = await this.supabase.client
      .from('matches')
      .select('*')
      .order('score', { ascending: false })
      .limit(limit)
      .returns<Match[]>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return this.hydrate(data ?? []);
  }

  async count(): Promise<{ total: number; suggested: number; strong: number }> {
    const { data, error } = await this.supabase.client
      .from('matches')
      .select('score,status')
      .returns<Array<Pick<Match, 'score' | 'status'>>>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    const rows = data ?? [];
    return {
      total: rows.length,
      suggested: rows.filter((row) => row.status === 'suggested').length,
      strong: rows.filter((row) => row.score >= 75).length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* accepting / dismissing                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Mark a match as accepted or dismissed.
   * The database guard allows this for the people involved while keeping the
   * score itself immutable.
   */
  async setStatus(matchId: string, status: 'suggested' | 'accepted' | 'dismissed'): Promise<void> {
    const { error } = await this.supabase.client
      .from('matches')
      .update({ status })
      .eq('id', matchId);

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /** Kept for symmetry with the UI copy. */
  get minimumScore(): number {
    return MIN_MATCH_SCORE;
  }

  /* ------------------------------------------------------------------ */

  private async hydrate(rows: Match[]): Promise<MatchWithItems[]> {
    const ids = [
      ...new Set(rows.flatMap((row) => [row.lost_item_id, row.found_item_id])),
    ];
    const itemsById = await this.items.getManyByIds(ids);

    return rows
      .map((row) => ({
        ...row,
        lost_item: itemsById.get(row.lost_item_id) ?? null,
        found_item: itemsById.get(row.found_item_id) ?? null,
      }))
      .filter((row) => row.lost_item !== null && row.found_item !== null);
  }

  /** Exposed for the UI so a "no matches yet" message can explain the bar. */
  get config() {
    return {
      minScore: MIN_MATCH_SCORE,
      pageSize: environment.pageSize,
    };
  }
}
