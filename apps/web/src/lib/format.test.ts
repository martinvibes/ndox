import { describe, expect, it } from 'vitest';
import {
  fmtDate,
  fmtEurFromFcfa,
  fmtFcfa,
  fmtM,
  fmtSat,
  fmtTime,
  hoursUntil,
  satToFcfaDisplay,
  shortHex,
} from './format';

// Intl uses narrow no-break spaces in fr-SN; compare on plain spaces.
const plain = (s: string) => s.replace(/\s/g, ' ');

describe('format', () => {
  it('formats FCFA and sats as integers with French grouping', () => {
    expect(plain(fmtFcfa(2000, 'fr'))).toBe('2 000 FCFA');
    expect(plain(fmtFcfa(38006805, 'fr'))).toBe('38 006 805 FCFA');
    expect(plain(fmtFcfa(2000, 'en'))).toBe('2,000 FCFA');
    expect(plain(fmtSat(5262, 'fr'))).toBe('5 262 sats');
    // the unit never wraps away from the number
    expect(fmtFcfa(2000, 'fr')).toContain(' FCFA');
  });

  it('shows the EUR equivalent at the fixed CFA parity', () => {
    expect(plain(fmtEurFromFcfa(2000, 'fr'))).toBe('3,05 €');
    expect(plain(fmtEurFromFcfa(10000, 'en'))).toBe('€15.24');
  });

  it('formats wave heights with two decimals and a dash when missing', () => {
    expect(plain(fmtM(2.81, 'fr'))).toBe('2,81 m');
    expect(plain(fmtM(2.5, 'en'))).toBe('2.50 m');
    expect(fmtM(null, 'fr')).toBe('—');
  });

  it('shows times in GMT whatever the browser time zone', () => {
    expect(plain(fmtTime('2026-11-20T05:15:00Z'))).toBe('05:15 GMT');
    expect(fmtDate('2026-11-19', 'fr', 'long')).toBe('jeudi 19 novembre 2026');
    expect(fmtDate('2026-02-27T23:30:00Z', 'en')).toBe('27 Feb 2026');
  });

  it('helpers', () => {
    expect(shortHex('a'.repeat(64))).toBe('aaaaaaaa…aaaa');
    expect(shortHex('abc')).toBe('abc');
    expect(satToFcfaDisplay(5262, 38_006_805)).toBe(1999);
    expect(hoursUntil('2026-11-22T12:00:00Z', Date.parse('2026-11-19T12:30:00Z'))).toBe(72);
    expect(hoursUntil('2026-11-19T12:00:00Z', Date.parse('2026-11-20T12:00:00Z'))).toBe(0);
  });
});
