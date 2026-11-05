import type { MediaKind } from '../core/types';

/** A size in the unit that fits, to `digits` significant figures: "601 MB", "56.3 MB", "1.74 GB". */
function sized(n: number, digits: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const [v, unit] = n < 1024 ** 2 ? [n / 1024, 'KB'] : n < 1024 ** 3 ? [n / 1024 ** 2, 'MB'] : [n / 1024 ** 3, 'GB'];
  return `${Number(v.toPrecision(digits))} ${unit}`;
}

/** An exact size, three significant figures: "601 MB", "6.52 MB", "1.74 GB". */
export function fmtBytes(n: number): string {
  return sized(n, 3);
}

/** An estimated size, two significant figures and a tilde: "~740 MB", "~1.7 GB". */
export function fmtApprox(n: number): string {
  return `~${sized(n, 2)}`;
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

/** "9.5 MB/s": two figures, so the number does not flicker as it updates. */
export function fmtRate(bytesPerSec: number): string {
  const n = Math.round(bytesPerSec);
  if (n < 1024 ** 2) return `${sized(n, 2)}/s`;
  const mb = n / 1024 ** 2;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB/s`;
}

export function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''} left`;
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

/** How long ago, short enough for a badge: "just now", "12m ago", "5h ago" the same day, then "yesterday" and "Nov 2" like History. */
export function fmtAgo(ms: number, now = Date.now(), locale?: string): string {
  const mins = Math.floor(Math.max(0, now - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const day = fmtDay(ms, now, locale);
  if (day === 'Today') return `${Math.floor(mins / 60)}h ago`;
  return day === 'Yesterday' ? 'yesterday' : day;
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

/** "15.2 Mbps", "800 kbps": a bitrate short enough for a quality row. */
export function fmtBitrate(bitsPerSec: number): string {
  if (bitsPerSec >= 1_000_000) return `${(bitsPerSec / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSec / 1000)} kbps`;
}

const CODEC_NAMES: [RegExp, string][] = [
  [/^(avc1|avc3)\b/i, 'H.264'],
  [/^(hvc1|hev1)\b/i, 'HEVC'],
  [/^av01\b/i, 'AV1'],
  [/^(vp09|vp9)\b/i, 'VP9'],
  [/^(vp08|vp8)\b/i, 'VP8'],
  [/^mp4a\.40\.(2|5|29)\b/i, 'AAC'],
  [/^mp4a\b/i, 'AAC'],
  [/^ec-3\b/i, 'Dolby Digital Plus'],
  [/^ac-3\b/i, 'Dolby Digital'],
  [/^opus\b/i, 'Opus'],
  [/^flac\b/i, 'FLAC'],
];

/** "H.264 · AAC" from an RFC 6381 codecs string like "avc1.640028,mp4a.40.2". Unknown codecs keep their own name. */
export function codecNames(codecs: string | undefined): string {
  if (!codecs) return '';
  const names = codecs
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => CODEC_NAMES.find(([re]) => re.test(c))?.[1] ?? c);
  return [...new Set(names)].join(' · ');
}

const CONTAINERS: Record<string, string> = { ts: 'MPEG-TS', fmp4: 'fMP4', 'video/mp4': 'MP4', 'video/webm': 'WebM', 'audio/mp4': 'M4A', 'audio/mpeg': 'MP3' };

/**
 * What the quality sheet shows for one rendition: a short name ("1080p"), a
 * tag ("4K", "HD"), a muted detail line, and the audio merged into it.
 * Labels from the engine with no resolution keep their own words.
 */
export function describeVariant(v: { label: string; resolution?: string; bandwidth?: number; codecs?: string; audioLabel?: string; audioOnly?: boolean }): {
  name: string;
  tag: string;
  detail: string;
  audio: string;
} {
  const audio = v.audioLabel ?? '';
  const rate = v.bandwidth ? fmtBitrate(v.bandwidth) : '';
  const codecs = codecNames(v.codecs);
  const [w, h] = (v.resolution ?? '').split('x').map(Number);
  if (w && h) {
    const p = Math.min(w, h);
    const tag = p >= 2160 ? '4K' : p >= 1440 ? '2K' : p >= 1080 ? 'Full HD' : p >= 720 ? 'HD' : '';
    // The frame size only when it is not plain 16:9, where the name and tag already say it.
    const wide = Math.abs(Math.max(w, h) / Math.min(w, h) - 16 / 9) < 0.02;
    return { name: `${p}p`, tag, detail: [wide ? '' : `${w}×${h}`, rate, codecs].filter(Boolean).join(' · '), audio };
  }
  if (v.audioOnly) return { name: 'Audio only', tag: '', detail: [rate, codecs].filter(Boolean).join(' · '), audio };
  const parts = v.label.split(' · ').map((p) => CONTAINERS[p.trim().toLowerCase()] ?? p.trim());
  // A plain file ("video/mp4 · 412.0 MB"), a single media playlist ("102 segments · 10m 12s · fmp4"), a live one ("Live · ts").
  if (/^\w+\/[\w.+-]+$/.test(v.label.split(' · ')[0] ?? '')) return { name: 'Original file', tag: '', detail: parts.join(' · '), audio };
  if (parts[0] === 'Live') return { name: 'Live', tag: '', detail: parts.slice(1).join(' · '), audio };
  if (/^\d+ segments$/.test(parts[0] ?? '')) return { name: 'Full stream', tag: '', detail: [...parts.slice(1), parts[0]].join(' · '), audio };
  return { name: parts[0] ?? v.label, tag: '', detail: parts.slice(1).join(' · '), audio };
}

/** "Today", "Yesterday", "Oct 30", or "Oct 30, 2025" outside the current year. */
export function fmtDay(ms: number, now = Date.now(), locale?: string): string {
  const d = new Date(ms);
  const n = new Date(now);
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(n) - midnight(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' }) });
}

/** The host of a URL without "www.", or the input when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** "~1.6 GB": what a rendition of `bitsPerSec` comes to over `seconds`, or '' when either is unknown. */
export function fmtEstimate(bitsPerSec: number | undefined, seconds: number | undefined): string {
  if (!bitsPerSec || !seconds) return '';
  return fmtApprox((bitsPerSec * seconds) / 8);
}

/** "2160p" from a shorter side in pixels. */
export function fmtHeight(height: number | undefined): string {
  return height ? `${height}p` : '';
}

/**
 * An engine error in words a person can act on. The original stays available
 * as the detail (a tooltip), since it names the status and the URL.
 */
export function friendlyError(message: string): string {
  if (/\b(401|403)\b/.test(message)) return 'The link expired.';
  if (/\b(404|410)\b/.test(message)) return 'The server no longer has it.';
  if (/\b(429|5\d\d)\b/.test(message)) return 'The server is busy. Try again soon.';
  if (/failed to fetch|networkerror|network error|connection/i.test(message)) return 'The connection dropped.';
  if (/timed? ?out|timeout/i.test(message)) return 'The server stopped answering.';
  return message;
}

/** "2160p" from a file name Magpie built, like "Aurora [2160p].mp4"; '' when it names none. */
export function qualityOfFile(file: string): string {
  return /\[(\d{3,4}p)\]/.exec(file)?.[1] ?? '';
}

/** "wildframe.tv" for "cdn.wildframe.tv", "bbc.co.uk" for "media.bbc.co.uk": the site a host belongs to. */
export function siteOf(host: string): string {
  const parts = host.replace(/^www\./, '').split('.');
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1]!)) return parts.join('.');
  const two = parts.slice(-2);
  // Second level registries like co.uk, com.au, ne.jp keep a third label.
  const keep = two[0]!.length <= 3 && two[1]!.length === 2 ? 3 : 2;
  return parts.slice(-keep).join('.');
}
