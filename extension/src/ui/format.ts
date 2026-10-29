import type { MediaKind } from '../core/types';

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 48 ? '…' + u.pathname.slice(-46) : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url;
  }
}

/** "cdn.example.com · master.m3u8": where a stream comes from, short enough for one line. */
export function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return last ? `${u.hostname} · ${last}` : u.hostname;
  } catch {
    return url;
  }
}

/** 0..1 when progress is measurable, null when it is not (unknown size). */
export function jobProgress(job: {
  state: string;
  kind: string;
  live?: boolean;
  bytes: number;
  bytesTotal?: number;
  segmentsDone: number;
  segmentsTotal: number;
}): number | null {
  if (job.state === 'queued') return 0;
  if (job.kind === 'file') {
    if (job.bytesTotal) return Math.min(1, job.bytes / job.bytesTotal);
    return job.state === 'saving' ? 1 : null;
  }
  if (job.state === 'muxing' || job.state === 'saving') return 1;
  if (job.live) return null;
  return job.segmentsTotal ? job.segmentsDone / job.segmentsTotal : null;
}

/** A smoothed bytes per second from one more byte count. The rate holds when no bytes arrived. */
export type RateSample = { t: number; b: number; rate: number };
export function nextRate(prev: RateSample | null, bytes: number, now: number): RateSample {
  if (!prev) return { t: now, b: bytes, rate: 0 };
  if (bytes === prev.b) return prev;
  if (bytes < prev.b || now <= prev.t) return { t: now, b: bytes, rate: prev.rate };
  const sample = ((bytes - prev.b) * 1000) / (now - prev.t);
  return { t: now, b: bytes, rate: prev.rate ? prev.rate * 0.7 + sample * 0.3 : sample };
}

export function fmtRate(bytesPerSec: number): string {
  return `${fmtBytes(Math.round(bytesPerSec))}/s`;
}

export function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s left`;
  return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

/** Recorded length as a clock: "0:42", "12:05", "1:02:09". */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function kindLabel(kind: string): string {
  return { hls: 'HLS', dash: 'DASH', file: 'FILE', post: 'REDDIT' }[kind] ?? kind.toUpperCase();
}

/** The kind a stream URL points at, for history entries saved before the kind was kept. */
export function kindOfUrl(url: string): MediaKind {
  let path = url;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    /* keep the raw string */
  }
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'file';
}

/** "1080p" from a rendition label like "1920x1080 · 6000 kbps · avc1...", '' when it names no resolution. */
export function shortVariant(label: string): string {
  const h = /\b\d{3,4}x(\d{3,4})\b/.exec(label)?.[1];
  return h ? `${h}p` : '';
}

/** "Oct 26, 2026". `locale` is for tests; the UI uses the browser's. */
export function fmtDate(ms: number, locale?: string): string {
  return new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Oct 26, 2026, 10:42 AM", for tooltips. */
export function fmtDateTime(ms: number, locale?: string): string {
  return new Date(ms).toLocaleString(locale, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** True for http and https URLs, the only ones the UI turns into links. */
export function isWebUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}
