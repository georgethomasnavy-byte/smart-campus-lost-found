import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import type { ItemWithReporter, PublicStats } from '../../core/models/database.types';
import { ItemsService } from '../../core/services/items.service';
import { SupabaseService } from '../../core/services/supabase.service';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state';
import { ErrorStateComponent } from '../../shared/components/error-state/error-state';
import { ItemCardComponent } from '../../shared/components/item-card/item-card';
import { LoadingSpinnerComponent } from '../../shared/components/loading-spinner/loading-spinner';

/**
 * Landing page (spec §14).
 * Every number comes from the database via the public_stats() function —
 * nothing here is hard-coded, and an empty database correctly shows zeroes.
 */
@Component({
  selector: 'app-home',
  imports: [
    RouterLink, ItemCardComponent, LoadingSpinnerComponent,
    EmptyStateComponent, ErrorStateComponent,
  ],
  templateUrl: './home.html',
})
export class HomeComponent {
  private readonly items = inject(ItemsService);
  private readonly router = inject(Router);
  readonly supabase = inject(SupabaseService);

  readonly appName = environment.appName;
  /** Quick search suggestions (they pre-fill the search page). */
  readonly popularSearches = ['Wallet', 'ID Card', 'Earphones', 'Water Bottle', 'Umbrella', 'Laptop'];
  readonly stats = signal<PublicStats | null>(null);
  readonly recentLost = signal<ItemWithReporter[]>([]);
  readonly recentFound = signal<ItemWithReporter[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly searchTerm = signal('');

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    if (!this.supabase.isConfigured) {
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    try {
      const [stats, lost, found] = await Promise.all([
        this.items.publicStats(),
        this.items.search({ type: 'lost', pageSize: 3 }),
        this.items.search({ type: 'found', pageSize: 3 }),
      ]);
      this.stats.set(stats);
      this.recentLost.set(lost.rows);
      this.recentFound.set(found.rows);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not load the dashboard.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Search from the hero box: hands the term to the full search page. */
  onSearch(term: string): void {
    const query = term.trim();
    void this.router.navigate([query ? '/search' : '/lost-items'], {
      queryParams: query ? { search: query } : {},
    });
  }
}
