import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-footer',
  imports: [RouterLink],
  template: `
    <footer class="site-footer mt-auto">
      <div class="container py-5">
        <div class="row g-4">
          <div class="col-lg-5">
            <div class="d-flex align-items-center gap-2 mb-3">
              <span class="brand-badge"><i class="bi bi-search"></i></span>
              <span class="fw-bold text-white">{{ appName }}</span>
            </div>
            <p class="mb-3 footer-muted">
              One searchable place for everything lost and found on campus — reporting, automatic
              matching, verified claims and a full audit trail.
            </p>
            <p class="mb-0 footer-muted small">
              <i class="bi bi-envelope me-1"></i>Lost &amp; Found desk:
              <a [href]="'mailto:' + supportEmail">{{ supportEmail }}</a>
            </p>
          </div>

          <div class="col-6 col-lg-2">
            <h3 class="footer-heading">Browse</h3>
            <ul class="list-unstyled footer-links mb-0">
              <li><a routerLink="/lost-items">Lost items</a></li>
              <li><a routerLink="/found-items">Found items</a></li>
              <li><a routerLink="/search">Search</a></li>
              <li><a routerLink="/about">How it works</a></li>
            </ul>
          </div>

          <div class="col-6 col-lg-2">
            <h3 class="footer-heading">Account</h3>
            <ul class="list-unstyled footer-links mb-0">
              @if (auth.isLoggedIn()) {
                <li><a routerLink="/dashboard">My dashboard</a></li>
                <li><a routerLink="/matches">Possible matches</a></li>
                <li><a routerLink="/my-claims">My claims</a></li>
                <li><a routerLink="/notifications">Notifications</a></li>
              } @else {
                <li><a routerLink="/login">Log in</a></li>
                <li><a routerLink="/register">Create an account</a></li>
                <li><a routerLink="/forgot-password">Forgot password</a></li>
              }
            </ul>
          </div>

          <div class="col-lg-3">
            <h3 class="footer-heading">Good to know</h3>
            <ul class="list-unstyled footer-muted small mb-0">
              <li class="mb-2"><i class="bi bi-shield-check me-2"></i>Row Level Security protects every report.</li>
              
              <li class="mb-2"><i class="bi bi-coin me-2"></i>Runs entirely on free tiers.</li>
              @if (auth.collegeDomain()) {
                <li><i class="bi bi-mortarboard me-2"></i>Campus members only: <strong>&#64;{{ auth.collegeDomain() }}</strong></li>
              }
            </ul>
          </div>
        </div>
      </div>

      <div class="footer-bottom">
        <div class="container d-flex flex-wrap justify-content-between gap-2 py-3">
          <span>© {{ year }} {{ appName }}. All rights reserved.</span>
          
        </div>
      </div>
    </footer>
  `,
})
export class FooterComponent {
  readonly auth = inject(AuthService);
  readonly appName = environment.appName;
  readonly supportEmail = environment.supportEmail;
  readonly year = new Date().getFullYear();
}
