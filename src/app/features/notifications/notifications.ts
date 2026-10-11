import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AppNotification } from '../../core/models/database.types';
import { AuthService } from '../../core/services/auth.service';
import { NotificationsService } from '../../core/services/notifications.service';
import { ToastService } from '../../core/services/toast.service';
import { TimeAgoPipe } from '../../shared/pipes/time-ago.pipe';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../shared/components/error-state/error-state';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';

/** In-app notification centre (spec §21). */
@Component({
  selector: 'app-notifications',
  imports: [RouterLink, TimeAgoPipe, LoadingSpinnerComponent, EmptyStateComponent, ErrorStateComponent],
  templateUrl: './notifications.html',
})
export class NotificationsComponent implements OnInit {
  private readonly notifications = inject(NotificationsService);
  private readonly toast = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly items = signal<AppNotification[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly onlyUnread = signal(false);
  readonly busy = signal(false);

  readonly unreadCount = computed(() => this.items().filter((item) => !item.is_read).length);
  readonly visible = computed(() =>
    this.onlyUnread() ? this.items().filter((item) => !item.is_read) : this.items(),
  );

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
      this.items.set(await this.notifications.list(profile.user_id, 100));
      await this.notifications.refreshUnread(profile.user_id);
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load notifications.');
    } finally {
      this.loading.set(false);
    }
  }

  async markRead(notification: AppNotification): Promise<void> {
    if (notification.is_read) {
      return;
    }
    try {
      await this.notifications.markRead(notification.id);
      this.items.update((list) =>
        list.map((row) => (row.id === notification.id ? { ...row, is_read: true } : row)),
      );
      this.notifications.decrementUnread();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not mark it as read.');
    }
  }

  async markAllRead(): Promise<void> {
    const profile = this.auth.profile();
    if (!profile) {
      return;
    }
    this.busy.set(true);
    try {
      await this.notifications.markAllRead(profile.user_id);
      this.items.update((list) => list.map((row) => ({ ...row, is_read: true })));
      await this.notifications.refreshUnread(profile.user_id);
      this.toast.success('All notifications marked as read.');
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not update notifications.');
    } finally {
      this.busy.set(false);
    }
  }

  async remove(notification: AppNotification): Promise<void> {
    try {
      await this.notifications.remove(notification.id);
      this.items.update((list) => list.filter((row) => row.id !== notification.id));
      if (!notification.is_read) {
        this.notifications.decrementUnread();
      }
      this.toast.info('Notification removed.');
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'Could not remove it.');
    }
  }

  iconFor(type: string): string {
    switch (type) {
      case 'match':
      case 'match_accepted':
        return 'bi-bullseye text-primary';
      case 'claim_submitted':
        return 'bi-clipboard-plus text-info';
      case 'claim_approved':
        return 'bi-patch-check text-success';
      case 'claim_rejected':
        return 'bi-x-circle text-danger';
      case 'claim_needs_info':
        return 'bi-question-circle text-warning';
      case 'claim_cancelled':
        return 'bi-slash-circle text-secondary';
      case 'report_verified':
        return 'bi-shield-check text-success';
      case 'report_rejected':
        return 'bi-shield-exclamation text-danger';
      case 'item_handed_over':
        return 'bi-check2-circle text-success';
      default:
        return 'bi-bell text-secondary';
    }
  }

  /** Notifications link somewhere useful — never a dead end. */
  linkFor(notification: AppNotification): unknown[] | null {
    if (notification.related_item_id) {
      // Item detail routes each user safely: claimant sees their private claim,
      // finder sees public history and the separate handover action.
      return ['/items', notification.related_item_id];
    }
    if (notification.related_claim_id) {
      return ['/my-claims'];
    }
    return null;
  }
}
