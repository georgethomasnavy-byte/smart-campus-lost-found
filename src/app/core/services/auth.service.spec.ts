/**
 * Tests for the authentication service and the two behaviours the rest of the
 * app depends on:
 *
 *   1. `whenReady()` — the promise the route guards await.  A regression test
 *      for a real bug: `await auth.ready()` looked correct but awaited a
 *      boolean (the signal's value) and therefore never waited, so reloading
 *      /dashboard while signed in could bounce the user to /login.
 *   2. `isCollegeEmail()` — the configurable college-domain rule (spec:
 *      the domain must not be hard-coded).
 *
 * These run without a Supabase project: the service detects the placeholder
 * configuration and stays offline, which is exactly the "not configured yet"
 * path a fresh clone hits.
 */
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';
import { SupabaseService } from './supabase.service';

describe('AuthService (offline / unconfigured project)', () => {
  let auth: AuthService;
  let originalDomain: string;

  /** A brand-new service instance for a given build-time configuration. */
  function freshAuth(domain: string): AuthService {
    environment.collegeEmailDomain = domain;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(AuthService);
  }

  beforeEach(() => {
    TestBed.configureTestingModule({});
    auth = TestBed.inject(AuthService);
    originalDomain = environment.collegeEmailDomain;
  });

  afterEach(() => {
    environment.collegeEmailDomain = originalDomain;
  });

  it('marks itself ready without touching the network when no keys are configured', () => {
    expect(TestBed.inject(SupabaseService).isConfigured).toBe(false);
    expect(auth.ready()).toBe(true);
  });

  it('ready is a signal (boolean), while whenReady is the promise guards await', async () => {
    // documents the API shape that caused the guard bug
    expect(typeof auth.ready()).toBe('boolean');
    await expect(auth.whenReady()).resolves.toBeUndefined();
  });

  it('resolves whenReady for repeated callers', async () => {
    await expect(Promise.all([auth.whenReady(), auth.whenReady(), auth.whenReady()])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('reports nobody as signed in', () => {
    expect(auth.isLoggedIn()).toBe(false);
    expect(auth.profile()).toBeNull();
    expect(auth.role()).toBeNull();
    expect(auth.isAdmin()).toBe(false);
  });

  it('never treats a signed-out visitor as an administrator', () => {
    expect(auth.isAdmin()).toBe(false);
    expect(auth.displayName()).toBe('Campus member');
  });

  describe('college e-mail rule (environment fallback)', () => {
    it('is exposed reactively for templates', () => {
      expect(auth.collegeDomain()).toBe(environment.collegeEmailDomain.trim().replace(/^@/, '').toLowerCase());
      expect(typeof auth.collegeDomainRequired()).toBe('boolean');
      expect(auth.collegeDomainRequired()).toBe(false); // nothing configured in the offline test env
    });

    it('accepts any address while the domain is left empty', () => {
      environment.collegeEmailDomain = '';
      expect(auth.isCollegeEmail('anyone@gmail.com')).toBe(true);
      expect(auth.isCollegeEmail('')).toBe(true);
    });

    it('accepts the configured college domain, case-insensitively', () => {
      environment.collegeEmailDomain = 'saintgits.org';
      expect(auth.isCollegeEmail('george@saintgits.org')).toBe(true);
      expect(auth.isCollegeEmail('GEORGE@SaintGits.ORG')).toBe(true);
      expect(auth.isCollegeEmail('  george@saintgits.org  ')).toBe(true);
    });

    it('rejects other domains, look-alike domains and partial matches', () => {
      environment.collegeEmailDomain = 'saintgits.org';
      expect(auth.isCollegeEmail('george@gmail.com')).toBe(false);
      expect(auth.isCollegeEmail('evil@notsaintgits.org')).toBe(false);
      expect(auth.isCollegeEmail('george@saintgits.org.attacker.com')).toBe(false);
      expect(auth.isCollegeEmail('george@saintgits.com')).toBe(false);
      expect(auth.isCollegeEmail('george@saintgits')).toBe(false);
    });

    it('normalises a domain that was written with an @ or capitals', () => {
      environment.collegeEmailDomain = '@SaintGits.org';
      expect(auth.collegeDomain()).toBe('saintgits.org');
      expect(auth.isCollegeEmail('george@saintgits.org')).toBe(true);
    });

    it('is configuration, not a hard-coded constant (a different build accepts a different domain)', () => {
      // Fresh service instances, because the domain is a *computed* signal: it is
      // cached until its source (the database signal, or this build-time value)
      // changes — which is exactly the behaviour we want, since the environment
      // file cannot change while the application is running.
      const first = freshAuth('campus-a.edu');
      expect(first.isCollegeEmail('me@campus-a.edu')).toBe(true);
      expect(first.isCollegeEmail('me@campus-b.edu')).toBe(false);

      const second = freshAuth('campus-b.edu');
      expect(second.isCollegeEmail('me@campus-a.edu')).toBe(false);
      expect(second.isCollegeEmail('me@campus-b.edu')).toBe(true);
    });
  });

  describe('database-driven college rule', () => {
    it('refreshing the rule never throws when Supabase is not configured', async () => {
      // the app falls back to the environment value instead of crashing
      await expect(auth.refreshCollegeDomain()).resolves.toBeUndefined();
      expect(auth.collegeDomain()).toBe(environment.collegeEmailDomain.trim().replace(/^@/, '').toLowerCase());
    });
  });
});

describe('SupabaseService.message()', () => {
  it('turns Row Level Security refusals into plain language', () => {
    expect(
      SupabaseService.message({ message: 'new row violates row-level security policy for table "items"' }),
    ).toBe('You are not allowed to do that.');
  });

  it('explains duplicate rows and network problems', () => {
    expect(SupabaseService.message({ message: 'duplicate key value violates unique constraint' })).toContain(
      'already exists',
    );
    expect(SupabaseService.message({ message: 'TypeError: Failed to fetch' })).toContain(
      'Cannot reach the server',
    );
  });

  it('explains the college-domain refusal raised by the database trigger', () => {
    expect(SupabaseService.message({ message: 'Only saintgits.org e-mail addresses may register.' })).toContain(
      'saintgits.org',
    );
    expect(SupabaseService.message({ message: 'Database error saving new user' })).toContain('college domain');
  });

  it('always returns something a student can read', () => {
    expect(SupabaseService.message({})).toBe('Something went wrong. Please try again.');
    expect(SupabaseService.message(undefined)).toBe('Something went wrong. Please try again.');
  });
});
