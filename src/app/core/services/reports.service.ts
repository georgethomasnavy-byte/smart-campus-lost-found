/**
 * Abuse / problem reports ("this listing looks fraudulent").
 *
 * Any signed-in student can report somebody else's listing; only
 * administrators can see the queue or resolve entries.
 */
import { Injectable, inject } from '@angular/core';
import type {
  AbuseReport,
  AbuseReportStatus,
  AbuseReportWithRelations,
  PublicProfile,
} from '../models/database.types';
import { ItemsService } from './items.service';
import { SupabaseService } from './supabase.service';

/** Reasons offered in the UI; the database only requires free text. */
export const REPORT_REASONS = [
  'Fraudulent listing',
  'Duplicate report',
  'Wrong category',
  'Already returned / resolved',
  'Offensive content',
  'Other',
] as const;

@Injectable({ providedIn: 'root' })
export class ReportsService {
  private readonly supabase = inject(SupabaseService);
  private readonly items = inject(ItemsService);

  async submit(input: {
    itemId: string;
    reason: string;
    description?: string | null;
    reportedBy: string;
  }): Promise<AbuseReport> {
    const { data, error } = await this.supabase.client
      .from('reports')
      .insert({
        item_id: input.itemId,
        reported_by: input.reportedBy,
        reason: input.reason.trim(),
        description: input.description?.trim() || null,
        status: 'pending',
      })
      .select('*')
      .single<AbuseReport>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return data;
  }

  async mine(userId: string): Promise<AbuseReportWithRelations[]> {
    const { data, error } = await this.supabase.client
      .from('reports')
      .select('*')
      .eq('reported_by', userId)
      .order('created_at', { ascending: false })
      .returns<AbuseReport[]>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return this.hydrate(data ?? []);
  }

  /** Administrator queue. */
  async queue(status?: AbuseReportStatus): Promise<AbuseReportWithRelations[]> {
    let query = this.supabase.client.from('reports').select('*');
    if (status) {
      query = query.eq('status', status);
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .returns<AbuseReport[]>();
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return this.hydrate(data ?? []);
  }

  async review(
    reportId: string,
    status: Exclude<AbuseReportStatus, 'pending'>,
    reviewerId: string
  ): Promise<void> {
    const { error } = await this.supabase.client
      .from('reports')
      .update({ status, reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
      .eq('id', reportId);

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  async openCount(): Promise<number> {
    const { count, error } = await this.supabase.client
      .from('reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return count ?? 0;
  }

  private async hydrate(rows: AbuseReport[]): Promise<AbuseReportWithRelations[]> {
    if (rows.length === 0) {
      return [];
    }

    const itemsById = await this.items.getManyByIds([...new Set(rows.map((row) => row.item_id))]);

    const { data: people } = await this.supabase.client
      .from('profiles_public')
      .select('user_id, full_name, role, campus_role')
      .in('user_id', [...new Set(rows.map((row) => row.reported_by))])
      .returns<PublicProfile[]>();

    const peopleById = new Map((people ?? []).map((profile) => [profile.user_id, profile]));

    return rows.map((row) => ({
      ...row,
      item: itemsById.get(row.item_id) ?? null,
      reporter: peopleById.get(row.reported_by) ?? null,
    }));
  }
}
