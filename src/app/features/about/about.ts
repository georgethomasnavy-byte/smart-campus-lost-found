import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MATCH_LEVELS, MATCH_WEIGHTS } from '../../core/matching/matching.config';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/services/auth.service';

/** Public explanation page: purpose, workflow, algorithm and safeguards. */
@Component({
  selector: 'app-about',
  imports: [RouterLink],
  templateUrl: './about.html',
})
export class AboutComponent {
  private readonly auth = inject(AuthService);

  readonly weights = MATCH_WEIGHTS;

  /** Bands rendered as "90–100 · Very strong match" straight from the config. */
  readonly levels = MATCH_LEVELS.map((band, index) => ({
    ...band,
    max: index === 0 ? 100 : MATCH_LEVELS[index - 1].min - 1,
    hint: {
      'very-strong': 'Very strong similarity — relevant campus members are notified.',
      strong: 'Strong similarity — highlighted in the matches list.',
      possible: 'Worth checking — open both reports and compare.',
      low: 'Weak similarity; recorded but not notified.',
      'no-match': 'Ignored completely: never stored, never notified.',
    }[band.level],
  }));
  readonly appName = environment.appName;
  /** Live college e-mail rule (read from the database). */
  readonly collegeDomain = computed(() => this.auth.collegeDomain() || null);

  readonly steps = [
    { icon: 'bi-person-plus', title: 'Register', text: 'Students, faculty and staff select a campus role. Admin rights are never self-selected and are assigned separately.' },
    { icon: 'bi-pencil-square', title: 'Report', text: 'Add public item details, keywords and a photo. Found reports keep exact find location private and show separate public collection instructions.' },
    { icon: 'bi-bullseye', title: 'Match', text: 'The rule-based engine compares public lost and found details and explains its score out of 100.' },
    { icon: 'bi-bell', title: 'Notify', text: 'Relevant reporters receive deduplicated in-app notifications; private claim evidence is never included.' },
    { icon: 'bi-clipboard-check', title: 'Claim', text: 'A claimant privately describes ownership and where they believe the item was lost.' },
    { icon: 'bi-patch-check', title: 'Review and hand over', text: 'An administrator decides ownership. The finder separately confirms the physical handover before the item is marked returned.' },
  ];
}
