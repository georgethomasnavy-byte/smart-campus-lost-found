import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** 404 page for unknown URLs. */
@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <div class="row justify-content-center">
      <div class="col-md-8 col-lg-6 text-center py-5">
        <i class="bi bi-compass display-1 text-secondary"></i>
        <h1 class="display-6 mt-3">Page not found</h1>
        <p class="text-muted">
          The address you opened does not exist. It may be a typo, or the page was removed.
        </p>
        <div class="d-flex flex-wrap justify-content-center gap-2">
          <a class="btn btn-primary" routerLink="/">Back to home</a>
          <a class="btn btn-outline-danger" routerLink="/report-lost">Report a lost item</a>
          <a class="btn btn-outline-success" routerLink="/report-found">Report a found item</a>
        </div>
      </div>
    </div>
  `,
})
export class NotFoundComponent {}
