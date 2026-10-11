import { Component, computed, input, output } from '@angular/core';

/** Compact pager used by every listing page (server-side pagination). */
@Component({
  selector: 'app-pagination',
  template: `
    @if (totalPages() > 1) {
      <nav class="d-flex flex-wrap justify-content-center align-items-center gap-2 mt-4" aria-label="Pagination">
        <button class="btn btn-sm btn-outline-secondary" [disabled]="page() <= 1" (click)="go(page() - 1)">
          <i class="bi bi-chevron-left"></i> Prev
        </button>
        @for (item of pages(); track $index) {
          @if (item === -1) {
            <span class="text-muted">…</span>
          } @else {
            <button class="btn btn-sm" [class.btn-primary]="item === page()" [class.btn-outline-secondary]="item !== page()"
              (click)="go(item)" [attr.aria-current]="item === page() ? 'page' : null">{{ item }}</button>
          }
        }
        <button class="btn btn-sm btn-outline-secondary" [disabled]="page() >= totalPages()" (click)="go(page() + 1)">
          Next <i class="bi bi-chevron-right"></i>
        </button>
        <span class="text-muted small ms-2">Page {{ page() }} of {{ totalPages() }}</span>
      </nav>
    }
  `,
})
export class PaginationComponent {
  readonly page = input.required<number>();
  readonly totalPages = input.required<number>();
  readonly pageChange = output<number>();

  /** 1 … 4 5 [6] 7 8 … 20  (a -1 marks an ellipsis) */
  readonly pages = computed<number[]>(() => {
    const total = this.totalPages();
    const current = this.page();
    if (total <= 7) {
      return Array.from({ length: total }, (_, index) => index + 1);
    }
    const result = new Set<number>([1, total, current - 1, current, current + 1]);
    const sorted = [...result].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b);
    const withGaps: number[] = [];
    let previous = 0;
    for (const value of sorted) {
      if (previous && value - previous > 1) {
        withGaps.push(-1);
      }
      withGaps.push(value);
      previous = value;
    }
    return withGaps;
  });

  go(target: number): void {
    if (target >= 1 && target <= this.totalPages() && target !== this.page()) {
      this.pageChange.emit(target);
    }
  }
}
