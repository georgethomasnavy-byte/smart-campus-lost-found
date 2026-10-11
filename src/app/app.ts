import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Root component — everything real lives in the routed pages.
 * `app.routes.ts` wires 21 screens behind auth/admin/guest guards.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {}
