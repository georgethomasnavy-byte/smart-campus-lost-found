/**
 * Authentication + the signed-in user's profile.
 *
 * Supabase Auth owns the credentials (it never sends us a password to store);
 * this service mirrors the session into signals so templates can react
 * synchronously, and loads the matching row from `public.profiles`, which is
 * where campus identity and administrator privilege are stored.
 *
 * The role is NEVER trusted from the client: it is read back from the database
 * (protected by RLS) and re-checked by every admin policy on the server.
 */
import { Injectable, computed, inject, signal } from '@angular/core';
import type { Session, User } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';
import type { CampusRole, Profile, UserRole } from '../models/database.types';
import { coerceCampusRole } from './campus-roles';
import { SupabaseService } from './supabase.service';

export interface RegisterInput {
  fullName: string;
  email: string;
  password: string;
  campusRole: CampusRole;
  phone?: string;
}

export interface RegisterResult {
  /** true when the project requires e-mail confirmation before login */
  needsEmailConfirmation: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly supabase = inject(SupabaseService);

  private readonly sessionSignal = signal<Session | null>(null);
  private readonly profileSignal = signal<Profile | null>(null);
  /**
   * The college e-mail domain as configured in the database
   * (`public.app_settings.allowed_email_domain`).  It wins over the value in
   * the environment file, so the form and the database trigger can never
   * disagree.  null = not fetched yet.
   */
  private readonly domainFromDatabase = signal<string | null>(null);
  private readonly readySignal = signal(false);
  /** true while a sign-in / sign-up request is in flight */
  private readonly busySignal = signal(false);

  readonly session = this.sessionSignal.asReadonly();
  readonly profile = this.profileSignal.asReadonly();
  readonly ready = this.readySignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();

  readonly isLoggedIn = computed(() => this.sessionSignal() !== null);

  /**
   * Effective college e-mail rule, reactive for templates:
   * the database value when available, otherwise `environment.collegeEmailDomain`.
   * An empty string means "every domain is accepted".
   */
  readonly collegeDomain = computed(() => {
    const fromDatabase = this.domainFromDatabase();
    return fromDatabase !== null ? fromDatabase : AuthService.normaliseDomain(environment.collegeEmailDomain);
  });

  /** True when a restriction is active (used to word the register page). */
  readonly collegeDomainRequired = computed(() => this.collegeDomain().length > 0);

  private static normaliseDomain(value: string | null | undefined): string {
    return (value ?? '').trim().replace(/^@/, '').toLowerCase();
  }
  readonly role = computed<UserRole | null>(() => this.profileSignal()?.role ?? null);
  readonly isAdmin = computed(() => this.profileSignal()?.role === 'admin');
  readonly displayName = computed(
    () => this.profileSignal()?.full_name ?? this.sessionSignal()?.user.email ?? 'Campus member'
  );

  /**
   * Resolves the first time the persisted session has been restored (or we know
   * there is none).  `ready` is a signal for templates; this is the same fact as
   * a promise for guards and other async code — `await auth.ready()` would await
   * a boolean and return immediately, which caused a login race on page reload.
   */
  private resolveReady!: () => void;
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor() {
    void this.initialise();
  }

  /** Wait until session restoration has finished (safe to call many times). */
  async whenReady(): Promise<void> {
    if (this.readySignal()) {
      return;
    }
    await this.readyPromise;
  }

  /** Marks initialisation finished, for both the signal and the promise. */
  private markReady(): void {
    this.readySignal.set(true);
    this.resolveReady();
  }

  /* ------------------------------------------------------------------ */
  /* bootstrap                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Restore any persisted session, load the profile, and subscribe to future
   * auth changes (login, logout, token refresh, e-mail confirmation).
   */
  private async initialise(): Promise<void> {
    if (!this.supabase.isConfigured) {
      this.markReady();
      return;
    }

    try {
      const { data } = await this.supabase.client.auth.getSession();
      this.sessionSignal.set(data.session ?? null);
      if (data.session?.user) {
        await this.loadProfile(data.session.user);
      }
    } catch {
      this.sessionSignal.set(null);
    } finally {
      this.markReady();
    }

    await this.loadCollegeDomain();

    this.supabase.client.auth.onAuthStateChange((_event, session) => {
      this.sessionSignal.set(session ?? null);
      // A fresh sign-in needs the profile fetched; a sign-out clears it.
      queueMicrotask(() => {
        if (session?.user) {
          void this.loadProfile(session.user);
        } else {
          this.profileSignal.set(null);
        }
      });
    });
  }

  /**
   * Ask the database which college domain is accepted (spec: the domain is
   * configuration, never a hard-coded constant).  Anonymous calls are allowed
   * because a visitor must see the rule on the registration form before they
   * have an account.  Any failure silently falls back to the environment value.
   */
  private async loadCollegeDomain(): Promise<void> {
    if (!this.supabase.isConfigured) {
      return;
    }
    try {
      const { data, error } = await this.supabase.client.rpc('allowed_email_domain');
      if (!error && typeof data === 'string') {
        this.domainFromDatabase.set(AuthService.normaliseDomain(data));
      }
    } catch {
      // keep the environment fallback — the app still works without migration 5
    }
  }

