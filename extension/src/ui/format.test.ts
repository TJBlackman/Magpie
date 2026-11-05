import { describe, expect, it } from 'vitest';
import { codecNames, describeVariant, friendlyError, fmtApprox, fmtBytes, fmtRate, siteOf, fmtAgo, fmtBitrate, fmtEstimate, fmtClock, fmtDate, fmtDay, fmtEta, isWebUrl, jobProgress, nextRate, sourceLabel } from './format';
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
    expect(fmtEta(120)).toBe('2m left');
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
    expect(normalizeSettings(undefined)).toEqual({ maxConcurrent: 2, archiveSize: 25, archivePrivate: false, thumbnails: true, updateCheck: true, hideDownloaded: false });
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
  it('say how long ago media was downloaded the same day, then the day like History', () => {
    const now = new Date(2026, 10, 3, 12, 0).getTime();
    const ago = (ms: number) => fmtAgo(now - ms, now, 'en-US');
    expect(ago(20_000)).toBe('just now');
    expect(ago(12 * 60_000)).toBe('12m ago');
    expect(ago(5 * 3600_000 + 59 * 60_000)).toBe('5h ago');
    expect(fmtAgo(new Date(2026, 9, 25, 23, 0).getTime(), new Date(2026, 9, 26, 9, 0).getTime(), 'en-US')).toBe('yesterday');
    expect(fmtAgo(new Date(2026, 9, 20, 9, 0).getTime(), new Date(2026, 9, 26, 9, 0).getTime(), 'en-US')).toBe('Oct 20');
    expect(fmtAgo(new Date(2026, 8, 1, 9, 0).getTime(), now, 'en-US')).toBe('Sep 1');
    expect(fmtAgo(new Date(2025, 8, 1, 9, 0).getTime(), now, 'en-US')).toBe('Sep 1, 2025');
    // A clock that moved back never says "-2m ago".
    expect(fmtAgo(now + 120_000, now)).toBe('just now');
  });
  it('hide downloaded media only when asked', () => {
    expect(normalizeSettings({ hideDownloaded: true }).hideDownloaded).toBe(true);
    expect(normalizeSettings({ hideDownloaded: 'yes' }).hideDownloaded).toBe(false);
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

describe('nextRate', () => {
  it('starts at zero and takes the first sample as is', () => {
    const a = nextRate(null, 1000, 0);
    expect(a.rate).toBe(0);
    const b = nextRate(a, 2000, 500);
    expect(b.rate).toBe(2000);
  });
  it('smooths later samples', () => {
    const a = nextRate(nextRate(null, 0, 0), 1000, 1000);
    const b = nextRate(a, 3000, 2000);
    expect(b.rate).toBeCloseTo(1000 * 0.7 + 2000 * 0.3);
  });
  it('returns the same sample when no bytes arrived, so a render without progress changes nothing', () => {
    const a = nextRate(nextRate(null, 0, 0), 1000, 1000);
    expect(nextRate(a, 1000, 1500)).toBe(a);
  });
  it('holds the rate across a reset or a clock that did not move', () => {
    const a = nextRate(nextRate(null, 0, 0), 1000, 1000);
    expect(nextRate(a, 10, 2000).rate).toBe(1000);
    expect(nextRate(a, 2000, 1000).rate).toBe(1000);
  });
});

describe('quality sheet labels', () => {
  it('names a rendition by its shorter side and tags HD and 4K', () => {
    expect(describeVariant({ label: 'x', resolution: '3840x2160', bandwidth: 15_200_000, codecs: 'avc1.640028,mp4a.40.2' })).toEqual({ name: '2160p', tag: '4K', detail: '15.2 Mbps · H.264 · AAC', audio: '' });
    expect(describeVariant({ label: 'x', resolution: '1080x1920', audioLabel: 'English' })).toMatchObject({ name: '1080p', tag: 'Full HD', audio: 'English' });
    expect(describeVariant({ label: 'x', resolution: '640x360', bandwidth: 800_000 })).toMatchObject({ name: '360p', tag: '', detail: '800 kbps' });
    expect(describeVariant({ label: 'x', resolution: '1440x1080', bandwidth: 5_000_000 })).toMatchObject({ name: '1080p', detail: '1440×1080 · 5.0 Mbps' });
  });
  it('keeps the words of labels with no resolution', () => {
    expect(describeVariant({ label: 'video/mp4 · 412.0 MB' })).toMatchObject({ name: 'Original file', detail: 'MP4 · 412.0 MB' });
    expect(describeVariant({ label: 'Live · ts' })).toMatchObject({ name: 'Live', detail: 'MPEG-TS' });
    expect(describeVariant({ label: '102 segments · 10m 12s · fmp4' })).toMatchObject({ name: 'Full stream', detail: '10m 12s · fMP4 · 102 segments' });
    expect(describeVariant({ label: 'a', audioOnly: true, bandwidth: 128_000, codecs: 'mp4a.40.2' })).toMatchObject({ name: 'Audio only', detail: '128 kbps · AAC' });
  });
  it('names codecs people know', () => {
    expect(codecNames('hvc1.2.4.L153,ec-3')).toBe('HEVC · Dolby Digital Plus');
    expect(codecNames('weird.1')).toBe('weird.1');
    expect(codecNames(undefined)).toBe('');
  });
  it('estimates a size from bitrate and length', () => {
    expect(fmtEstimate(6_000_000, 600)).toBe('~430 MB');
    expect(fmtEstimate(15_200_000, 1000)).toBe('~1.8 GB');
    expect(fmtEstimate(6_000_000, undefined)).toBe('');
  });
  it('formats bitrates', () => {
    expect(fmtBitrate(6_000_000)).toBe('6.0 Mbps');
    expect(fmtBitrate(96_000)).toBe('96 kbps');
  });
});

describe('sizes', () => {
  it('gives exact sizes three figures and estimates two', () => {
    expect(fmtBytes(600.8 * 1024 * 1024)).toBe('601 MB');
    expect(fmtBytes(6.523 * 1024 * 1024)).toBe('6.52 MB');
    expect(fmtBytes(1.738 * 1024 ** 3)).toBe('1.74 GB');
    expect(fmtBytes(412 * 1024 * 1024)).toBe('412 MB');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtApprox(1.738 * 1024 ** 3)).toBe('~1.7 GB');
    expect(fmtRate(9.52 * 1024 * 1024)).toBe('9.5 MB/s');
    expect(fmtRate(6 * 1024 * 1024)).toBe('6.0 MB/s');
    expect(fmtRate(12.4 * 1024 * 1024)).toBe('12 MB/s');
  });
  it('names the site a host belongs to', () => {
    expect(siteOf('cdn.wildframe.tv')).toBe('wildframe.tv');
    expect(siteOf('media.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1');
    expect(siteOf('www.reddit.com')).toBe('reddit.com');
  });
});

describe('friendlyError', () => {
  it('says what to do for refused, missing and dropped downloads', () => {
    expect(friendlyError('HTTP 403 for https://cdn.example/seg-119.ts')).toBe('The link expired.');
    expect(friendlyError('Server returned 404 for segment 3')).toBe('The server no longer has it.');
    expect(friendlyError('TypeError: Failed to fetch')).toBe('The connection dropped.');
    expect(friendlyError('No variant to download.')).toBe('No variant to download.');
  });
});

describe('fmtDay', () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime();
  it('says today and yesterday, then the date', () => {
    expect(fmtDay(new Date(2026, 10, 4, 1, 0).getTime(), now, 'en-US')).toBe('Today');
    expect(fmtDay(new Date(2026, 10, 3, 23, 0).getTime(), now, 'en-US')).toBe('Yesterday');
    expect(fmtDay(new Date(2026, 9, 30).getTime(), now, 'en-US')).toBe('Oct 30');
    expect(fmtDay(new Date(2025, 9, 30).getTime(), now, 'en-US')).toBe('Oct 30, 2025');
  });
});
