import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfirmService } from '../../../core/services/confirm.service';

/**
 * Single confirmation modal for the whole application. Destructive actions
 * (approve/reject a claim, remove a listing, delete a report) all route
 * through ConfirmService and appear here.
 */
@Component({
  selector: 'app-confirm-host',
  imports: [FormsModule],
  template: `
    @if (confirm.pending(); as request) {
      <div class="modal d-block" tabindex="-1" style="background: rgba(15,23,42,.5)" (click)="cancel()">
        <div class="modal-dialog modal-dialog-centered" (click)="$event.stopPropagation()">
          <div class="modal-content">
            <div class="modal-header">
              <h2 class="modal-title h5">{{ request.title }}</h2>
              <button type="button" class="btn-close" aria-label="Close" (click)="cancel()"></button>
            </div>
            <div class="modal-body">
              <p class="mb-3">{{ request.message }}</p>
              @if (request.noteLabel) {
                <label class="form-label" for="confirm-note">{{ request.noteLabel }}</label>
                <textarea id="confirm-note" class="form-control" rows="3" [placeholder]="request.notePlaceholder ?? ''"
                  [ngModel]="note()" (ngModelChange)="note.set($event)"></textarea>
              }
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" (click)="cancel()">
                {{ request.cancelLabel ?? 'Cancel' }}
              </button>
              <button type="button" class="btn" [class.btn-danger]="request.danger" [class.btn-primary]="!request.danger"
                (click)="accept()">
                {{ request.confirmLabel ?? 'Confirm' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConfirmHostComponent {
  readonly confirm = inject(ConfirmService);
  readonly note = signal('');

  constructor() {
    effect(() => {
      if (this.confirm.pending()) {
        this.note.set('');
      }
    });
  }

  accept(): void {
    this.confirm.respond(true, this.note());
  }

  cancel(): void {
    this.confirm.respond(false);
  }
}
