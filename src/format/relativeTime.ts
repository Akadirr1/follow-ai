/**
 * Turkish relative time.
 *
 * The DTO carries an ISO instant (`publishedAt`); the prototype showed "2 saat
 * önce" / "dün". P1 deliberately kept the label out of the DTO — presentation
 * belongs here — so this is the formatter that keeps prototype parity.
 *
 * Beyond a week a relative label stops being useful ("47 gün önce" tells nobody
 * anything), so it switches to an absolute Turkish date.
 */

const MONTHS_TR = [
  'Ocak',
  'Şubat',
  'Mart',
  'Nisan',
  'Mayıs',
  'Haziran',
  'Temmuz',
  'Ağustos',
  'Eylül',
  'Ekim',
  'Kasım',
  'Aralık',
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Past this age, show the date instead of a relative label. */
export const ABSOLUTE_AFTER_DAYS = 7;

/** "20 Ağustos" — same year; "20 Ağustos 2025" — any other year. */
export function absoluteTr(date: Date, now: Date): string {
  const day = date.getDate();
  const month = MONTHS_TR[date.getMonth()];
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${month}`
    : `${day} ${month} ${date.getFullYear()}`;
}

/**
 * Format an ISO instant relative to `now`.
 *
 * An unparseable value returns an empty string and warns: a card with no
 * timestamp is survivable, a card reading "NaN saat önce" is not.
 */
export function relativeTimeTr(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const thenMs = then.getTime();
  if (Number.isNaN(thenMs)) {
    console.warn(`[relativeTime] "${iso}" is not a parseable instant.`);
    return '';
  }

  const elapsed = now.getTime() - thenMs;

  // A clock skew or a future publish date is not worth a wrong label.
  if (elapsed < 0) return 'az önce';
  if (elapsed < MINUTE) return 'az önce';

  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)} dakika önce`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)} saat önce`;
  }

  const days = Math.floor(elapsed / DAY);
  if (days === 1) return 'dün';
  if (days <= ABSOLUTE_AFTER_DAYS) return `${days} gün önce`;

  return absoluteTr(then, now);
}
