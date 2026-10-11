/**
 * Small toast/alert bus.  Components render `toasts()`; anything can push to it.
 */
import { Injectable, signal } from '@angular/core';
import type { AppMessage } from '../models/common.model';

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly items = signal<Array<AppMessage & { id: number }>>([]);
  readonly toasts = this.items.asReadonly();
  private nextId = 1;

  success(text: string, title = 'Done'): void {
    this.push({ kind: 'success', text, title });
  }

  error(text: string, title = 'Something went wrong'): void {
    this.push({ kind: 'error', text, title });
  }

  info(text: string, title = 'Heads up'): void {
    this.push({ kind: 'info', text, title });
  }

  warning(text: string, title = 'Please check'): void {
    this.push({ kind: 'warning', text, title });
  }

  dismiss(id: number): void {
    this.items.update((list) => list.filter((item) => item.id !== id));
  }

  private push(message: AppMessage, timeoutMs = 5000): void {
    const id = this.nextId++;
    this.items.update((list) => [...list, { ...message, id }]);
    setTimeout(() => this.dismiss(id), timeoutMs);
  }
}
