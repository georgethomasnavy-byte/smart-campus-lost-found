import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AdminStats, CategoryStat, ClaimStatus } from '../../../core/models/database.types';
import { AdminService } from '../../../core/services/admin.service';
import { ClaimsService } from '../../../core/services/claims.service';
import { ReportsService } from '../../../core/services/reports.service';
import { ErrorStateComponent } from '../../../shared/components/error-state/error-state';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner';

/** Administrator overview (spec §23) — all figures come from SQL functions. */
@Component({
  selector: 'app-admin-dashboard',
  imports: [RouterLink, LoadingSpinnerComponent, ErrorStateComponent],
  templateUrl: './admin-dashboard.html',
})
export class AdminDashboardComponent implements OnInit {
  private readonly admin = inject(AdminService);
  private readonly claims = inject(ClaimsService);
  private readonly reports = inject(ReportsService);

  readonly stats = signal<AdminStats | null>(null);
  readonly categories = signal<CategoryStat[]>([]);
  readonly claimCounts = signal<Record<ClaimStatus | 'total', number> | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [stats, categories, claimCounts] = await Promise.all([
        this.admin.stats(),
        this.admin.categoryStats(),
        this.claims.counts(),
      ]);
      this.stats.set(stats);
      this.categories.set(categories);
      this.claimCounts.set(claimCounts);
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not load admin statistics.');
    } finally {
      this.loading.set(false);
    }
  }

  percent(value: number, total: number): number {
    return total > 0 ? Math.round((value / total) * 100) : 0;
  }

  maxCategoryTotal(): number {
    return Math.max(1, ...this.categories().map((row) => row.total));
  }

  barWidth(total: number): number {
    return Math.round((total / this.maxCategoryTotal()) * 100);
  }
}
