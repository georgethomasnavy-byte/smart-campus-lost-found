import { Component, input } from '@angular/core';

/** Consistent "loading…" block used by every async page. */
@Component({
  selector: 'app-loading-spinner',
  template: `
    <div class="text-center py-5" role="status" aria-live="polite">
      <div class="spinner-border text-primary" aria-hidden="true"></div>
      <p class="text-muted mt-2 mb-0">{{ label() }}</p>
    </div>
  `,
})
export class LoadingSpinnerComponent {
  readonly label = input('Loading…');
}
