/**
 * Minimal HLS playlist parser. Handles what a downloader needs:
 *  - master playlists: EXT-X-STREAM-INF variants and EXT-X-MEDIA audio groups
 *  - media playlists: EXTINF segments, EXT-X-MAP init segments, EXT-X-KEY
 *    (NONE / AES-128), EXT-X-BYTERANGE, EXT-X-MEDIA-SEQUENCE, EXT-X-ENDLIST,
 *    EXT-X-DISCONTINUITY
 */
import { languageName } from './format';

export interface HlsVariant {
  uri: string;
  bandwidth?: number;
  averageBandwidth?: number;
  resolution?: string;
  codecs?: string;
  frameRate?: number;
  audio?: string;
  name?: string;
}

export interface HlsRendition {
  type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
  groupId: string;
  name: string;
  uri?: string;
  isDefault: boolean;
  /** AUTOSELECT=YES: a player may pick it without the user asking. The rendition rule falls back to it when none is DEFAULT. */
  autoselect: boolean;
  language?: string;
}

export interface HlsMaster {
  kind: 'master';
  variants: HlsVariant[];
  renditions: HlsRendition[];
}

export interface HlsKey {
  method: 'NONE' | 'AES-128' | 'SAMPLE-AES' | string;
  uri?: string;
  /** 16 byte IV when EXT-X-KEY carried one; otherwise derive from sequence. */
  iv?: Uint8Array;
}

export interface ByteRange {
  length: number;
  offset: number;
}

export interface HlsSegment {
  index: number;
  sequence: number;
  uri: string;
  duration: number;
  /** What follows the duration in EXTINF, "" when nothing does. Twitch names each segment's source here: "live", or an ad's. */
  title: string;
  /** Seconds from the start of the playlist: the running EXTINF sum before this segment. */
  start: number;
  byteRange?: ByteRange;
  key: HlsKey;
  /** Init segment for fMP4 (EXT-X-MAP). Null for TS. */
  map: { uri: string; byteRange?: ByteRange } | null;
  discontinuity: boolean;
}

export interface HlsMedia {
  kind: 'media';
  segments: HlsSegment[];
  targetDuration: number;
  mediaSequence: number;
  endList: boolean;
  totalDuration: number;
  /** The playlist carries EXT-X-TWITCH tags: Twitch's own, where a segment titled other than "live" is a stitched ad. */
  twitch: boolean;
  /** "fmp4" when EXT-X-MAP present, "ts" otherwise (best guess). */
  container: 'fmp4' | 'ts' | 'unknown';
}

/** The shape both the HLS and the DASH parsers emit for one stream. */
export type MediaPlaylist = HlsMedia;

export type HlsPlaylist = HlsMaster | HlsMedia;

export function parseAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out[m[1]!] = m[3] !== undefined ? m[3] : (m[2] ?? '');
  }
  return out;
}

export function resolveUrl(uri: string, base: string): string {
  return new URL(uri, base).toString();
}

