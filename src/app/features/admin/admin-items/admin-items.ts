import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type {
  ItemCategory,
  ItemStatus,
  ItemType,
  ItemWithReporter,
  VerificationStatus,
} from '../../../core/models/database.types';
import { ITEM_CATEGORIES } from '../../../core/models/database.types';
import type { Paginated } from '../../../core/models/common.model';
import { AdminService } from '../../../core/services/admin.service';
import { ConfirmService } from '../../../core/services/confirm.service';
import { ItemsService } from '../../../core/services/items.service';
import { ToastService } from '../../../core/services/toast.service';
import { DateLabelPipe } from '../../../shared/pipes/date-label.pipe';
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../../shared/components/error-state/error-state';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';
import { StatusBadgeComponent } from '../../../shared/components/status-badge/status-badge';

/** Item moderation: verify, reject, close/reopen and remove reports. */
@Component({
  selector: 'app-admin-items',
  imports: [
    FormsModule, RouterLink, StatusBadgeComponent, DateLabelPipe, LoadingSpinnerComponent,
    EmptyStateComponent, ErrorStateComponent, PaginationComponent,
  ],
  templateUrl: './admin-items.html',
})
export class AdminItemsComponent implements OnInit {
  private readonly admin = inject(AdminService);
  private readonly items = inject(ItemsService);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);

  readonly categories = ITEM_CATEGORIES;

  readonly search = signal('');
  readonly typeFilter = signal<ItemType | ''>('');
  readonly statusFilter = signal<ItemStatus | ''>('');
  readonly categoryFilter = signal<string>('');
  readonly verificationFilter = signal<VerificationStatus | ''>('');
  readonly page = signal(1);

  readonly result = signal<Paginated<ItemWithReporter> | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.result.set(
        await this.items.search({
          search: this.search().trim() || undefined,
          type: this.typeFilter() || undefined,
          status: this.statusFilter() || undefined,
          category: (this.categoryFilter() as ItemCategory) || undefined,
          verificationStatus: this.verificationFilter() || undefined,
          sort: 'newest',
          page: this.page(),
          pageSize: 20,
          hideRejected: false,
        }),
      );
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load items.');
    } finally {
      this.loading.set(false);
    }
  }

  onSearchInput(value: string): void {
    this.search.set(value);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.page.set(1);
      void this.load();
    }, 350);
  }

  applyFilters(): void {
    this.page.set(1);
    void this.load();
  }

  resetFilters(): void {
    this.search.set('');
    this.typeFilter.set('');
    this.statusFilter.set('');
    this.categoryFilter.set('');
    this.verificationFilter.set('');
    this.page.set(1);
    void this.load();
  }

  changePage(page: number): void {
    this.page.set(page);
    void this.load();
  }

  async verify(item: ItemWithReporter, status: VerificationStatus): Promise<void> {
    await this.run(
      item.id,
      () => this.admin.setVerification(item.id, status),
      status === 'verified' ? 'Report verified.' : `Verification set to ${status}.`,
    );
  }

  async setStatus(item: ItemWithReporter, status: Exclude<ItemStatus, 'returned'>): Promise<void> {
    await this.run(item.id, () => this.admin.setStatus(item.id, status), `Status changed to ${status}.`);
  }

  async reject(item: ItemWithReporter): Promise<void> {
    const answer = await this.confirm.confirm({
      title: 'Reject this report?',
      message: `"${item.title}" will be hidden from campus members and removed from matching. The record stays for the audit trail.`,
      confirmLabel: 'Reject report',
      danger: true,
      noteLabel: 'Reason (reviewed by other staff later)',
    });
    if (!answer.confirmed) {
      return;
    }
    await this.run(item.id, () => this.admin.rejectItem(item.id), 'Report rejected.');
  }

  async remove(item: ItemWithReporter): Promise<void> {
    const answer = await this.confirm.confirm({
      title: 'Delete permanently?',
      message: `"${item.title}" and all of its matches and claims will be deleted. Use "Reject" instead if you only want to hide it.`,
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!answer.confirmed) {
      return;
    }
    await this.run(item.id, () => this.admin.deleteItem(item.id), 'Report deleted.');
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
