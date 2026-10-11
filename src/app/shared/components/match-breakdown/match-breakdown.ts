import { Component, input } from '@angular/core';
import type { MatchBreakdown } from '../../../core/models/common.model';

/**
 * The transparency feature: shows exactly which signals produced a score.
 * This is what makes the algorithm defensible — nothing is a black box.
 */
@Component({
  selector: 'app-match-breakdown',
  template: `
    <div class="table-responsive">
      <table class="table table-sm align-middle mb-0">
        <thead>
          <tr>
            <th scope="col">Signal</th>
            <th scope="col" class="text-center">Points</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          @for (row of breakdown(); track row.key) {
            <tr>
              <th scope="row" class="fw-normal">{{ row.label }}</th>
              <td class="text-center text-nowrap">
                <strong>{{ row.points }}</strong><span class="text-muted">/{{ row.maxPoints }}</span>
                <div class="match-meter mt-1" style="min-width:70px">
                  <span [style.width.%]="(row.points / row.maxPoints) * 100"></span>
                </div>
              </td>
              <td class="small text-muted">{{ row.explanation }}</td>
            </tr>
          }
        </tbody>
        <tfoot>
          <tr class="fw-bold">
            <td colspan="2">Total</td>
            <td>{{ total() }} / 100</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `,
})
export class MatchBreakdownComponent {
  readonly breakdown = input.required<MatchBreakdown[]>();
  readonly total = input(0);
}
