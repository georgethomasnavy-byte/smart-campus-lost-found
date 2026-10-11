import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Shown instead of a blank page when a query legitimately returns nothing. */
@Component({
  selector: 'app-empty-state',
  imports: [RouterLink],
  template: `
    <div class="text-center py-5">
      <i class="bi {{ icon() }} display-5 text-secondary opacity-50"></i>
      <h3 class="h5 mt-3">{{ title() }}</h3>
      @if (message()) {
        <p class="text-muted mb-3">{{ message() }}</p>
      }
      @if (actionLabel() && actionLink()) {
        <a class="btn btn-primary" [routerLink]="actionLink()">{{ actionLabel() }}</a>
      }
      <ng-content />
    </div>
  `,
})
export class EmptyStateComponent {
  readonly icon = input('bi-inbox');
  readonly title = input('Nothing here yet');
  readonly message = input('');
  readonly actionLabel = input('');
  readonly actionLink = input<string | unknown[] | null>(null);
}
