import type { Routes } from '@angular/router';
import { adminGuard, authGuard, guestGuard } from './core/guards/auth.guard';
import { MainLayoutComponent } from './layout/main-layout/main-layout';

/**
 * Application routes (spec §12 — 21 pages).
 *
 * Structure:
 *   • one shell (MainLayoutComponent) with the navbar, footer and overlays
 *   • public pages          — anyone
 *   • auth pages            — guests only (a logged-in user is sent to /dashboard)
 *   • student pages         — authGuard
 *   • administrator pages   — authGuard + adminGuard (and RLS on the server)
 *   • 404 fallback
 *
 * Every feature is lazy-loaded with `loadComponent`, so the first paint is small.
 */
export const routes: Routes = [
  {
    path: '',
    component: MainLayoutComponent,
    children: [
      /* --------------------------- public --------------------------- */
      {
        path: '',
        title: 'Smart Campus Lost & Found',
        loadComponent: () => import('./features/home/home').then((m) => m.HomeComponent),
      },
      {
        path: 'about',
        title: 'How it works · Smart Campus Lost & Found',
        loadComponent: () => import('./features/about/about').then((m) => m.AboutComponent),
      },
      {
        path: 'lost-items',
        title: 'Lost items · Smart Campus Lost & Found',
        data: { mode: 'lost' },
        loadComponent: () => import('./features/items/item-list/item-list').then((m) => m.ItemListComponent),
      },
      {
        path: 'found-items',
        title: 'Found items · Smart Campus Lost & Found',
        data: { mode: 'found' },
        loadComponent: () => import('./features/items/item-list/item-list').then((m) => m.ItemListComponent),
      },
      {
        path: 'search',
        title: 'Search · Smart Campus Lost & Found',
        data: { mode: 'all' },
        loadComponent: () => import('./features/items/item-list/item-list').then((m) => m.ItemListComponent),
      },
      {
        path: 'items/:id',
        title: 'Item details · Smart Campus Lost & Found',
        loadComponent: () => import('./features/items/item-detail/item-detail').then((m) => m.ItemDetailComponent),
      },

      /* ---------------------------- auth ---------------------------- */
      {
        path: 'login',
        title: 'Log in · Smart Campus Lost & Found',
        canActivate: [guestGuard],
        loadComponent: () => import('./features/auth/login/login').then((m) => m.LoginComponent),
      },
      {
        path: 'register',
        title: 'Create an account · Smart Campus Lost & Found',
        canActivate: [guestGuard],
        loadComponent: () => import('./features/auth/register/register').then((m) => m.RegisterComponent),
      },
      {
        path: 'forgot-password',
        title: 'Reset your password · Smart Campus Lost & Found',
        loadComponent: () =>
          import('./features/auth/forgot-password/forgot-password').then((m) => m.ForgotPasswordComponent),
      },

      /* --------------------------- student --------------------------- */
      {
        path: 'dashboard',
        title: 'My dashboard · Smart Campus Lost & Found',
        canActivate: [authGuard],
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.DashboardComponent),
      },
      {
        path: 'report-lost',
        title: 'Report a lost item · Smart Campus Lost & Found',
        canActivate: [authGuard],
        data: { type: 'lost' },
        loadComponent: () => import('./features/items/report-item/report-item').then((m) => m.ReportItemComponent),
      },
      {
        path: 'report-found',
        title: 'Report a found item · Smart Campus Lost & Found',
        canActivate: [authGuard],
        data: { type: 'found' },
        loadComponent: () => import('./features/items/report-item/report-item').then((m) => m.ReportItemComponent),
      },
      {
        path: 'my-reports',
        title: 'My reports · Smart Campus Lost & Found',
        canActivate: [authGuard],
        loadComponent: () => import('./features/items/my-reports/my-reports').then((m) => m.MyReportsComponent),
      },
      {
        path: 'matches',
        title: 'Possible matches · Smart Campus Lost & Found',
        canActivate: [authGuard],
        loadComponent: () => import('./features/matches/matches').then((m) => m.MatchesComponent),
      },
      {
        path: 'my-claims',
        title: 'My claims · Smart Campus Lost & Found',
        canActivate: [authGuard],
        loadComponent: () => import('./features/claims/my-claims/my-claims').then((m) => m.MyClaimsComponent),
      },
      {
        path: 'notifications',
        title: 'Notifications · Smart Campus Lost & Found',
        canActivate: [authGuard],
        loadComponent: () =>
          import('./features/notifications/notifications').then((m) => m.NotificationsComponent),
      },
      {
        path: 'profile',
        title: 'My profile · Smart Campus Lost & Found',
        canActivate: [authGuard],
        loadComponent: () => import('./features/profile/profile').then((m) => m.ProfileComponent),
      },

      /* ------------------------- administrator ------------------------- */
      {
        path: 'admin',
        title: 'Admin dashboard · Smart Campus Lost & Found',
        canActivate: [authGuard, adminGuard],
        loadComponent: () =>
          import('./features/admin/admin-dashboard/admin-dashboard').then((m) => m.AdminDashboardComponent),
      },
      {
        path: 'admin/items',
        title: 'Manage items · Smart Campus Lost & Found',
        canActivate: [authGuard, adminGuard],
        loadComponent: () => import('./features/admin/admin-items/admin-items').then((m) => m.AdminItemsComponent),
      },
      {
        path: 'admin/claims',
        title: 'Manage claims · Smart Campus Lost & Found',
        canActivate: [authGuard, adminGuard],
        loadComponent: () =>
          import('./features/admin/admin-claims/admin-claims').then((m) => m.AdminClaimsComponent),
      },
      {
        path: 'admin/users',
        title: 'Manage users · Smart Campus Lost & Found',
        canActivate: [authGuard, adminGuard],
        loadComponent: () =>
          import('./features/admin/admin-users/admin-users').then((m) => m.AdminUsersComponent),
      },
      {
        path: 'admin/reports',
        title: 'Abuse reports · Smart Campus Lost & Found',
        canActivate: [authGuard, adminGuard],
        loadComponent: () =>
          import('./features/admin/admin-reports/admin-reports').then((m) => m.AdminReportsComponent),
      },
      {
        path: 'admin/logs',
        title: 'Activity logs · Smart Campus Lost & Found',
        canActivate: [authGuard, adminGuard],
        loadComponent: () => import('./features/admin/admin-logs/admin-logs').then((m) => m.AdminLogsComponent),
      },

      /* --------------------------- errors --------------------------- */
      {
        path: 'unauthorized',
        title: 'Access denied · Smart Campus Lost & Found',
        loadComponent: () => import('./features/errors/unauthorized').then((m) => m.UnauthorizedComponent),
      },
      {
        path: '**',
        title: 'Page not found · Smart Campus Lost & Found',
        loadComponent: () => import('./features/errors/not-found').then((m) => m.NotFoundComponent),
      },
    ],
  },
];
