import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { ItemCategory } from '../../../core/models/database.types';
import { ITEM_CATEGORIES } from '../../../core/models/database.types';
import type { ItemWithReporter } from '../../../core/models/database.types';
import { AuthService } from '../../../core/services/auth.service';
import { ItemsService } from '../../../core/services/items.service';
import { MatchingService } from '../../../core/services/matching.service';
import { StorageService, ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from '../../../core/services/storage.service';
import { MIN_MATCH_SCORE, NOTIFY_FROM_SCORE } from '../../../core/matching/matching.config';
import { ToastService } from '../../../core/services/toast.service';
import { MatchScoreComponent } from '../../../shared/components/match-score/match-score';
import { StatusBadgeComponent } from '../../../shared/components/status-badge/status-badge';

type ReportType = 'lost' | 'found';

/** One step of the submit pipeline, shown live to the user. */
interface PipelineStep {
  label: string;
  state: 'idle' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
}

/**
 * Report form used for both "Report Lost Item" and "Report Found Item"
 * (spec §15–16).
 *
 * The submit pipeline is deliberately explicit so nothing happens silently:
 *   1 validate the form → 2 validate the photo → 3 confirm the session →
 *   4 upload the photo → 5 insert the report → 6 run the matching algorithm →
 *   7 store the matches → 8 notify both sides for qualifying scores → 9 log the activity →
 *   10 show the result.
 *
 * Steps 7–9 happen inside PostgreSQL triggers, so they cannot be skipped by a
 * client that is closed mid-way.
 */
@Component({
  selector: 'app-report-item',
  imports: [FormsModule, RouterLink, StatusBadgeComponent, MatchScoreComponent],
  templateUrl: './report-item.html',
})
export class ReportItemComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly items = inject(ItemsService);
  private readonly matches = inject(MatchingService);
  private readonly storage = inject(StorageService);
  private readonly toast = inject(ToastService);
  readonly auth = inject(AuthService);

  readonly categories = ITEM_CATEGORIES;
  readonly maxBytes = MAX_IMAGE_BYTES;
  readonly today = new Date().toISOString().slice(0, 10);

  readonly type = signal<ReportType>('lost');
  readonly title = signal('');
  readonly category = signal<ItemCategory>('Other');
  readonly description = signal('');
  readonly location = signal('');
  readonly keywords = signal('');
  readonly identifyingCharacteristics = signal('');
  readonly collectionInstructions = signal('');
  readonly exactFoundLocation = signal('');
  readonly dateOccurred = signal(this.today);
  readonly imageFile = signal<File | null>(null);
  readonly imagePreview = signal<string | null>(null);

  readonly busy = signal(false);
  readonly steps = signal<PipelineStep[]>([]);
  readonly createdItem = signal<ItemWithReporter | null>(null);
  readonly matchCount = signal(0);
  readonly notificationCount = signal(0);
  readonly notificationThreshold = NOTIFY_FROM_SCORE;
  readonly bestScore = signal(0);

  readonly isLost = computed(() => this.type() === 'lost');
  readonly heading = computed(() => (this.isLost() ? 'Report a lost item' : 'Report a found item'));
  readonly canSubmit = computed(
    () =>
      this.auth.isLoggedIn() &&
      this.title().trim().length >= 3 &&
      this.description().trim().length >= 10 &&
      this.description().trim().length <= 2000 &&
      this.location().trim().length >= 2 &&
      this.location().trim().length <= 120 &&
      this.keywords().trim().length <= 250 &&
      this.identifyingCharacteristics().trim().length <= 500 &&
      (this.isLost() || (
        this.collectionInstructions().trim().length >= 10 &&
        this.collectionInstructions().trim().length <= 500 &&
        this.exactFoundLocation().trim().length >= 3 &&
        this.exactFoundLocation().trim().length <= 300
      )) &&
      !!this.dateOccurred(),
  );

  ngOnInit(): void {
    this.type.set((this.route.snapshot.data['type'] as ReportType) ?? 'lost');
    this.resetSteps();
  }

  private resetSteps(): void {
    this.steps.set([
      { label: 'Validate the form', state: 'idle' },
      { label: 'Validate the photo', state: 'idle' },
      { label: 'Confirm your session', state: 'idle' },
      { label: 'Upload the photo', state: 'idle' },
      { label: 'Save the report', state: 'idle' },
      { label: 'Run the matching algorithm', state: 'idle' },
      { label: 'Store the matches', state: 'idle' },
      { label: 'Persist notifications for eligible matches', state: 'idle' },
      { label: 'Write the activity log', state: 'idle' },
      { label: 'Show the result', state: 'idle' },
    ]);
  }

  private setStep(index: number, state: PipelineStep['state'], detail?: string): void {
    this.steps.update((list) =>
      list.map((step, position) => (position === index ? { ...step, state, detail } : step)),
    );
  }

  /* ------------------------------------------------------------------ */
  /* photo                                                              */
  /* ------------------------------------------------------------------ */

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;

    if (!file) {
      this.clearImage();
      return;
    }

    const check = this.storage.validate(file);
    if (!check.ok) {
      this.toast.error(check.message);
      input.value = '';
      this.clearImage();
      return;
    }

    this.imageFile.set(file);
    void this.buildPreview(file);
  }

  private async buildPreview(file: File): Promise<void> {
    const reader = new FileReader();
    reader.onload = () => this.imagePreview.set(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(file);
  }

  clearImage(): void {
    this.imageFile.set(null);
    this.imagePreview.set(null);
  }

  formatBytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }

  allowedTypes(): string {
    return ALLOWED_IMAGE_TYPES.map((type) => type.replace('image/', '')).join(', ');
  }

  /* ------------------------------------------------------------------ */
  /* submit pipeline                                                    */
  /* ------------------------------------------------------------------ */

  async submit(): Promise<void> {
    if (this.busy()) {
      return;
    }

    this.createdItem.set(null);
    this.matchCount.set(0);
    this.notificationCount.set(0);
    this.bestScore.set(0);
    this.resetSteps();
    this.busy.set(true);

    // ---- step 1: validate the form ----
    this.setStep(0, 'running');
    if (!this.canSubmit()) {
      this.setStep(0, 'failed', 'Some required details are missing, too long or too short.');
      this.busy.set(false);
      this.toast.error(this.isLost()
        ? 'Enter a 3+ character name, 10–2000 character description and general location.'
        : 'Add the item details, public collection instructions and private exact found location before publishing.');
      return;
    }
    this.setStep(0, 'done');

    // ---- step 2: validate the photo ----
    this.setStep(1, 'running');
    const file = this.imageFile();
    if (file) {
      const check = this.storage.validate(file);
      if (!check.ok) {
        this.setStep(1, 'failed', check.message);
        this.busy.set(false);
        this.toast.error(check.message);
        return;
      }
      this.setStep(1, 'done', `${file.name} · ${this.formatBytes(file.size)}`);
    } else {
      this.setStep(1, 'skipped', 'No photo attached (photos are optional).');
    }

    // ---- step 3: confirm the session ----
    this.setStep(2, 'running');
    const profile = this.auth.profile();
    if (!profile) {
      this.setStep(2, 'failed', 'No active session.');
      this.busy.set(false);
      this.toast.error('Your session has expired — please log in again.');
      return;
    }
    this.setStep(2, 'done', `Signed in as ${profile.full_name}`);

    // ---- step 4: upload the photo ----
    let uploaded: { url: string; path: string } | null = null;
    this.setStep(3, 'running');
    if (file) {
      try {
        uploaded = await this.storage.uploadItemImage(file, profile.user_id);
        this.setStep(3, 'done', 'Photo stored in the item-images bucket.');
      } catch (caught) {
        this.setStep(3, 'failed', caught instanceof Error ? caught.message : 'Upload failed.');
        this.busy.set(false);
        this.toast.error('The photo could not be uploaded. You can try again or submit without a photo.');
        return;
      }
    } else {
      this.setStep(3, 'skipped');
    }

    // ---- step 5: save the report ----
    let created: Awaited<ReturnType<ItemsService['create']>>;
    this.setStep(4, 'running');
    try {
      created = await this.items.create(
        {
          type: this.type(),
          title: this.title().trim(),
          category: this.category(),
          description: this.description().trim(),
          location: this.location().trim(),
          date_occurred: this.dateOccurred(),
          keywords: this.keywords().trim(),
          identifying_characteristics: this.identifyingCharacteristics().trim(),
          collection_instructions: this.isLost() ? null : this.collectionInstructions().trim(),
          exact_found_location: this.isLost() ? null : this.exactFoundLocation().trim(),
        },
        uploaded,
      );
      this.setStep(4, 'done', `Report saved (status: active, verification: pending).`);
    } catch (caught) {
      this.setStep(4, 'failed', caught instanceof Error ? caught.message : 'Insert failed.');
      if (uploaded) {
        await this.storage.removeItemImage(uploaded.path);
      }
      this.busy.set(false);
      this.toast.error(caught instanceof Error ? caught.message : 'Could not save the report.');
      return;
    }

    // ---- step 6: run the matching algorithm ----
    this.setStep(5, 'running');
    let suggestions: Awaited<ReturnType<MatchingService['runForItem']>> = [];
    let matchingFailed = false;
    try {
      suggestions = await this.matches.runForItem(created);
      this.setStep(
        5,
        'done',
        `${suggestions.length} candidate(s) above ${MIN_MATCH_SCORE}% · best ${this.bestOf(suggestions)}%`,
      );
      this.matchCount.set(suggestions.length);
      this.notificationCount.set(suggestions.filter((match) => match.score >= NOTIFY_FROM_SCORE).length);
      this.bestScore.set(this.bestOf(suggestions));
    } catch (caught) {
      // Keep the already-saved report, but do not claim that matching or
      // notifications succeeded when the database write failed.
      matchingFailed = true;
      this.setStep(5, 'failed', caught instanceof Error ? caught.message : 'Matching failed.');
    }

    // ---- steps 7-9: triggers inside the database ----
    if (matchingFailed) {
      this.setStep(6, 'failed', 'Matching results could not be persisted; edit the report to retry.');
      this.setStep(7, 'skipped', 'No notification success is claimed because no match was stored.');
    } else {
      this.setStep(6, 'done', 'Matching results persisted; duplicate pairs are ignored by the database.');
      this.setStep(
        7,
        this.notificationCount() > 0 ? 'done' : 'skipped',
        this.notificationCount() > 0
          ? `The database created notifications for ${this.notificationCount()} match(es) scoring ${NOTIFY_FROM_SCORE}% or higher.`
          : `No notification was sent because no new stored match reached ${NOTIFY_FROM_SCORE}%.`,
      );
    }
    this.setStep(8, 'done', 'Entry written to the append-only activity log.');

    // ---- step 10: result ----
    this.setStep(9, 'done');
    const hydrated = await this.items.getById(created.id);
    this.createdItem.set(hydrated);
    this.busy.set(false);

    if (matchingFailed) {
      this.toast.warning('Report published, but matching could not be saved. Your report is safe; edit it later to retry matching.');
    } else if (suggestions.length) {
      this.toast.success(`Report published — ${suggestions.length} possible match(es) found.`);
    } else {
      this.toast.success('Report published. Matching is ready for future reports.');
    }
  }

  private bestOf(rows: Array<{ score: number }>): number {
    return rows.reduce((best, row) => Math.max(best, row.score), 0);
  }

  submitAnother(): void {
    this.title.set('');
    this.category.set('Other');
    this.description.set('');
    this.location.set('');
    this.keywords.set('');
    this.identifyingCharacteristics.set('');
    this.collectionInstructions.set('');
    this.exactFoundLocation.set('');
    this.dateOccurred.set(this.today);
    this.clearImage();
    this.createdItem.set(null);
    this.matchCount.set(0);
    this.notificationCount.set(0);
    this.bestScore.set(0);
    this.resetSteps();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async goToMatches(): Promise<void> {
    await this.router.navigate(['/matches']);
  }

  stepIcon(state: PipelineStep['state']): string {
    switch (state) {
      case 'done':
        return 'bi-check-circle-fill text-success';
      case 'failed':
        return 'bi-x-circle-fill text-danger';
      case 'running':
        return 'bi-arrow-repeat text-primary';
      case 'skipped':
        return 'bi-dash-circle text-secondary';
      default:
        return 'bi-circle text-secondary opacity-50';
    }
  }
}
