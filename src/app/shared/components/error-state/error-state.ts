import { Component, input, output } from '@angular/core';

/** Visible error state with a retry button — never a silent blank screen. */
@Component({
  selector: 'app-error-state',
  template: `
    <div class="alert alert-danger d-flex align-items-start gap-3" role="alert">
      <i class="bi bi-exclamation-triangle-fill fs-4"></i>
      <div class="flex-grow-1">
        <strong>{{ title() }}</strong>
        <p class="mb-2">{{ message() }}</p>
        @if (showRetry()) {
          <button type="button" class="btn btn-sm btn-outline-danger" (click)="retry.emit()">
            <i class="bi bi-arrow-clockwise me-1"></i>Try again
          </button>
        }
      </div>
    </div>
  `,
})
export class ErrorStateComponent {
  readonly title = input('Unable to load this page');
  readonly message = input('Please try again.');
  readonly showRetry = input(true);
  readonly retry = output<void>();
}
