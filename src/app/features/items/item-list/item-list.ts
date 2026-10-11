import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { environment } from '../../../../environments/environment';
import type { ItemCategory, ItemStatus, ItemType } from '../../../core/models/database.types';
import { ITEM_CATEGORIES } from '../../../core/models/database.types';
import type { ItemWithReporter } from '../../../core/models/database.types';
import type { ItemFilters, LoadState, Paginated } from '../../../core/models/common.model';
import { ItemsService } from '../../../core/services/items.service';
import { EmptyStateComponent } from '../../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../../shared/components/error-state/error-state';
import { ItemCardComponent } from '../../../shared/components/item-card/item-card';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';

export type ItemListMode = 'lost' | 'found' | 'all';

/**
 * One component powers three spec pages: Lost Items, Found Items and Search.
 * Every filter is applied by the database (PostgREST query), not in the
 * browser, so pagination stays correct with thousands of rows.
 */
@Component({
  selector: 'app-item-list',
  imports: [
    FormsModule, RouterLink, ItemCardComponent, LoadingSpinnerComponent, EmptyStateComponent,
    ErrorStateComponent, PaginationComponent,
  ],
  templateUrl: './item-list.html',
})
export class ItemListComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly items = inject(ItemsService);

  readonly categories = ITEM_CATEGORIES;
  readonly pageSize = environment.pageSize;

  readonly mode = signal<ItemListMode>('all');
  readonly searchTerm = signal('');
  readonly category = signal<ItemCategory | ''>('');
  readonly status = signal<ItemStatus | ''>('');
  readonly location = signal('');
  readonly dateFrom = signal('');
  readonly dateTo = signal('');
  readonly sort = signal<'newest' | 'oldest'>('newest');
  readonly page = signal(1);
  readonly showFilters = signal(false);
  private loadVersion = 0;

  readonly result = signal<Paginated<ItemWithReporter> | null>(null);
  readonly state = signal<LoadState>('idle');
  readonly error = signal<string | null>(null);

  readonly reportLink = computed(() => this.mode() === 'found' ? '/report-found' : '/report-lost');
  readonly reportLabel = computed(() => this.mode() === 'found' ? 'Report found item' : 'Report lost item');

  readonly title = computed(() => {
    switch (this.mode()) {
      case 'lost':
        return 'Lost items';
      case 'found':
        return 'Found items';
      default:
        return 'Search all items';
    }
  });

  readonly lead = computed(() => {
    switch (this.mode()) {
      case 'lost':
        return 'Browse campus reports of items reported missing.';
      case 'found':
        return 'Browse found-item reports. Public collection instructions are shown on each report.';
      default:
        return 'Search lost and found reports across names, descriptions, keywords, identifying details and campus areas.';
    }
  });

  readonly activeFilterCount = computed(() => {
    let count = 0;
    if (this.searchTerm().trim()) count++;
    if (this.category()) count++;
    if (this.status()) count++;
    if (this.location().trim()) count++;
    if (this.dateFrom()) count++;
    if (this.dateTo()) count++;
    return count;
  });

  readonly isEmpty = computed(() => this.state() === 'ready' && (this.result()?.total ?? 0) === 0);
  readonly rangeLabel = computed(() => {
    const result = this.result();
    if (!result || result.total === 0) {
      return '';
    }
    const first = (result.page - 1) * result.pageSize + 1;
    const last = Math.min(result.total, first + result.rows.length - 1);
    return `Showing ${first}–${last} of ${result.total} report(s)`;
  });

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    // mode comes from the route, filters may come from the URL (e.g. /search?search=wallet)
    this.mode.set((this.route.snapshot.data['mode'] as ItemListMode) ?? 'all');

    const query = this.route.snapshot.queryParamMap;
    this.searchTerm.set(query.get('search') ?? '');
    const requestedCategory = query.get('category') ?? '';
    this.category.set((ITEM_CATEGORIES as readonly string[]).includes(requestedCategory)
      ? requestedCategory as ItemCategory
      : '');
    this.location.set(query.get('location') ?? '');
    const requestedStatus = query.get('status') ?? '';
    const statuses: readonly ItemStatus[] = ['active', 'matched', 'claimed', 'returned', 'closed'];
    this.status.set(statuses.includes(requestedStatus as ItemStatus) ? requestedStatus as ItemStatus : '');
    this.dateFrom.set(query.get('dateFrom') ?? '');
    this.dateTo.set(query.get('dateTo') ?? '');
    this.sort.set(query.get('sort') === 'oldest' ? 'oldest' : 'newest');
    this.page.set(Math.max(1, Number(query.get('page') ?? '1') || 1));
    this.showFilters.set(this.mode() === 'all' || !!this.category() || !!this.status()
      || !!this.location() || !!this.dateFrom() || !!this.dateTo() || this.sort() === 'oldest');

    void this.load();
  }

  async load(): Promise<void> {
    const version = ++this.loadVersion;
    this.state.set('loading');
    this.error.set(null);
    if (this.dateFrom() && this.dateTo() && this.dateFrom() > this.dateTo()) {
      this.error.set('The start date must be on or before the end date.');
      this.state.set('error');
      return;
    }

    const filters: ItemFilters = {
      search: this.searchTerm().trim() || undefined,
      type: (this.mode() === 'all' ? '' : this.mode()) as ItemType | '',
      category: this.category() || undefined,
      status: this.status() || undefined,
      location: this.location().trim() || undefined,
      dateFrom: this.dateFrom() || undefined,
      dateTo: this.dateTo() || undefined,
      sort: this.sort(),
      page: this.page(),
      pageSize: this.pageSize,
    };

    try {
      const result = await this.items.search(filters);
      if (version !== this.loadVersion) {
        return;
      }
      this.result.set(result);
      this.state.set('ready');
      this.syncUrl();
    } catch (caught) {
      if (version !== this.loadVersion) {
        return;
      }
      this.error.set(caught instanceof Error ? caught.message : 'Could not load items.');
      this.state.set('error');
    }
  }

  /** Typing is debounced so we do not fire a query per keystroke. */
  onSearchInput(value: string): void {
    this.searchTerm.set(value);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.page.set(1);
      void this.load();
    }, 350);
  }

  applyFilters(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.page.set(1);
    void this.load();
  }

  clearFilters(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.searchTerm.set('');
    this.category.set('');
    this.status.set('');
    this.location.set('');
    this.dateFrom.set('');
    this.dateTo.set('');
    this.sort.set('newest');
    this.page.set(1);
    this.showFilters.set(false);
    void this.load();
  }

  changePage(page: number): void {
    this.page.set(page);
    void this.load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Keep the address bar shareable (search terms survive a refresh). */
  private syncUrl(): void {
    const queryParams: Record<string, string> = {};
    if (this.searchTerm().trim()) queryParams['search'] = this.searchTerm().trim();
    if (this.category()) queryParams['category'] = this.category();
    if (this.status()) queryParams['status'] = this.status();
    if (this.location().trim()) queryParams['location'] = this.location().trim();
    if (this.dateFrom()) queryParams['dateFrom'] = this.dateFrom();
    if (this.dateTo()) queryParams['dateTo'] = this.dateTo();
    if (this.sort() !== 'newest') queryParams['sort'] = this.sort();
    if (this.page() > 1) queryParams['page'] = String(this.page());

    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      replaceUrl: true,
    });
  }
}
