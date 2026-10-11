/**
 * In-app notifications (no paid e-mail or SMS is used anywhere).
 *
 * Rows are created by database triggers when something meaningful happens to
 * a user: a possible match, a claim decision, a verification, a status change.
 * A campus member can read their own feed and flip `is_read` — nothing else, which
 * the RLS policy and `guard_notification_update` trigger enforce.
 */
import { Injectable, inject, signal } from '@angular/core';
import type { AppNotification } from '../models/database.types';
import { SupabaseService } from './supabase.service';

@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly supabase = inject(SupabaseService);

  /** Unread count shared by the navbar badge and the notifications page. */
  private readonly unreadSignal = signal(0);
  readonly unread = this.unreadSignal.asReadonly();

  /** Re-read the badge count; silently resets when nobody is signed in. */
  async refreshUnread(userId: string | null | undefined): Promise<void> {
    if (!userId) {
      this.unreadSignal.set(0);
      return;
    }
    try {
      this.unreadSignal.set(await this.unreadCount(userId));
    } catch {
      this.unreadSignal.set(0);
    }
  }

  /** Optimistic local update after "mark as read", so the badge reacts instantly. */
  decrementUnread(by = 1): void {
    this.unreadSignal.update((value) => Math.max(0, value - by));
  }

  /** Newest first, capped so a long-lived account cannot slow the page down. */
  async list(userId: string, limit = 50): Promise<AppNotification[]> {
    const { data, error } = await this.supabase.client
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<AppNotification[]>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return data ?? [];
  }

  /** Unread badge count — a single indexed query, not a full download. */
  async unreadCount(userId: string): Promise<number> {
    const { count, error } = await this.supabase.client
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    return count ?? 0;
  }

  async markRead(notificationId: string): Promise<void> {
    const { error } = await this.supabase.client
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notificationId);
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  async markAllRead(userId: string): Promise<void> {
    const { error } = await this.supabase.client
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  async remove(notificationId: string): Promise<void> {
    const { error } = await this.supabase.client
      .from('notifications')
      .delete()
      .eq('id', notificationId);
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }
}
