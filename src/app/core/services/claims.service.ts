/**
 * Secure claim workflow.
 *
 * Claimant/admin-only evidence stays in the claims table. Public item pages and
 * the finder dashboard use the deliberately limited claim_history view, which
 * contains only claimant name, campus role, date and current status.
 */
import { Injectable, inject } from '@angular/core';
import type {
  Claim,
  ClaimReviewDecision,
  ClaimReviewEvent,
  ClaimStatus,
  ClaimWithRelations,
  Item,
  ItemWithReporter,
  PublicClaimHistory,
  PublicProfile,
} from '../models/database.types';
import { locationEvidenceSimilarity } from './claim-verification';
import { ItemsService } from './items.service';
import { SupabaseService } from './supabase.service';

export type PublicClaimHistoryWithItem = PublicClaimHistory & {
  item?: ItemWithReporter | null;
};

@Injectable({ providedIn: 'root' })
export class ClaimsService {
  private readonly supabase = inject(SupabaseService);
  private readonly items = inject(ItemsService);

  /* ------------------------------------------------------------------ */
  /* campus-member flows                                                */
  /* ------------------------------------------------------------------ */

  /** Raise a claim on somebody else's found item. Evidence is private. */
  async submit(
    itemId: string,
    message: string,
    lostLocationAnswer: string,
    claimantId: string,
  ): Promise<Claim> {
    const { data, error } = await this.supabase.client
      .from('claims')
      .insert({
        item_id: itemId,
        claimant_id: claimantId,
        message: message.trim(),
        lost_location_answer: lostLocationAnswer.trim(),
        status: 'pending',
        admin_notes: null,
        reviewed_by: null,
        reviewed_at: null,
      })
      .select('*')
      .single<Claim>();

    if (error) {
      throw new Error(this.readable(error, message, lostLocationAnswer));
    }
    return data;
  }

  /** Claims submitted by the signed-in member, newest first. */
  async mine(userId: string): Promise<ClaimWithRelations[]> {
    const { data, error } = await this.supabase.client
      .from('claims')
      .select('*')
      .eq('claimant_id', userId)
      .order('created_at', { ascending: false })
      .returns<Claim[]>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return this.hydrate(data ?? []);
  }

