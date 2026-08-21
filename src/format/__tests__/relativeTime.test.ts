import { ABSOLUTE_AFTER_DAYS, absoluteTr, relativeTimeTr } from '../relativeTime';

/**
 * The formatter that replaces the prototype's hard-coded "2 saat önce" labels
 * now that the DTO carries an ISO instant (P1 decision 2).
 */

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTimeTr', () => {
  it.each([
    ['30 seconds', 30 * SECOND, 'az önce'],
    ['1 minute', MINUTE, '1 dakika önce'],
    ['45 minutes', 45 * MINUTE, '45 dakika önce'],
    ['1 hour', HOUR, '1 saat önce'],
    ['2 hours', 2 * HOUR, '2 saat önce'],
    ['8 hours', 8 * HOUR, '8 saat önce'],
    ['23 hours', 23 * HOUR, '23 saat önce'],
    ['1 day', DAY, 'dün'],
    ['2 days', 2 * DAY, '2 gün önce'],
    ['3 days', 3 * DAY, '3 gün önce'],
    ['7 days', 7 * DAY, '7 gün önce'],
  ])('%s ago → %p', (_label, elapsed, expected) => {
    expect(relativeTimeTr(ago(elapsed), NOW)).toBe(expected);
  });

  it('switches to an absolute date past a week', () => {
    // 8 days before 20 August 2026 is 12 August 2026.
    expect(relativeTimeTr(ago(8 * DAY), NOW)).toBe('12 Ağustos');
    expect(ABSOLUTE_AFTER_DAYS).toBe(7);
  });

  it('includes the year for a different year', () => {
    expect(relativeTimeTr('2025-03-04T09:00:00.000Z', NOW)).toBe('4 Mart 2025');
  });

  it('reproduces the prototype labels the fixtures used', () => {
    // The mock fixtures are anchored at 2026-08-20T06:41Z, and the prototype
    // showed "2 saat önce" / "dün" for exactly these offsets.
    const anchor = new Date('2026-08-20T06:41:00.000Z');
    expect(relativeTimeTr(new Date(anchor.getTime() - 2 * HOUR).toISOString(), anchor)).toBe(
      '2 saat önce',
    );
    expect(relativeTimeTr(new Date(anchor.getTime() - DAY).toISOString(), anchor)).toBe('dün');
  });

  it('does not produce a negative label for a future instant', () => {
    expect(relativeTimeTr(new Date(NOW.getTime() + HOUR).toISOString(), NOW)).toBe('az önce');
  });

  it('warns and returns an empty label for an unparseable value', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(relativeTimeTr('not-a-date', NOW)).toBe('');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not-a-date'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('absoluteTr', () => {
  it('omits the year within the current year', () => {
    expect(absoluteTr(new Date('2026-01-09T00:00:00.000Z'), NOW)).toBe('9 Ocak');
  });

  it('keeps the Turkish month names', () => {
    const months = Array.from({ length: 12 }, (_, i) =>
      absoluteTr(new Date(Date.UTC(2026, i, 15)), NOW),
    );
    expect(months).toEqual([
      '15 Ocak', '15 Şubat', '15 Mart', '15 Nisan', '15 Mayıs', '15 Haziran',
      '15 Temmuz', '15 Ağustos', '15 Eylül', '15 Ekim', '15 Kasım', '15 Aralık',
    ]);
  });
});
