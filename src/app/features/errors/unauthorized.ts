import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

/** 403 page — shown when a student reaches an administrator-only URL. */
@Component({
  selector: 'app-unauthorized',
  imports: [RouterLink],
  template: `
    <div class="row justify-content-center">
      <div class="col-md-8 col-lg-6 text-center py-5">
        <i class="bi bi-shield-lock display-1 text-danger"></i>
        <h1 class="h3 mt-3">Administrator access required</h1>
        <p class="text-muted">
          This area is restricted to the Lost &amp; Found desk. Your account
          ({{ auth.profile()?.email ?? 'signed out' }}) is a
          <strong>{{ auth.isAdmin() ? 'administrator' : auth.profile()?.campus_role ?? 'campus member' }}</strong> account.
        </p>
        <p class="text-muted small">
          Row Level Security blocks administrator data at the database level too — even if these buttons were
          bypassed, the server would return nothing.
        </p>
        <div class="d-flex flex-wrap justify-content-center gap-2">
          <a class="btn btn-primary" routerLink="/dashboard">Go to my dashboard</a>
          <a class="btn btn-outline-secondary" routerLink="/found-items">Browse found items</a>
          <a class="btn btn-link" routerLink="/">Home</a>
        </div>
      </div>
    </div>
  `,
})
export class UnauthorizedComponent {
  readonly auth = inject(AuthService);
}