function parseByteRange(raw: string, prevEnd: number): ByteRange {
  const [lenStr, offStr] = raw.split('@');
  const length = Number(lenStr);
  const offset = offStr !== undefined ? Number(offStr) : prevEnd;
  return { length, offset };
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function parseHls(text: string, baseUrl: string): HlsPlaylist {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an M3U8 playlist (missing #EXTM3U)');

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], baseUrl: string): HlsMaster {
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      const uriLine = lines[++i];
      if (!uriLine || uriLine.startsWith('#')) continue;
      variants.push({
        uri: resolveUrl(uriLine, baseUrl),
        bandwidth: a.BANDWIDTH ? Number(a.BANDWIDTH) : undefined,
        averageBandwidth: a['AVERAGE-BANDWIDTH'] ? Number(a['AVERAGE-BANDWIDTH']) : undefined,
        resolution: a.RESOLUTION,
        codecs: a.CODECS,
        frameRate: a['FRAME-RATE'] ? Number(a['FRAME-RATE']) : undefined,
        audio: a.AUDIO,
        name: a.NAME,
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      renditions.push({
        type: (a.TYPE ?? 'AUDIO') as HlsRendition['type'],
        groupId: a['GROUP-ID'] ?? '',
        // NAME is what players show. Without it (it is required, but not every packager writes it) the language's name says more than a GROUP-ID.
        name: a.NAME ?? (a.LANGUAGE ? languageName(a.LANGUAGE) : undefined) ?? a['GROUP-ID'] ?? 'rendition',
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : undefined,
        isDefault: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        language: a.LANGUAGE,
      });
    }
  }
  return { kind: 'master', variants, renditions };
}

function parseMedia(lines: string[], baseUrl: string): HlsMedia {
  const segments: HlsSegment[] = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let key: HlsKey = { method: 'NONE' };
  let map: HlsSegment['map'] = null;
  let pendingDuration: number | null = null;
  let pendingTitle = '';
  let pendingByteRange: ByteRange | undefined;
  let pendingDiscontinuity = false;
  let twitch = false;
  let prevEnd = 0;
  let mapPrevEnd = 0;
  let start = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      pendingDiscontinuity = true;
    } else if (line.startsWith('#EXT-X-TWITCH-')) {
      twitch = true;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      key = {
        method: a.METHOD ?? 'NONE',
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : undefined,
        iv: a.IV ? hexToBytes(a.IV) : undefined,
      };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      let byteRange: ByteRange | undefined;
      if (a.BYTERANGE) {
        byteRange = parseByteRange(a.BYTERANGE, mapPrevEnd);
        mapPrevEnd = byteRange.offset + byteRange.length;
      }
      map = { uri: resolveUrl(a.URI ?? '', baseUrl), byteRange };
    } else if (line.startsWith('#EXTINF:')) {
      const inf = line.slice('#EXTINF:'.length);
      const comma = inf.indexOf(',');
      pendingDuration = parseFloat(comma < 0 ? inf : inf.slice(0, comma));
      pendingTitle = comma < 0 ? '' : inf.slice(comma + 1).trim();
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length), prevEnd);
      prevEnd = pendingByteRange.offset + pendingByteRange.length;
    } else if (line.startsWith('#')) {
      // ignore other tags
    } else if (pendingDuration !== null) {
      const index = segments.length;
      segments.push({
        index,
        sequence: mediaSequence + index,
        uri: resolveUrl(line, baseUrl),
        duration: pendingDuration,
        title: pendingTitle,
        start,
        byteRange: pendingByteRange,
        key: { ...key },
        map,
        discontinuity: pendingDiscontinuity,
      });
      start += pendingDuration;
      pendingDuration = null;
      pendingTitle = '';
      pendingByteRange = undefined;
      pendingDiscontinuity = false;
      if (!pendingByteRange) {
        // byte ranges without an explicit offset continue from the previous
        // segment's end, which parseByteRange tracks via prevEnd.
      }
    }
  }

  const container: HlsMedia['container'] = segments.some((s) => s.map)
    ? 'fmp4'
    : segments.length && /\.(ts|m2ts)(\?|$)/i.test(segments[0]!.uri)
      ? 'ts'
      : segments.length && /\.(m4s|mp4|m4v|m4a)(\?|$)/i.test(segments[0]!.uri)
        ? 'fmp4'
        : 'unknown';

  return {
    kind: 'media',
    segments,
    targetDuration,
    mediaSequence,
    endList,
    totalDuration: segments.reduce((a, s) => a + s.duration, 0),
    twitch,
    container,
  };
}

/**
 * Where a live recording starts: the earliest segment that keeps at most
 * `leadInSec` of already published media, and always the newest segment. A
 * player shows the stream a few segments behind the newest one, so this covers
 * what the user just watched without pulling an hour long DVR window.
 */
export function liveStartIndex(media: HlsMedia, leadInSec: number): number {
  let start = media.segments.length;
  let total = 0;
  while (start > 0) {
    total += media.segments[start - 1]!.duration;
    if (total > leadInSec && start < media.segments.length) break;
    start--;
  }
  return start;
}

export function variantLabel(v: HlsVariant): string {
  const parts: string[] = [];
  if (v.resolution) parts.push(v.resolution);
  if (v.bandwidth) parts.push(`${(v.bandwidth / 1000).toFixed(0)} kbps`);
  if (v.codecs) parts.push(v.codecs);
  if (v.name) parts.unshift(v.name);
  return parts.join(' · ') || v.uri;
}
