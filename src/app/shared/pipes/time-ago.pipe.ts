import { Pipe, type PipeTransform } from '@angular/core';

/** "3 hours ago" — used by notifications, listings and the activity log. */
@Pipe({ name: 'timeAgo' })
export class TimeAgoPipe implements PipeTransform {
  transform(value: string | Date | null | undefined): string {
    if (!value) {
      return '';
    }
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
    if (Number.isNaN(timestamp)) {
      return '';
    }

    const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
    const units: Array<[string, number]> = [
      ['year', 31536000],
      ['month', 2592000],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
    ];

    for (const [unit, secondsInUnit] of units) {
      const amount = Math.floor(seconds / secondsInUnit);
      if (amount >= 1) {
        return `${amount} ${unit}${amount > 1 ? 's' : ''} ago`;
      }
    }
    return 'just now';
  }
}
