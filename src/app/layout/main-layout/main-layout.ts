import { Component, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { NotificationsService } from '../../core/services/notifications.service';
import { ConfirmHostComponent } from '../../shared/components/confirm-host/confirm-host';
import { ToastHostComponent } from '../../shared/components/toast-host/toast-host';
import { FooterComponent } from '../footer/footer';
import { NavbarComponent } from '../navbar/navbar';

/** Shell for every page: navbar + routed content + footer + global overlays. */
@Component({
  selector: 'app-main-layout',
  imports: [RouterOutlet, NavbarComponent, FooterComponent, ToastHostComponent, ConfirmHostComponent],
  template: `
    <div class="page-shell">
      <app-navbar />
      <main class="container py-4" [class.is-home]="isHome()">
        <router-outlet />
      </main>
      <app-footer />
      <app-toast-host />
      <app-confirm-host />
    </div>
  `,
})
export class MainLayoutComponent {
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationsService);
  private readonly auth = inject(AuthService);

  /** The landing page draws its own full-bleed hero, so it skips the container padding. */
  private readonly currentUrl = signal('/');
  readonly isHome = computed(() => this.currentUrl() === '/');

  constructor() {
    // keep the navbar badge in step with the signed-in user
    effect(() => {
      void this.notifications.refreshUnread(this.auth.profile()?.user_id ?? null);
    });

    // ... and refresh it as the student moves between pages
    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => {
        this.currentUrl.set(this.router.url.split('?')[0]);
        void this.notifications.refreshUnread(this.auth.profile()?.user_id ?? null);
      });
  }
}
