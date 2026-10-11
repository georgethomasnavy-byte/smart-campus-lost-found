import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { NotificationsService } from '../../core/services/notifications.service';
import { ToastService } from '../../core/services/toast.service';

/**
 * Role-aware responsive navigation (spec §13).
 *   guest   -> Home, Lost Items, Found Items, About, Login, Register
 *   campus member -> Home, Lost, Found, Report Lost, Report Found, Matches,
 *              Notifications, Dashboard, Profile, Logout
 *   admin   -> Admin, Items, Claims, Users, Reports, Activity Logs, Logout
 */
@Component({
  selector: 'app-navbar',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './navbar.html',
})
export class NavbarComponent {
  readonly auth = inject(AuthService);
  readonly notifications = inject(NotificationsService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly firstName = computed(() => (this.auth.profile()?.full_name ?? 'Campus member').split(' ')[0]);

  readonly initials = computed(() => {
    const name = this.auth.profile()?.full_name ?? 'Campus member';
    return name.split(' ').slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
  });

  async logout(): Promise<void> {
    try {
      await this.auth.logout();
      this.notifications.refreshUnread(null);
      this.toast.success('You have been logged out.');
      await this.router.navigate(['/']);
    } catch (error) {
      this.toast.error(error instanceof Error ? error.message : 'Could not log out.');
    }
  }
}
