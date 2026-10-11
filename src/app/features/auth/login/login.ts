import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { SupabaseService } from '../../../core/services/supabase.service';
import { ToastService } from '../../../core/services/toast.service';

/** Login page. On success the visitor returns to the page they came from. */
@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  templateUrl: './login.html',
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toast = inject(ToastService);

  readonly supabase = inject(SupabaseService);
  readonly email = signal('');
  readonly password = signal('');
  readonly showPassword = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  async submit(): Promise<void> {
    this.error.set(null);

    if (!this.email().trim() || !this.password()) {
      this.error.set('Please enter both your e-mail address and password.');
      return;
    }

    this.busy.set(true);
    try {
      await this.auth.login(this.email().trim(), this.password());

      const profile = this.auth.profile();
      this.toast.success(`Welcome back, ${(profile?.full_name ?? 'there').split(' ')[0]}!`);

      const redirect = this.route.snapshot.queryParamMap.get('redirect');
      const target = this.auth.isAdmin() ? '/admin' : '/dashboard';
      await this.router.navigateByUrl(redirect && redirect.startsWith('/') ? redirect : target);
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not log in.');
    } finally {
      this.busy.set(false);
    }
  }
}
