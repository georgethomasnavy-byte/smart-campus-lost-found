import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CAMPUS_ROLES, type CampusRole } from '../../../core/models/database.types';
import { AuthService } from '../../../core/services/auth.service';
import { SupabaseService } from '../../../core/services/supabase.service';
import { ToastService } from '../../../core/services/toast.service';

/**
 * Registration offers campus member roles; only the database-allowlisted
 * student/faculty/staff metadata can be applied. Administrator is never an option.
 */
@Component({
  selector: 'app-register',
  imports: [FormsModule, RouterLink],
  templateUrl: './register.html',
})
export class RegisterComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly supabase = inject(SupabaseService);

  /** The rule comes from the database (public.app_settings), so it can be
   *  changed without touching or redeploying the application. */
  readonly collegeDomain = this.auth.collegeDomain;
  readonly domainRequired = this.auth.collegeDomainRequired;
  readonly domainHint = computed(() => `@${this.collegeDomain()}`);

  readonly campusRoles = CAMPUS_ROLES;
  readonly campusRole = signal<CampusRole>('student');
  readonly fullName = signal('');
  readonly email = signal('');
  readonly phone = signal('');
  readonly password = signal('');
  readonly confirmPassword = signal('');
  readonly showPassword = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly needsConfirmation = signal(false);

  readonly emailLooksValid = computed(() => this.auth.isCollegeEmail(this.email().trim()));
  readonly passwordStrength = computed(() => {
    const value = this.password();
    let score = 0;
    if (value.length >= 8) score++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
    if (/\d/.test(value)) score++;
    if (/[^A-Za-z0-9]/.test(value)) score++;
    return score;
  });
  readonly passwordStrengthLabel = computed(
    () => ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][this.passwordStrength()],
  );
  readonly passwordStrengthClass = computed(
    () => ['bg-danger', 'bg-danger', 'bg-warning', 'bg-info', 'bg-success'][this.passwordStrength()],
  );
  readonly passwordsMatch = computed(
    () => this.confirmPassword().length > 0 && this.password() === this.confirmPassword(),
  );

  async submit(): Promise<void> {
    this.error.set(null);
    await this.auth.refreshCollegeDomain();

    if (!this.fullName().trim() || this.fullName().trim().length < 3) {
      this.error.set('Please enter your full name.');
      return;
    }
    if (!this.emailLooksValid()) {
      this.error.set(`Please use your college e-mail address ending in ${this.domainHint()}.`);
      return;
    }
    if (this.password().length < 8) {
      this.error.set('Your password must be at least 8 characters long.');
      return;
    }
    if (this.password() !== this.confirmPassword()) {
      this.error.set('The two passwords do not match.');
      return;
    }

    this.busy.set(true);
    try {
      const result = await this.auth.register({
        email: this.email().trim(),
        password: this.password(),
        fullName: this.fullName().trim(),
        campusRole: this.campusRole(),
        phone: this.phone().trim(),
      });

      if (result.needsEmailConfirmation) {
        this.needsConfirmation.set(true);
        this.toast.info('Account created. Please confirm your e-mail address, then log in.');
        return;
      }

      this.toast.success('Your campus account is ready. Welcome!');
      await this.router.navigate(['/dashboard']);
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : 'Could not create the account.');
    } finally {
      this.busy.set(false);
    }
  }
}
