/**
 * Administrator operations: statistics, moderation of reports, user
 * management.
 *
 * Every method here relies on database-level authorisation — the RLS policies
 * and the `is_admin()` check inside the SQL functions.  Reaching this service
 * from a campus-member account simply produces "Administrator access required."
 */
import { Injectable, inject } from '@angular/core';
import type {
  AdminStats,
  CategoryStat,
  Item,
  ItemStatus,
  Profile,
  UserRole,
  VerificationStatus,
} from '../models/database.types';
import { SupabaseService } from './supabase.service';

@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly supabase = inject(SupabaseService);

  /* ------------------------------------------------------------------ */
  /* statistics (aggregated inside Postgres)                            */
  /* ------------------------------------------------------------------ */

  async stats(): Promise<AdminStats> {
    const { data, error } = await this.supabase.client.rpc('admin_stats');
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return data as AdminStats;
  }

  async categoryStats(): Promise<CategoryStat[]> {
    const { data, error } = await this.supabase.client.rpc('admin_category_stats');
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return (data ?? []) as CategoryStat[];
  }

  /* ------------------------------------------------------------------ */
  /* item moderation                                                    */
  /* ------------------------------------------------------------------ */

  /** Verify a report (marks it as checked by the university). */
  async setVerification(itemId: string, status: VerificationStatus): Promise<void> {
    const { error } = await this.supabase.client
      .from('items')
      .update({ verification_status: status })
      .eq('id', itemId);
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /** Change admin-moderatable status; returned is reserved for finder-confirmed handover. */
  async setStatus(itemId: string, status: Exclude<ItemStatus, 'returned'>): Promise<void> {
    const patch: Partial<Pick<Item, 'status' | 'resolved_at'>> = { status };
    patch.resolved_at = status === 'closed' ? new Date().toISOString() : null;

    const { error } = await this.supabase.client.from('items').update(patch).eq('id', itemId);
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /** Remove a listing from public view (soft delete, keeps the audit trail). */
  async rejectItem(itemId: string): Promise<void> {
    await this.setStatus(itemId, 'rejected');
  }

  /** Hard delete, used for spam or duplicated rows. */
  async deleteItem(itemId: string): Promise<void> {
    const { error } = await this.supabase.client.from('items').delete().eq('id', itemId);
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /* ------------------------------------------------------------------ */
  /* user management                                                    */
  /* ------------------------------------------------------------------ */

  async users(): Promise<Profile[]> {
    const { data, error } = await this.supabase.client
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false })
      .returns<Profile[]>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return data ?? [];
  }

  /** Administrator-only, audited role change; demotion restores campus_role. */
  async setRole(userId: string, role: UserRole, reason?: string): Promise<void> {
    const { error } = await this.supabase.client.rpc('set_profile_role', {
      p_user_id: userId,
      p_role: role,
      p_notes: reason?.trim() || null,
    });
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /** Per-user activity summary shown in the Manage Users table. */
  async userActivity(): Promise<Map<string, { items: number; claims: number }>> {
    const [{ data: items }, { data: claims }] = await Promise.all([
      this.supabase.client.from('items').select('reported_by').returns<Array<Pick<Item, 'reported_by'>>>(),
      this.supabase.client.from('claims').select('claimant_id').returns<Array<{ claimant_id: string }>>(),
    ]);

    const summary = new Map<string, { items: number; claims: number }>();
    for (const row of items ?? []) {
      const entry = summary.get(row.reported_by) ?? { items: 0, claims: 0 };
      entry.items += 1;
      summary.set(row.reported_by, entry);
    }
    for (const row of claims ?? []) {
      const entry = summary.get(row.claimant_id) ?? { items: 0, claims: 0 };
      entry.claims += 1;
      summary.set(row.claimant_id, entry);
    }
    return summary;
  }
}