  /** Re-read the rule (after an administrator changes it). */
  async refreshCollegeDomain(): Promise<void> {
    await this.loadCollegeDomain();
  }

  /**
   * Read the profile row for a user.  The database trigger creates it at
   * sign-up time; if it is somehow missing, we create it using only a
   * database-allowlisted campus role from untrusted metadata.
   */
  private async loadProfile(user: User): Promise<void> {
    try {
      const { data, error } = await this.supabase.client
        .from('profiles')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle<Profile>();

      if (error) {
        throw error;
      }

      if (data) {
        this.profileSignal.set(data);
        return;
      }

      const fullName =
        (user.user_metadata?.['full_name'] as string | undefined) ??
        user.email?.split('@')[0] ??
        'Campus member';
      const campusRole = coerceCampusRole(user.user_metadata?.['campus_role']);

      const { data: created } = await this.supabase.client
        .from('profiles')
        .insert({ user_id: user.id, full_name: fullName, email: user.email ?? '', role: campusRole, campus_role: campusRole })
        .select('*')
        .single<Profile>();

      this.profileSignal.set(created ?? null);
    } catch {
      this.profileSignal.set(null);
    }
  }

  /* ------------------------------------------------------------------ */
  /* sign up / sign in / sign out                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Register a campus member. The selected student/faculty/staff role is sent
   * only as untrusted signup metadata; the database trigger allowlists those
   * three values and maps every other value (including admin) to student.
   */
  async register(input: RegisterInput): Promise<RegisterResult> {
    this.busySignal.set(true);
    try {
      const { data, error } = await this.supabase.client.auth.signUp({
        email: input.email.trim().toLowerCase(),
        password: input.password,
        options: {
          data: {
            full_name: input.fullName.trim(),
            phone: input.phone?.trim() ?? null,
            campus_role: input.campusRole,
          },
        },
      });

      if (error) {
        throw new Error(SupabaseService.message(error));
      }

      // With "Confirm e-mail" enabled Supabase returns a user but no session.
      const needsEmailConfirmation = !data.session;

      if (data.session?.user) {
        await this.loadProfile(data.session.user);
      }

      return { needsEmailConfirmation };
    } finally {
      this.busySignal.set(false);
    }
  }

  async login(email: string, password: string): Promise<void> {
    this.busySignal.set(true);
    try {
      const { data, error } = await this.supabase.client.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) {
        throw new Error(
          /invalid login credentials/i.test(error.message)
            ? 'Incorrect e-mail or password.'
            : SupabaseService.message(error)
        );
      }
      if (data.user) {
        await this.loadProfile(data.user);
        await this.logSignIn();
      }
    } finally {
      this.busySignal.set(false);
    }
  }

  async logout(): Promise<void> {
    await this.supabase.client.auth.signOut();
    this.sessionSignal.set(null);
    this.profileSignal.set(null);
  }

  async sendPasswordReset(email: string): Promise<void> {
    const { error } = await this.supabase.client.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    });
    if (error) {
      throw new Error(SupabaseService.message(error));
    }
  }

  /* ------------------------------------------------------------------ */
  /* profile                                                            */
  /* ------------------------------------------------------------------ */

  /** Update the fields a student is allowed to change (never role/email). */
  async updateProfile(patch: { full_name?: string; phone?: string | null }): Promise<void> {
    const user = this.sessionSignal()?.user;
    if (!user) {
      throw new Error('Please log in to continue.');
    }

    const { data, error } = await this.supabase.client
      .from('profiles')
      .update(patch)
      .eq('user_id', user.id)
      .select('*')
      .single<Profile>();

    if (error) {
      throw new Error(SupabaseService.message(error));
    }
    this.profileSignal.set(data);
    await this.activity('profile_updated', 'profile', user.id, {});
  }

  /* ------------------------------------------------------------------ */
  /* validation helpers used by the forms                               */
  /* ------------------------------------------------------------------ */

  /** The configurable college domain, or '' when any domain is accepted. */
  /**
   * Effective domain, as a plain string (non-reactive callers such as
   * `isCollegeEmail`).  Use `collegeDomain()` inside templates.
   */
  get collegeEmailDomain(): string {
    return this.collegeDomain();
  }

  /** Does an address satisfy the configured college domain rule? */
  isCollegeEmail(email: string): boolean {
    const domain = this.collegeEmailDomain;
    const value = email.trim().toLowerCase();
    if (!domain) {
      return true; // no restriction configured
    }
    return value.endsWith(`@${domain.toLowerCase()}`);
  }

  /* ------------------------------------------------------------------ */
  /* activity log (self-service whitelist enforced by RLS)              */
  /* ------------------------------------------------------------------ */

  private async logSignIn(): Promise<void> {
    const user = this.sessionSignal()?.user;
    if (user) {
      await this.activity('user_login', 'profile', user.id, {});
    }
  }

  private async activity(
    action: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>
  ): Promise<void> {
    try {
      // RLS only accepts the whitelisted self-service actions here.
      await this.supabase.client
        .from('activity_logs')
        .insert({ user_id: entityId, action, entity_type: entityType, entity_id: entityId, details });
    } catch {
      // logging must never break a user flow
    }
  }
}
