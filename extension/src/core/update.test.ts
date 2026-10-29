import { describe, expect, it } from 'vitest';
import { CHECK_EVERY, RETRY_EVERY, checkDue, isNewer, normalizeUpdate, parseVersionFile, updateFor } from './update';

describe('isNewer', () => {
  it('compares each part as a number', () => {
    expect(isNewer('0.5.1', '0.5.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.5.0', '0.5.0')).toBe(false);
    expect(isNewer('0.4.9', '0.5.0')).toBe(false);
  });
  it('ignores a suffix and refuses what it cannot read', () => {
    expect(isNewer('0.6.0', '0.5.0 preview')).toBe(true);
    expect(isNewer('0.6', '0.5.0')).toBe(false);
    expect(isNewer('', '0.5.0')).toBe(false);
  });
});

describe('parseVersionFile', () => {
  it('takes a plain three part version and nothing else', () => {
    expect(parseVersionFile({ version: '0.5.1' })).toBe('0.5.1');
    expect(parseVersionFile({ version: '0.5.1-beta' })).toBeNull();
    expect(parseVersionFile({ version: 5 })).toBeNull();
    expect(parseVersionFile('0.5.1')).toBeNull();
    expect(parseVersionFile(null)).toBeNull();
  });
});

describe('update state', () => {
  it('fills gaps and drops junk', () => {
    expect(normalizeUpdate(undefined)).toEqual({ checkedAt: 0, ok: false, latest: null });
    expect(normalizeUpdate({ checkedAt: 5, ok: true, latest: '0.6.0' })).toEqual({ checkedAt: 5, ok: true, latest: '0.6.0' });
    expect(normalizeUpdate({ checkedAt: 'x', ok: 'yes', latest: '<b>' })).toEqual({ checkedAt: 0, ok: false, latest: null });
  });
  it('waits 12 hours after a good check and 30 minutes after a failed one', () => {
    const t = 1_000_000_000_000;
    expect(checkDue(normalizeUpdate(undefined), t)).toBe(true);
    expect(checkDue({ checkedAt: t, ok: true, latest: '0.5.0' }, t + CHECK_EVERY - 1)).toBe(false);
    expect(checkDue({ checkedAt: t, ok: true, latest: '0.5.0' }, t + CHECK_EVERY)).toBe(true);
    expect(checkDue({ checkedAt: t, ok: false, latest: null }, t + RETRY_EVERY)).toBe(true);
    expect(checkDue({ checkedAt: t, ok: true, latest: '0.5.0' }, t - 1)).toBe(true);
  });
  it('names a version only when it is newer than the installed one', () => {
    expect(updateFor({ checkedAt: 1, ok: true, latest: '0.6.0' }, '0.5.0')).toBe('0.6.0');
    expect(updateFor({ checkedAt: 1, ok: true, latest: '0.5.0' }, '0.5.0')).toBeNull();
    expect(updateFor({ checkedAt: 1, ok: true, latest: '0.5.0' }, '0.6.0')).toBeNull();
    expect(updateFor({ checkedAt: 1, ok: false, latest: null }, '0.5.0')).toBeNull();
  });
});
