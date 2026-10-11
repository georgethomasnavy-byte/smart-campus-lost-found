import { Component, computed, input } from '@angular/core';

/**
 * One badge component for every status in the system, so colours stay
 * consistent everywhere (lost / found / pending / matched / claimed /
 * returned / rejected / verified / approved …).
 */
@Component({
  selector: 'app-status-badge',
  template: `<span class="status-badge" [class]="cssClass()">
    @if (icon()) { <i class="bi {{ icon() }}"></i> }
    {{ label() }}
  </span>`,
})
export class StatusBadgeComponent {
  readonly status = input.required<string>();

  private static readonly LABELS: Record<string, string> = {
    lost: 'Lost', found: 'Found', active: 'Active', matched: 'Matched',
    claimed: 'Claimed', returned: 'Returned', closed: 'Closed', rejected: 'Rejected',
    pending: 'Pending', verified: 'Verified', approved: 'Approved', cancelled: 'Cancelled',
    suggested: 'Suggested', dismissed: 'Dismissed', accepted: 'Accepted',
    reviewed: 'Reviewed', actioned: 'Actioned',
  };

  private static readonly ICONS: Record<string, string> = {
    lost: 'bi-question-circle', found: 'bi-hand-thumbs-up', returned: 'bi-check2-circle',
    verified: 'bi-patch-check', approved: 'bi-check2-circle', rejected: 'bi-x-circle',
    pending: 'bi-hourglass-split', claimed: 'bi-person-check', matched: 'bi-link-45deg',
    active: 'bi-broadcast', closed: 'bi-lock', cancelled: 'bi-slash-circle',
    suggested: 'bi-lightbulb', dismissed: 'bi-eye-slash', accepted: 'bi-check2',
    reviewed: 'bi-eye', actioned: 'bi-shield-exclamation',
  };

  readonly label = computed(() => StatusBadgeComponent.LABELS[this.status()] ?? this.status());
  readonly icon = computed(() => StatusBadgeComponent.ICONS[this.status()] ?? '');
  readonly cssClass = computed(() => `status-${this.status()}`);
}
