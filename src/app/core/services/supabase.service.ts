/**
 * Single place where the Supabase client is created.
 *
 * Nothing else in the application talks to the network directly — every
 * feature service injects this one.  That keeps configuration, error messages
 * and the "not configured yet" guard in a single spot.
 */
import { Injectable } from '@angular/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class SupabaseService {
  private clientInstance: SupabaseClient | null = null;

  /**
   * True when real credentials are present.  The UI uses this to show a
   * friendly "finish your Supabase setup" message instead of a wall of
   * cryptic network errors on a fresh clone.
   */
  readonly isConfigured: boolean = SupabaseService.looksConfigured(
    environment.supabaseUrl,
    environment.supabaseAnonKey
  );

  /** The configured client. Throws a readable error if setup is incomplete. */
  get client(): SupabaseClient {
    if (!this.isConfigured) {
      throw new Error(
        'Supabase is not configured yet. Open src/environments/environment.ts and add your ' +
          'supabaseUrl and supabaseAnonKey (see the README section "Environment variables").'
      );
    }
    if (!this.clientInstance) {
      this.clientInstance = createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
        auth: {
          persistSession: true,      // keeps the user logged in across reloads
          autoRefreshToken: true,
          detectSessionInUrl: true,  // needed for e-mail confirmation links
          storageKey: 'campus-lost-found-auth',
        },
      });
    }
    return this.clientInstance;
  }

  private static looksConfigured(url: string, key: string): boolean {
    return (
      !!url &&
      !!key &&
      !url.includes('YOUR_SUPABASE') &&
      !key.includes('YOUR_SUPABASE') &&
      url.startsWith('http')
    );
  }

  /**
   * Pull the human-readable text out of whatever was thrown.
   *
   * Never `String(error)` on an arbitrary value: a plain object becomes the
   * useless "[object Object]" and the student sees that in a toast.  Anything
   * we cannot read falls through to the generic sentence below.
   */
  private static rawText(error: unknown): string {
    if (!error) {
      return '';
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error instanceof Error) {
      return error.message ?? '';
    }
    const candidate = error as { message?: unknown; details?: unknown; hint?: unknown };
    for (const value of [candidate.message, candidate.details, candidate.hint]) {
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
    return '';
  }

  /** Turn a raw Supabase/Postgrest error into something a student can read. */
  static message(error: unknown): string {
    const raw = SupabaseService.rawText(error);
    if (!raw) {
      return 'Something went wrong. Please try again.';
    }
    if (/row-level security|violates row-level/i.test(raw)) {
      return 'You are not allowed to do that.';
    }
    if (/duplicate key value/i.test(raw)) {
      return 'That record already exists.';
    }
    // Raised by the `enforce_college_email` trigger during sign-up.
    if (/may register|college e-mail/i.test(raw)) {
      return raw;
    }
    if (/Database error saving new user/i.test(raw)) {
      return (
        'Registration was refused by the database. This usually means the e-mail address ' +
        'does not use the allowed college domain — check the rule shown on the register page.'
      );
    }
    if (/Failed to fetch|NetworkError/i.test(raw)) {
      return 'Cannot reach the server. Check your internet connection and try again.';
    }
    if (/JWT expired|invalid claim/i.test(raw)) {
      return 'Your session has expired. Please log in again.';
    }
    return raw;
  }
}
