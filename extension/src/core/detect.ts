import type { MediaKind } from './types';

const HLS_MIMES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
]);
const DASH_MIMES = new Set(['application/dash+xml']);
const FILE_EXT = /\.(mp4|m4v|webm|mov|mkv|m4a|mp3|ogg|ogv|flv)(\?|#|$)/i;
const SEGMENT_HINT = /(^|[/_.-])(seg|segment|chunk|frag|fragment|init|part)[-_]?\d*\.(ts|m4s|mp4|m4v|m4a)(\?|#|$)/i;

export interface DetectInput {
  url: string;
  mime: string;
  /** webRequest resource type */
  resourceType: string;
  contentLength: number | null;
}

/**
 * Decide whether a response is a media candidate. Returns null for noise.
 * Rules (in order):
 *  1. MIME says HLS or DASH -> manifest.
 *  2. URL path ends in .m3u8 / .mpd -> manifest.
 *  3. `media` resource type (a <video src> or <source>) with a video/audio
 *     MIME or media file extension -> plain file.
 *  4. XHR / fetch of a video/* file that does not look like a segment and is
 *     at least 2 MB -> plain file. Smaller ones are almost always MSE segments.
 */
export function detect(input: DetectInput): MediaKind | null {
  const mime = input.mime.split(';')[0]!.trim().toLowerCase();
  let path = '';
  try {
    path = new URL(input.url).pathname.toLowerCase();
  } catch {
    return null;
  }

  if (HLS_MIMES.has(mime) || path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
  if (DASH_MIMES.has(mime) || path.endsWith('.mpd')) return 'dash';

  if (mime === 'video/mp2t' || mime === 'video/iso.segment') return null;
  if (SEGMENT_HINT.test(path)) return null;

  const looksLikeMedia = mime.startsWith('video/') || mime.startsWith('audio/') || FILE_EXT.test(path);
  if (!looksLikeMedia) return null;
  if (input.resourceType === 'media') return 'file';
  if (input.contentLength !== null && input.contentLength >= 2 * 1024 * 1024) return 'file';
  return null;
}

/**
 * The manifest URL without LL-HLS delivery directives (_HLS_msn, _HLS_part,
 * _HLS_skip). Players add them on every reload of a live playlist and the HLS
 * spec reserves the _HLS_ prefix for them, so they never identify a stream.
 * Without them the server answers with the current playlist right away.
 */
export function manifestUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (k.startsWith('_HLS_')) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}

/** Timestamps, counters, cache busters and session tokens: values that change between reloads of one stream. */
function volatile(value: string): boolean {
  return /^\d{6,}$/.test(value) || (value.length >= 16 && /\d/.test(value) && /[a-z]/i.test(value));
}

/**
 * True when two manifest URLs look like reloads of one stream: same origin and
 * path, and every query parameter that differs (or is missing on one side)
 * carries a volatile value on both sides where present. `?cam=1` and `?cam=2`
 * stay apart; `?_=1729500000000` and `?_=1729500002000` do not.
 */
export function sameStream(a: string, b: string): boolean {
  let ua: URL;
  let ub: URL;
  try {
    ua = new URL(manifestUrl(a));
    ub = new URL(manifestUrl(b));
  } catch {
    return false;
  }
  if (ua.origin !== ub.origin || ua.pathname !== ub.pathname) return false;
  const names = new Set([...ua.searchParams.keys(), ...ub.searchParams.keys()]);
  for (const k of names) {
    const va = ua.searchParams.getAll(k).join(',');
    const vb = ub.searchParams.getAll(k).join(',');
    if (va === vb) continue;
    if ((va && !volatile(va)) || (vb && !volatile(vb))) return false;
  }
  return true;
}

/**
 * True when `url` falls under a DASH fold rule (see DashRepresentation.fold):
 * a rule without `*` is the URL itself, and `prefix*suffix` takes any URL that
 * starts with the prefix and ends with the suffix, the two not overlapping.
 * The rule splits at its last `*`, since foldRule keeps any `*` of a URL in
 * the prefix. An MPD gives one such rule per representation instead of every
 * segment URL.
 */
export function matchesFoldRule(rule: string, url: string): boolean {
  const star = rule.lastIndexOf('*');
  if (star < 0) return rule === url;
  const prefix = rule.slice(0, star);
  const suffix = rule.slice(star + 1);
  return url.length >= prefix.length + suffix.length && url.startsWith(prefix) && url.endsWith(suffix);
}

/** Produce a stable id for a URL so repeated sightings dedupe. */
export function candidateId(tabId: number, url: string): string {
  let h = 2166136261;
  const s = `${tabId}|${url}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
