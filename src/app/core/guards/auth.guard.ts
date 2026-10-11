/**
 * Route guards.
 *
 * These are a convenience for the user, NOT the security boundary: the real
 * enforcement is Row Level Security in Postgres plus the `is_admin()` checks
 * inside the SQL functions.  A student who edits the JavaScript and opens
 * /admin by hand still cannot read a single admin row.
 */
import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/** Wait until the persisted session has been restored, then require a login. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  // `auth.whenReady()` waits for session restoration; `auth.ready()` would only
  // read the signal and let a page reload bounce a logged-in user to /login.
  await auth.whenReady();
  if (auth.isLoggedIn()) {
    return true;
  }

  return router.createUrlTree(['/login'], {
    queryParams: { redirect: state.url },
  });
};

/** Administrator-only routes. */
export const adminGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.whenReady();

  if (!auth.isLoggedIn()) {
    return router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });
  }
  if (auth.isAdmin()) {
    return true;
  }

  // Signed in but not an administrator: send them to their own dashboard.
  return router.createUrlTree(['/dashboard'], {
    queryParams: { denied: 'admin' },
  });
};

/** Keeps logged-in users away from /login and /register. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  await auth.whenReady();
  return auth.isLoggedIn() ? router.createUrlTree(['/dashboard']) : true;
};
