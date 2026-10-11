import { Component, inject } from '@angular/core';
import { ToastService } from '../../../core/services/toast.service';

/** Renders the toast stack once, at application level. */
@Component({
  selector: 'app-toast-host',
  template: `
    <div class="toast-stack">
      @for (toast of toasts.toasts(); track toast.id) {
        <div class="toast show mb-2 border-0 shadow" role="alert" aria-live="assertive">
          <div class="toast-header text-white border-0" [class]="headerClass(toast.kind)">
            <i class="bi me-2" [class]="icon(toast.kind)"></i>
            <strong class="me-auto">{{ toast.title }}</strong>
            <button type="button" class="btn-close btn-close-white" aria-label="Close" (click)="toasts.dismiss(toast.id)"></button>
          </div>
          <div class="toast-body">{{ toast.text }}</div>
        </div>
      }
    </div>
  `,
})
export class ToastHostComponent {
  readonly toasts = inject(ToastService);

  headerClass(kind: string): string {
    return {
      success: 'bg-success', error: 'bg-danger', warning: 'bg-warning', info: 'bg-info',
    }[kind] ?? 'bg-secondary';
  }

  icon(kind: string): string {
    return {
      success: 'bi-check-circle', error: 'bi-exclamation-octagon',
      warning: 'bi-exclamation-triangle', info: 'bi-info-circle',
    }[kind] ?? 'bi-info-circle';
  }
}
