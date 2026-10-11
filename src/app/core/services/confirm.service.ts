/**
 * Promise-based confirmation dialog, rendered once by <app-confirm-host>.
 * Keeps destructive actions (remove report, reject claim) one line long in
 * the feature components.
 */
import { Injectable, signal } from '@angular/core';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** free-text note collected from the user (e.g. rejection reason) */
  noteLabel?: string;
  notePlaceholder?: string;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (value: { confirmed: boolean; note: string }) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly pending = signal<PendingConfirm | null>(null);

  confirm(request: ConfirmRequest): Promise<{ confirmed: boolean; note: string }> {
    return new Promise((resolve) => {
      this.pending.set({ ...request, resolve });
    });
  }

  respond(confirmed: boolean, note = ''): void {
    const current = this.pending();
    this.pending.set(null);
    current?.resolve({ confirmed, note });
  }
}
