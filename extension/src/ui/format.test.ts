import { describe, expect, it } from 'vitest';
import { fmtClock, fmtDate, fmtEta, isWebUrl, jobProgress, sourceLabel } from './format';
import { withPart, withTimestamp } from '../core/filename';
import { normalizeSettings } from '../core/settings';

const base = { state: 'downloading', kind: 'file', bytes: 0, segmentsDone: 0, segmentsTotal: 0 };

describe('jobProgress', () => {
  it('uses bytes over total for plain files', () => {
    expect(jobProgress({ ...base, bytes: 200, bytesTotal: 500 })).toBeCloseTo(0.4);
  });
  it('is unknown for plain files without a total', () => {
    expect(jobProgress({ ...base, bytes: 200 })).toBeNull();
  });
  it('uses segments for HLS', () => {
    expect(jobProgress({ ...base, kind: 'hls', segmentsDone: 3, segmentsTotal: 12 })).toBeCloseTo(0.25);
  });
  it('is empty while queued and full while saving', () => {
    expect(jobProgress({ ...base, state: 'queued' })).toBe(0);
    expect(jobProgress({ ...base, kind: 'hls', state: 'saving' })).toBe(1);
  });
});

describe('format helpers', () => {
  it('labels a source by host and last path part', () => {
    expect(sourceLabel('https://cdn.example.com/a/b/master.m3u8?x=1')).toBe('cdn.example.com · master.m3u8');
  });
  it('formats time left', () => {
    expect(fmtEta(42)).toBe('42s left');
    expect(fmtEta(125)).toBe('2m 5s left');
    expect(fmtEta(NaN)).toBe('');
  });
});

describe('normalizeSettings', () => {
  it('defaults, rounds and clamps', () => {
    expect(normalizeSettings(undefined).maxConcurrent).toBe(2);
    expect(normalizeSettings({ maxConcurrent: '3' }).maxConcurrent).toBe(3);
    expect(normalizeSettings({ maxConcurrent: 0 }).maxConcurrent).toBe(1);
    expect(normalizeSettings({ maxConcurrent: 99 }).maxConcurrent).toBe(10);
    expect(normalizeSettings({}).thumbnails).toBe(true);
    expect(normalizeSettings({ thumbnails: false }).thumbnails).toBe(false);
    expect(normalizeSettings({ maxConcurrent: 'x' }).maxConcurrent).toBe(2);
  });
  it('keeps 25 archive entries by default and allows 0 to turn the archive off', () => {
    expect(normalizeSettings(undefined)).toEqual({ maxConcurrent: 2, archiveSize: 25, archivePrivate: false, thumbnails: true });
    expect(normalizeSettings({ archiveSize: 0 }).archiveSize).toBe(0);
    expect(normalizeSettings({ archiveSize: '40' }).archiveSize).toBe(40);
    expect(normalizeSettings({ archiveSize: 9999 }).archiveSize).toBe(500);
    expect(normalizeSettings({ archiveSize: -3 }).archiveSize).toBe(0);
    expect(normalizeSettings({ archiveSize: '' }).archiveSize).toBe(25);
    expect(normalizeSettings({ archiveSize: null }).archiveSize).toBe(25);
    expect(normalizeSettings({ archivePrivate: 'yes' }).archivePrivate).toBe(false);
    expect(normalizeSettings({ archivePrivate: true }).archivePrivate).toBe(true);
  });
});

describe('archive rows', () => {
  it('show the date without the time', () => {
    expect(fmtDate(new Date(2026, 9, 26, 10, 42).getTime(), 'en-US')).toBe('Oct 26, 2026');
  });
  it('link only web pages', () => {
    expect(isWebUrl('https://example.com/watch?v=1')).toBe(true);
    expect(isWebUrl('http://127.0.0.1:8787/hls-ts.html')).toBe(true);
    expect(isWebUrl('javascript:alert(1)')).toBe(false);
    expect(isWebUrl('file:///C:/x.html')).toBe(false);
    expect(isWebUrl('')).toBe(false);
  });
});

describe('live recordings', () => {
  it('have no percentage while recording', () => {
    expect(jobProgress({ ...base, kind: 'hls', live: true, segmentsDone: 5 })).toBeNull();
  });
  it('show the recorded length as a clock', () => {
    expect(fmtClock(42.7)).toBe('0:42');
    expect(fmtClock(725)).toBe('12:05');
    expect(fmtClock(3729)).toBe('1:02:09');
  });
  it('get the start time in the filename', () => {
    expect(withTimestamp('Harbor Cam [720p].mp4', new Date(2026, 9, 21, 15, 4))).toBe('Harbor Cam [720p] 2026-10-21 15.04.mp4');
  });
  it('number the parts of a recording saved in parts', () => {
    expect(withPart('Harbor Cam 2026-10-21 15.04.mp4', 2)).toBe('Harbor Cam 2026-10-21 15.04 part 2.mp4');
  });
});
