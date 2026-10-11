import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ItemWithReporter } from '../../../core/models/database.types';
import { DateLabelPipe } from '../../pipes/date-label.pipe';
import { StatusBadgeComponent } from '../status-badge/status-badge';
import { MatchScoreComponent } from '../match-score/match-score';

/**
 * The listing card used by the home page, both item lists, My Reports and the
 * admin tables.  One component = one visual language for an item everywhere.
 */
@Component({
  selector: 'app-item-card',
  imports: [RouterLink, DateLabelPipe, StatusBadgeComponent, MatchScoreComponent],
  template: `
    <div class="card item-card shadow-sm">
      <div class="item-thumb position-relative">
        @if (item().image_url) {
          <img [src]="item().image_url" [alt]="item().title" loading="lazy" />
        } @else {
          <span class="placeholder-icon"><i class="bi {{ categoryIcon() }}"></i></span>
        }
        <span class="position-absolute top-0 start-0 m-2">
          <app-status-badge [status]="item().type" />
        </span>
        @if (matchScore() !== null) {
          <span class="position-absolute top-0 end-0 m-2">
            <app-match-score [score]="matchScore()!" [compact]="true" />
          </span>
        }
      </div>

      <div class="card-body d-flex flex-column">
        <h3 class="card-title h6 mb-1 text-truncate-2">
          <a [routerLink]="['/items', item().id]">{{ item().title }}</a>
        </h3>

        <ul class="list-unstyled small text-muted mb-2">
          <li><i class="bi bi-geo-alt me-1"></i>{{ item().location }}</li>
          <li><i class="bi bi-calendar3 me-1"></i>{{ item().date_occurred | dateLabel }}</li>
          <li><i class="bi bi-person me-1"></i>{{ item().reporter?.full_name ?? 'Campus member' }}</li>
        </ul>

        <div class="mt-auto d-flex flex-wrap align-items-center gap-2">
          <span class="badge text-bg-light border">{{ categoryIcon() }} {{ item().category }}</span>
          <app-status-badge [status]="item().status" />
          @if (item().verification_status === 'verified') {
            <app-status-badge status="verified" />
          }
        </div>
      </div>
    </div>
  `,
})
export class ItemCardComponent {
  readonly item = input.required<ItemWithReporter>();
  /** when this card is shown inside a match list */
  readonly matchScore = input<number | null>(null);

  private static readonly ICONS: Record<string, string> = {
    Electronics: 'bi-phone',
    'ID Cards': 'bi-person-vcard',
    Wallets: 'bi-wallet2',
    Keys: 'bi-key',
    Bags: 'bi-bag',
    Books: 'bi-book',
    Clothing: 'bi-basket',
    Accessories: 'bi-watch',
    Documents: 'bi-file-earmark-text',
    Other: 'bi-box-seam',
  };

  categoryIcon(): string {
    return ItemCardComponent.ICONS[this.item().category] ?? 'bi-box-seam';
  }
}
