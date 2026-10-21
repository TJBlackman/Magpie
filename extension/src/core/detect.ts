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
