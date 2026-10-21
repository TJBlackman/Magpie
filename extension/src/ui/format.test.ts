import { describe, expect, it } from 'vitest';
import { fmtEta, jobProgress, sourceLabel } from './format';
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
  it('is empty while queued and full when done', () => {
    expect(jobProgress({ ...base, state: 'queued' })).toBe(0);
    expect(jobProgress({ ...base, state: 'done' })).toBe(1);
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
    expect(normalizeSettings({ maxConcurrent: 'x' }).maxConcurrent).toBe(2);
  });
});
