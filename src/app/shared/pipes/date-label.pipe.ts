import { Pipe, type PipeTransform } from '@angular/core';

/** "2026-03-05" or an ISO timestamp -> "05 Mar 2026". */
@Pipe({ name: 'dateLabel' })
export class DateLabelPipe implements PipeTransform {
  private static readonly MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  transform(value: string | null | undefined, withTime = false): string {
    if (!value) {
      return '—';
    }
    const iso = value.length === 10 ? `${value}T00:00:00` : value;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    const day = String(date.getDate()).padStart(2, '0');
    const month = DateLabelPipe.MONTHS[date.getMonth()];
    const year = date.getFullYear();
    const label = `${day} ${month} ${year}`;
    if (!withTime) {
      return label;
    }
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${label}, ${hours}:${minutes}`;
  }
}