  /** Most recent private claim by this user for the item, if any. */
  async mineForItem(itemId: string, userId: string): Promise<ClaimWithRelations | null> {
    const { data, error } = await this.supabase.client
      .from('claims')
      .select('*')
      .eq('item_id', itemId)
      .eq('claimant_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<Claim>();
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    if (!data) {
      return null;
    }
    return (await this.hydrate([data]))[0] ?? null;
  }

  /** Safe public claim history for an item; never selects the claims table. */
  async forItem(itemId: string): Promise<PublicClaimHistory[]> {
    const { data, error } = await this.supabase.client
      .from('claim_history')
      .select('id,item_id,claimant_name,campus_role,claim_date,status')
      .eq('item_id', itemId)
      .order('claim_date', { ascending: false })
      .returns<PublicClaimHistory[]>();
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return data ?? [];
  }

  /** Safe history for claims on items reported by the signed-in finder. */
  async received(userId: string): Promise<PublicClaimHistoryWithItem[]> {
    const { data: mine, error } = await this.supabase.client
      .from('items')
      .select('id')
      .eq('reported_by', userId)
      .returns<Array<Pick<Item, 'id'>>>();
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    const itemIds = (mine ?? []).map((row) => row.id);
    if (!itemIds.length) {
      return [];
    }

    const { data, error: historyError } = await this.supabase.client
      .from('claim_history')
      .select('id,item_id,claimant_name,campus_role,claim_date,status')
      .in('item_id', itemIds)
      .order('claim_date', { ascending: false })
      .returns<PublicClaimHistory[]>();
    if (historyError) {
      throw new Error(SupabaseService.message(historyError));
    }

    const itemById = await this.items.getManyByIds([...new Set((data ?? []).map((row) => row.item_id))]);
    return (data ?? []).map((row) => ({ ...row, item: itemById.get(row.item_id) ?? null }));
  }

  /** Claimant cancellation uses a trusted function and cannot alter evidence. */
  async cancel(claimId: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('cancel_claim', { p_claim_id: claimId });
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /** Answer an administrator's request for more information. */
  async respond(claimId: string, message: string, lostLocationAnswer: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('respond_to_claim_request', {
      p_claim_id: claimId,
      p_message: message.trim(),
      p_lost_location_answer: lostLocationAnswer.trim(),
    });
    if (error) {
      throw new Error(this.readable(error, message, lostLocationAnswer));
    }
  }

  /* ------------------------------------------------------------------ */
  /* administrator workflows                                           */
  /* ------------------------------------------------------------------ */

  /** Private verification queue; includes both location answers and audit history. */
  async queue(status?: ClaimStatus): Promise<ClaimWithRelations[]> {
    let query = this.supabase.client.from('claims').select('*');
    if (status) {
      query = query.eq('status', status);
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .returns<Claim[]>();
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return this.hydrate(data ?? [], true);
  }

  async counts(): Promise<Record<ClaimStatus | 'total', number>> {
    const { data, error } = await this.supabase.client
      .from('claims')
      .select('status')
      .returns<Array<Pick<Claim, 'status'>>>();
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    const rows = data ?? [];
    return {
      total: rows.length,
      pending: rows.filter((row) => row.status === 'pending').length,
      needs_info: rows.filter((row) => row.status === 'needs_info').length,
      approved: rows.filter((row) => row.status === 'approved').length,
      rejected: rows.filter((row) => row.status === 'rejected').length,
      cancelled: rows.filter((row) => row.status === 'cancelled').length,
    };
  }

  /** Atomic admin decision. The database derives reviewer identity from auth.uid(). */
  async review(
    claimId: string,
    decision: ClaimReviewDecision,
    notes?: string | null,
  ): Promise<void> {
    const { error } = await this.supabase.client.rpc('review_claim', {
      p_claim_id: claimId,
      p_decision: decision,
      p_notes: notes?.trim() || null,
    });
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /* ------------------------------------------------------------------ */

  private readable(error: unknown, message: string, locationAnswer: string): string {
    const raw = (error as { message?: string })?.message ?? '';
    if (/uq_claim_active_per_user_item|duplicate key/i.test(raw)) {
      return 'You already have an active claim for this item.';
    }
    if (/lost_location_answer|believed lost location/i.test(raw) || locationAnswer.trim().length < 3) {
      return 'Enter where you believe you lost the item (at least 3 characters).';
    }
    if (/char_length|too short|at least/i.test(raw) || message.trim().length < 15) {
      return 'Please describe the item and your proof of ownership (at least 15 characters).';
    }
    if (/row-level security|not allowed/i.test(raw)) {
      return 'This item cannot be claimed right now (it may already be returned or belong to you).';
    }
    return SupabaseService.message(error);
  }

  /** Hydrate private claim rows; include exact-location evidence only for admins. */
  private async hydrate(rows: Claim[], includeAdminEvidence = false): Promise<ClaimWithRelations[]> {
    if (rows.length === 0) {
      return [];
    }

    const itemIds = [...new Set(rows.map((row) => row.item_id))];
    const itemsById = await this.items.getManyByIds(itemIds);
    const peopleIds = new Set<string>();
    for (const row of rows) {
      peopleIds.add(row.claimant_id);
      if (row.reviewed_by) {
        peopleIds.add(row.reviewed_by);
      }
    }

    let privateLocations = new Map<string, string>();
    let reviewEvents: ClaimReviewEvent[] = [];
    if (includeAdminEvidence) {
      const [{ data: locations, error: locationError }, { data: events, error: historyError }] = await Promise.all([
        this.supabase.client
          .from('item_private_details')
          .select('item_id,exact_found_location')
          .in('item_id', itemIds)
          .returns<Array<{ item_id: string; exact_found_location: string }>>(),
        this.supabase.client
          .from('claim_review_history')
          .select('id,claim_id,item_id,reviewed_by,from_status,to_status,notes,created_at')
          .in('claim_id', rows.map((row) => row.id))
          .order('created_at', { ascending: false })
          .returns<ClaimReviewEvent[]>(),
      ]);
      if (locationError) {
        throw new Error(`Could not load private verification evidence: ${SupabaseService.message(locationError)}`);
      }
      if (historyError) {
        throw new Error(`Could not load claim review history: ${SupabaseService.message(historyError)}`);
      }
      privateLocations = new Map((locations ?? []).map((row) => [row.item_id, row.exact_found_location]));
      reviewEvents = events ?? [];
      for (const event of reviewEvents) {
        if (event.reviewed_by) {
          peopleIds.add(event.reviewed_by);
        }
      }
    }

    const { data: people, error: peopleError } = await this.supabase.client
      .from('profiles_public')
      .select('user_id,full_name,role,campus_role')
      .in('user_id', [...peopleIds])
      .returns<PublicProfile[]>();
    if (peopleError) {
      throw new Error(SupabaseService.message(peopleError));
    }
    const peopleById = new Map((people ?? []).map((profile) => [profile.user_id, profile]));
    const historyByClaim = new Map<string, ClaimReviewEvent[]>();
    for (const event of reviewEvents) {
      const current = historyByClaim.get(event.claim_id) ?? [];
      current.push({ ...event, reviewer: event.reviewed_by ? peopleById.get(event.reviewed_by) ?? null : null });
      historyByClaim.set(event.claim_id, current);
    }

    return rows.map((row) => {
      const exactFoundLocation = privateLocations.get(row.item_id) ?? null;
      return {
        ...row,
        item: itemsById.get(row.item_id) ?? null,
        claimant: peopleById.get(row.claimant_id) ?? null,
        reviewer: row.reviewed_by ? peopleById.get(row.reviewed_by) ?? null : null,
        ...(includeAdminEvidence ? {
          verification_evidence: {
            exact_found_location: exactFoundLocation,
            lost_location_answer: row.lost_location_answer,
            location_similarity: exactFoundLocation
              ? locationEvidenceSimilarity(row.lost_location_answer, exactFoundLocation)
              : 0,
          },
          review_history: historyByClaim.get(row.id) ?? [],
        } : {}),
      };
    });
  }
}
