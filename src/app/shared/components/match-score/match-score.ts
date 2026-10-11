import { Component, computed, input } from '@angular/core';
import type { MatchLevel } from '../../../core/models/common.model';
import { levelLabel, scoreToLevel } from '../../../core/matching/matching.engine';

/**
 * Match confidence chip.  Purely presentational: it derives its band from the
 * score using the same engine helper the algorithm uses, so the colour can
 * never disagree with the stored score.
 */
@Component({
  selector: 'app-match-score',
  template: `
    <span class="match-score {{ levelClass() }}" [title]="tooltip()">
      <i class="bi bi-bullseye"></i>
      {{ compact() ? '' : 'Match ' }}{{ score() }}%
    </span>
    @if (!compact()) {
      <div class="match-meter mt-2" role="img" [attr.aria-label]="'Match score ' + score() + ' percent'">
        <span [style.width.%]="score()"></span>
      </div>
    }
  `,
})
export class MatchScoreComponent {
  readonly score = input.required<number>();
  /** optional explicit level; otherwise it is derived from the score */
  readonly level = input<MatchLevel | null>(null);
  readonly compact = input(false);

  readonly resolvedLevel = computed(() => this.level() ?? scoreToLevel(this.score()));
  readonly levelClass = computed(() => `match-${this.resolvedLevel()}`);
  readonly tooltip = computed(() => `${levelLabel(this.resolvedLevel())} — ${this.score()} out of 100`);
}
