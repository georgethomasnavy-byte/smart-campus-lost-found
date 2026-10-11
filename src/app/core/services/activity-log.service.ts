/**
 * Administrator-only audit trail.
 *
 * The `activity_logs` table is append-only: there is no UPDATE and no DELETE
 * policy for anybody, and the SELECT policy is restricted to admins.  Entries
 * are written by database triggers plus a small whitelist of self-service
 * events (login, profile update).
 */
import { Injectable, inject } from '@angular/core';
import type { ActivityLog, ActivityLogWithUser, PublicProfile } from '../models/database.types';
import { SupabaseService } from './supabase.service';

export interface ActivityLogFilters {
  action?: string;
  entityType?: string;
  userId?: string;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class ActivityLogService {
  private readonly supabase = inject(SupabaseService);

  async list(filters: ActivityLogFilters = {}): Promise<ActivityLogWithUser[]> {
    let query = this.supabase.client.from('activity_logs').select('*');

    if (filters.action) {
      query = query.eq('action', filters.action);
    }
    if (filters.entityType) {
      query = query.eq('entity_type', filters.entityType);
    }
    if (filters.userId) {
      query = query.eq('user_id', filters.userId);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(filters.limit ?? 200)
      .returns<ActivityLog[]>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return this.hydrate(data ?? []);
  }

  /** Distinct action names, used to populate the filter dropdown. */
  async actions(): Promise<string[]> {
    const { data, error } = await this.supabase.client
      .from('activity_logs')
      .select('action')
      .order('action')
      .limit(1000)
      .returns<Array<Pick<ActivityLog, 'action'>>>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return [...new Set((data ?? []).map((row) => row.action))];
  }

  private async hydrate(rows: ActivityLog[]): Promise<ActivityLogWithUser[]> {
    const ids = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => !!id))];
    if (ids.length === 0) {
      return rows;
    }

    const { data: people } = await this.supabase.client
      .from('profiles_public')
      .select('user_id, full_name, role, campus_role')
      .in('user_id', ids)
      .returns<PublicProfile[]>();

    const peopleById = new Map((people ?? []).map((profile) => [profile.user_id, profile]));
    return rows.map((row) => ({
      ...row,
      user: row.user_id ? (peopleById.get(row.user_id) ?? null) : null,
    }));
  }
}
