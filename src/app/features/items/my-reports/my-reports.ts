import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { ItemStatus, ItemType } from '../../../core/models/database.types';
import type { ItemWithReporter } from '../../../core/models/database.types';
import type { LoadState, Paginated } from '../../../core/models/common.model';
import { AuthService } from '../../../core/services/auth.service';
import { ConfirmService } from '../../../core/services/confirm.service';
import { ItemsService } from '../../../core/services/items.service';
import { ToastService } from '../../../core/services/toast.service';
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../../shared/components/error-state/error-state';
import { ItemCardComponent } from '../../../shared/components/item-card/item-card';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';

/** "My reports" — every listing the signed-in student created (spec §12). */
@Component({
  selector: 'app-my-reports',
  imports: [
    FormsModule, RouterLink, ItemCardComponent, LoadingSpinnerComponent,
    EmptyStateComponent, ErrorStateComponent, PaginationComponent,
  ],
  templateUrl: './my-reports.html',
})
export class MyReportsComponent implements OnInit {
  private readonly items = inject(ItemsService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly typeFilter = signal<ItemType | ''>('');
  readonly statusFilter = signal<ItemStatus | ''>('');
  readonly page = signal(1);
  readonly result = signal<Paginated<ItemWithReporter> | null>(null);
  readonly state = signal<LoadState>('idle');
  readonly error = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  readonly isEmpty = computed(() => this.state() === 'ready' && (this.result()?.total ?? 0) === 0);
  readonly hasFilters = computed(() => !!this.typeFilter() || !!this.statusFilter());

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const profile = this.auth.profile();
    if (!profile) {
      this.state.set('ready');
      return;
    }

    this.state.set('loading');
    this.error.set(null);
    try {
      this.result.set(
        await this.items.search({
          reportedBy: profile.user_id,
          type: this.typeFilter() || undefined,
          status: this.statusFilter() || undefined,
          sort: 'newest',
          page: this.page(),
          pageSize: 12,
          // the owner is allowed to see their own rejected reports
          hideRejected: false,
        }),
      );
      this.state.set('ready');
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load your reports.');
      this.state.set('error');
    }
  }

  changeType(value: string): void {
    this.typeFilter.set(value as ItemType | '');
    this.page.set(1);
    void this.load();
  }

  changeStatus(value: string): void {
    this.statusFilter.set(value as ItemStatus | '');
    this.page.set(1);
    void this.load();
  }

  changePage(page: number): void {
    this.page.set(page);
    void this.load();
  }

  clearFilters(): void {
    this.typeFilter.set('');
    this.statusFilter.set('');
    this.page.set(1);
    void this.load();
  }

  async closeItem(item: ItemWithReporter): Promise<void> {
    const answer = await this.confirm.confirm({
      title: 'Close this report?',
      message: `"${item.title}" will stay in your history but is removed from active matching.`,
      confirmLabel: 'Close report',
    });
    if (!answer.confirmed) {
      return;
    }
    await this.run(item.id, () => this.items.close(item.id), 'Report closed.');
  }

  async reopenItem(item: ItemWithReporter): Promise<void> {
    await this.run(item.id, () => this.items.reopen(item.id), 'Report reopened.');
  }

  async removeItem(item: ItemWithReporter): Promise<void> {
    const answer = await this.confirm.confirm({
      title: 'Delete this report?',
      message: `"${item.title}" and its photo will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!answer.confirmed) {
      return;
    }
    await this.run(item.id, () => this.items.remove(item.id), 'Report deleted.');
  }

  private async run(id: string, action: () => Promise<void>, successMessage: string): Promise<void> {
    this.busyId.set(id);
    try {
      await action();
      this.toast.success(successMessage);
      await this.load();
    } catch (caught) {
      this.toast.error(caught instanceof Error ? caught.message : 'The action failed.');
    } finally {
      this.busyId.set(null);
    }
  }
}
