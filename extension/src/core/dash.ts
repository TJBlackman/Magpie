/**
 * DASH manifest (MPD) parser. It resolves one Period of an MPD into per
 * Representation segment lists shaped like an HLS media playlist, so the engine
 * downloads DASH through the same pools, sinks and writer as HLS.
 *
 * Supported: static and dynamic MPDs, BaseURL at every level, SegmentTemplate
 * ($Number$ with a duration, or a SegmentTimeline), SegmentList, and
 * SegmentBase (the engine fetches the index range and calls
 * `segmentsFromSidx` in sidx.ts). The XML goes through DOMParser and is walked
 * by `localName`, so namespace prefixes and default namespaces do not matter.
 */
import { fmtDuration, languageName } from './format';
import { resolveUrl, type ByteRange, type HlsSegment, type MediaPlaylist } from './hls';

export interface DashTimelineEntry {
  /** S@t as a decimal string. Live timelines in a 10 MHz timescale count past 2^53. */
  t?: string;
  d: number;
  r: number;
}

/**
 * A SegmentTemplate merged across the Period, AdaptationSet and Representation
 * levels. Kept on the Representation so a live recorder can recompute the
 * available segments with `availableRange` without parsing the MPD again.
 */
export interface DashTemplate {
  /** Absolute BaseURL of the Representation; the media pattern resolves against it. */
  base: string;
  media: string;
  init?: { uri: string; byteRange?: ByteRange };
  timescale: number;
  /** Segment duration in timescale units, for the $Number$ form. */
  duration?: number;
  startNumber: number;
  endNumber?: number;
  /** Decimal string, for the same reason as `DashTimelineEntry.t`. */
  presentationTimeOffset: string;
  timeline?: DashTimelineEntry[];
  /** Seconds a segment is available before its end, from SegmentTemplate@availabilityTimeOffset. */
  availabilityTimeOffset: number;
  /** Seconds from the presentation start (static) or availabilityStartTime (dynamic) to the Period start. */
  periodStart: number;
  /** Seconds, when the MPD tells. */
  periodDuration?: number;
}

export interface DashRepresentation {
  id: string;
  type: 'video' | 'audio';
  mimeType: string;
  codecs?: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: string;
  audioSamplingRate?: number;
  lang?: string;
  /** Role@value of the set, e.g. "main". */
  role?: string;
  /** ContentProtection, or a CA_descriptor EssentialProperty, on the set or the Representation. */
  encrypted: boolean;
  /** Video and audio in the same segments (codecs lists both) and the MPD has no audio set. */
  muxed?: boolean;
  /** Position of the AdaptationSet in the chosen Period. */
  setIndex: number;
  /**
   * Resolved segment list, shaped like an HLS media playlist so the engine
   * reuses its download loop. Absent for SegmentBase until the sidx is fetched.
   */
  media?: MediaPlaylist;
  /** SegmentBase: the engine fetches indexRange, parses the sidx, and calls segmentsFromSidx. */
  segmentBase?: {
    url: string;
    initRange?: ByteRange;
    indexRange: ByteRange;
    /** Seconds, from SegmentBase@presentationTimeOffset and @timescale. */
    presentationTimeOffset: number;
  };
  /** Set for SegmentTemplate Representations, for `availableRange`. */
  template?: DashTemplate;
  /**
   * Rules the sniffer folds the player's own requests for this representation
   * by, so they stay under the MPD row (see Inspection.children): the exact URL
   * of the init segment and of a SegmentBase file, and for the media segments
   * of a SegmentTemplate or a SegmentList one `prefix*suffix` rule (see
   * foldRule), or the exact URL when every segment is a range of one file. At
   * most two strings per representation, however many segments it has, since
   * candidates live in storage.session.
   */
  fold: string[];
}

export interface DashUtcTiming {
  schemeIdUri: string;
  value: string;
}

/** Timing of a dynamic MPD. Durations are in seconds and dates in epoch seconds. */
export interface DashLive {
  availabilityStartTime?: number;
  publishTime?: number;
  minimumUpdatePeriod?: number;
  timeShiftBufferDepth?: number;
  suggestedPresentationDelay?: number;
  minBufferTime?: number;
  /** Start of the chosen Period, in seconds after availabilityStartTime. */
  periodStart: number;
  utcTiming: DashUtcTiming[];
}

export interface DashManifest {
  type: 'static' | 'dynamic';
  /** Seconds: mediaPresentationDuration, else the sum of the Period durations. */
  duration?: number;
  periodCount: number;
  /** Index of the chosen Period among all Period elements. */
  periodIndex: number;
  periodId?: string;
  /** Seconds. */
  periodStart: number;
  /** Seconds, when known. */
  periodDuration?: number;
  /** Sorted by bandwidth, highest first. Muxed video and audio Representations come here with `muxed: true`. */
  video: DashRepresentation[];
  /** In document order. `chooseAudio` picks one. */
  audio: DashRepresentation[];
  /** What was dropped and why, for the sheet: WebM, unknown EssentialProperty, trick mode, xlink, the Period choice. */
  notes: string[];
  live?: DashLive;
}

/** Segment numbers in the window, inclusive. Empty when `last < first`. */
export interface DashWindow {
  first: number;
  last: number;
  media: MediaPlaylist;
}

/** A dynamic MPD without timeShiftBufferDepth keeps every segment since availabilityStartTime; list at most the newest hour. */
const LIVE_WINDOW_CAP_SEC = 3600;
/** Guards against a typo'd r or duration expanding into millions of segments. */
const MAX_SEGMENTS = 500_000;

const XLINK_NS = 'http://www.w3.org/1999/xlink';
const TRICK_MODE = 'http://dashif.org/guidelines/trickmode';
/** EssentialProperty schemes that do not change how the media is fetched or decoded by Magpie. */
const KNOWN_ESSENTIAL = new Set(
  [
    'urn:mpeg:dash:period-continuity:2015',
    'urn:mpeg:dash:period-connectivity:2015',
    'urn:mpeg:mpegB:cicp:ColourPrimaries',
    'urn:mpeg:mpegB:cicp:TransferCharacteristics',
    'urn:mpeg:mpegB:cicp:MatrixCoefficients',
    'urn:mpeg:dash:srd:2014',
  ].map((s) => s.toLowerCase()),
);
/**
 * An MPEG-2 conditional access descriptor as EssentialProperty: the segments
 * are scrambled, which is DRM as much as ContentProtection is. It marks the
 * representation encrypted instead of hiding it as an unknown scheme, so the
 * engine says why it is left out.
 */
const CA_DESCRIPTOR = 'urn:mpeg:dash:13818:1:ca_descriptor:2011';

const VIDEO_CODECS = new Set(['avc1', 'avc2', 'avc3', 'avc4', 'hvc1', 'hev1', 'dvh1', 'dvhe', 'dva1', 'dvav', 'vp8', 'vp08', 'vp9', 'vp09', 'av01', 'mp4v', 'vvc1', 'vvi1', 'theora']);
const AUDIO_CODECS = new Set(['mp4a', 'ec-3', 'ac-3', 'ac-4', 'opus', 'flac', 'mp3', 'dtsc', 'dtse', 'dtsh', 'dtsl', 'dtsx', 'vorbis', 'alac', 'mha1', 'mhm1']);
const TEXT_CODECS = new Set(['stpp', 'wvtt', 'tx3g', 'c608', 'evte', 'im1t']);

type Kind = 'video' | 'audio' | 'other';
type SegKind = 'SegmentBase' | 'SegmentList' | 'SegmentTemplate';

interface SegInfo {
  kind: SegKind;
  /** Attributes merged from the shallowest level to the deepest; the deepest wins per attribute. */
  attrs: Record<string, string>;
  timeline?: Element;
  init?: Element;
  segmentUrls: Element[];
}

interface Draft {
  rep: DashRepresentation;
  base: string;
  seg?: SegInfo;
}

interface PeriodDraft {
  el: Element;
  index: number;
  id?: string;
  start: number;
  duration?: number;
  drafts: Draft[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Small helpers

function kids(el: Element, name: string): Element[] {
  const out: Element[] = [];
  for (const c of Array.from(el.children)) if (c.localName === name) out.push(c);
  return out;
}

function kid(el: Element | undefined, name: string): Element | undefined {
  if (!el) return undefined;
  for (const c of Array.from(el.children)) if (c.localName === name) return c;
  return undefined;
}

function attr(el: Element | undefined, name: string): string | undefined {
  const v = el?.getAttribute(name);
  return v === null || v === undefined || v.trim() === '' ? undefined : v.trim();
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v.split(/\s+/)[0]);
  return Number.isFinite(n) ? n : undefined;
}

function hasParserError(node: Element): boolean {
  if (node.localName === 'parsererror') return true;
  for (const c of Array.from(node.children)) if (hasParserError(c)) return true;
  return false;
}

function xlinkHref(el: Element): string | undefined {
  const ns = el.getAttributeNS(XLINK_NS, 'href');
  if (ns) return ns;
  for (const a of Array.from(el.attributes)) if (a.localName === 'href' && a.name.includes(':')) return a.value;
  return undefined;
}

/** The first BaseURL child resolved against the parent level, or the parent level itself. */
function baseOf(el: Element, parent: string): string {
  const text = kid(el, 'BaseURL')?.textContent?.trim();
  if (!text) return parent;
  try {
    return resolveUrl(text, parent);
  } catch {
    return parent;
  }
}

/** DASH byte ranges are "first-last", inclusive. */
export function dashRange(s: string | undefined): ByteRange | undefined {
  const m = s ? /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(s) : null;
  if (!m) return undefined;
  const first = Number(m[1]);
  const last = Number(m[2]);
  if (last < first) return undefined;
  return { offset: first, length: last - first + 1 };
}

function codecList(codecs: string | undefined): string[] {
  if (!codecs) return [];
  return codecs
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
}

function codecFamily(codec: string): string {
  return codec.split('.')[0] ?? codec;
}

function hasVideoCodec(codecs: string | undefined): boolean {
  return codecList(codecs).some((c) => VIDEO_CODECS.has(codecFamily(c)));
}

function hasAudioCodec(codecs: string | undefined): boolean {
  return codecList(codecs).some((c) => AUDIO_CODECS.has(codecFamily(c)));
}

function kindOfMime(mime: string | undefined): Kind | undefined {
  if (!mime) return undefined;
  const m = mime.toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'other';
}

function kindOfCodecs(codecs: string | undefined): Kind | undefined {
  const list = codecList(codecs);
  if (!list.length) return undefined;
  if (list.some((c) => TEXT_CODECS.has(codecFamily(c)))) return 'other';
  if (hasVideoCodec(codecs)) return 'video';
  if (hasAudioCodec(codecs)) return 'audio';
  return undefined;
}

/**
 * Video, audio or something else (text, image, application). The set's
 * contentType wins; then the codecs, which are more specific than a mimeType
 * (some packagers label audio only sets video/mp4); then the mimeType of the
 * Representation or the set; then the set's ContentComponents.
 */
function kindOf(set: Element, rep: Element): Kind | undefined {
  const ct = attr(set, 'contentType')?.toLowerCase();
  if (ct) return ct === 'video' ? 'video' : ct === 'audio' ? 'audio' : 'other';
  const byCodecs = kindOfCodecs(attr(rep, 'codecs') ?? attr(set, 'codecs'));
  if (byCodecs) return byCodecs;
  const byMime = kindOfMime(attr(rep, 'mimeType') ?? attr(set, 'mimeType'));
  if (byMime) return byMime;
  const components = kids(set, 'ContentComponent').map((c) => attr(c, 'contentType')?.toLowerCase());
  if (components.includes('video')) return 'video';
  if (components.includes('audio')) return 'audio';
  return undefined;
}

/** A note when the element carries an EssentialProperty Magpie must not ignore, else null. */
function essentialVeto(el: Element): string | null {
  for (const p of kids(el, 'EssentialProperty')) {
    const scheme = attr(p, 'schemeIdUri') ?? '';
    if (scheme === TRICK_MODE) return 'Skipped a trick mode track (fast forward frames only).';
    if (scheme.toLowerCase() === CA_DESCRIPTOR) continue;
    if (!KNOWN_ESSENTIAL.has(scheme.toLowerCase())) {
      return `Skipped a track that requires ${scheme || 'an unnamed EssentialProperty'}, which Magpie does not understand.`;
    }
  }
  return null;
}

/** True when the element carries DRM: ContentProtection, or the CA_descriptor EssentialProperty. */
function isProtected(el: Element): boolean {
  if (kids(el, 'ContentProtection').length > 0) return true;
  return kids(el, 'EssentialProperty').some((p) => (attr(p, 'schemeIdUri') ?? '').toLowerCase() === CA_DESCRIPTOR);
}

/** Role@value, "main" when any Role says so, else the first. */
function roleOf(el: Element): string | undefined {
  const values = kids(el, 'Role')
    .map((r) => attr(r, 'value'))
    .filter((v): v is string => !!v);
  return values.find((v) => v.toLowerCase() === 'main') ?? values[0];
}

// ---------------------------------------------------------------------------
// ISO 8601

const DURATION_RE =
  /^(-)?P(?:(\d+(?:[.,]\d+)?)Y)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)W)?(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/;
const DURATION_UNITS = [365 * 86400, 30 * 86400, 7 * 86400, 86400, 3600, 60, 1];

/** ISO 8601 duration ("PT1H2M3.5S", "P1DT2H", "PT20S") in seconds. Years count 365 days and months 30. */
export function isoDuration(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const v = s.trim();
  const m = DURATION_RE.exec(v);
  if (!m || v.endsWith('T')) return undefined;
  const parts = m.slice(2);
  if (parts.every((p) => p === undefined)) return undefined;
  let total = 0;
  parts.forEach((p, i) => {
    if (p !== undefined) total += Number(p.replace(',', '.')) * DURATION_UNITS[i]!;
  });
  return m[1] ? -total : total;
}

/** ISO 8601 date and time in epoch seconds. A time without a zone is UTC, as DASH players read it. */
export function isoDate(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  let v = s.trim().replace(/(\.\d{3})\d+/, '$1');
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v += 'Z';
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms / 1000;
}

// ---------------------------------------------------------------------------
// Templates

const TEMPLATE_RE = /\$(RepresentationID|Number|Bandwidth|Time|SubNumber)?(?:%0(\d+)([diuxXo]))?\$/g;

/** Fills a SegmentTemplate pattern: $RepresentationID$, $Number$, $Bandwidth$, $Time$, the %0Nd width form, and $$. */
export function fillTemplate(pattern: string, v: { id: string; number?: number; bandwidth?: number; time?: bigint | number }): string {
  return pattern.replace(TEMPLATE_RE, (whole, name: string | undefined, width: string | undefined, conv: string | undefined) => {
    if (!name) return width ? whole : '$';
    if (name === 'RepresentationID') return v.id;
    const raw = name === 'Number' ? v.number : name === 'Bandwidth' ? v.bandwidth : name === 'Time' ? v.time : undefined;
    if (raw === undefined) return whole;
    const s = conv === 'x' ? raw.toString(16) : conv === 'X' ? raw.toString(16).toUpperCase() : conv === 'o' ? raw.toString(8) : raw.toString();
    return width ? s.padStart(Number(width), '0') : s;
  });
}

function bigOf(s: string | undefined): bigint {
  if (!s || !/^\d+$/.test(s)) return 0n;
  return BigInt(s);
}

function timelineOf(el: Element | undefined): DashTimelineEntry[] | undefined {
  if (!el) return undefined;
  return kids(el, 'S').map((s) => {
    const t = attr(s, 't');
    return { t: t && /^\d+$/.test(t) ? t : undefined, d: num(attr(s, 'd')) ?? 0, r: Math.trunc(num(attr(s, 'r')) ?? 0) };
  });
}

/**
 * Expands S entries into segment start times. `limit` is the media time an
 * open ended repeat (r = -1) runs to when no later S says where it stops;
 * `edge` marks a limit at the live edge, where only whole segments count.
 */
function expandTimeline(entries: DashTimelineEntry[], limit: bigint | undefined, edge: boolean): { t: bigint; d: number }[] {
  const out: { t: bigint; d: number }[] = [];
  let t = 0n;
  entries.forEach((s, i) => {
    if (s.t !== undefined) t = BigInt(s.t);
    if (s.d <= 0) return;
    const d = BigInt(Math.round(s.d));
    let count = s.r + 1;
    if (s.r < 0) {
      const next = entries[i + 1]?.t;
      const end = next !== undefined ? BigInt(next) : limit;
      if (end === undefined) throw new Error('A SegmentTimeline repeats to the end of a Period whose length the MPD does not give.');
      const span = end - t;
      count = span <= 0n ? 0 : Number(next === undefined && edge ? span / d : (span + d - 1n) / d);
    }
    for (let j = 0; j < count; j++) {
      out.push({ t, d: s.d });
      t += d;
      if (out.length > MAX_SEGMENTS) throw new Error('The MPD lists too many segments.');
    }
  });
  return out;
}

/** Wraps segments as an HLS shaped media playlist. */
export function toPlaylist(segments: HlsSegment[], endList: boolean, container: MediaPlaylist['container'] = 'fmp4'): MediaPlaylist {
  return {
    kind: 'media',
    segments,
    targetDuration: segments.reduce((a, s) => Math.max(a, s.duration), 0),
    mediaSequence: segments[0]?.sequence ?? 0,
    endList,
    totalDuration: segments.reduce((a, s) => a + s.duration, 0),
    twitch: false,
    container,
  };
}

function segment(index: number, sequence: number, uri: string, start: number, duration: number, map: HlsSegment['map'], byteRange?: ByteRange): HlsSegment {
  return { index, sequence, uri, duration, title: '', start, byteRange, key: { method: 'NONE' }, map, discontinuity: false };
}

function containerOf(rep: DashRepresentation): MediaPlaylist['container'] {
  return /mp2t/i.test(rep.mimeType) ? 'ts' : 'fmp4';
}

function templateWindow(rep: DashRepresentation, tpl: DashTemplate, live: DashLive | undefined, nowSec: number): { first: number; last: number; segments: HlsSegment[] } {
  const ts = tpl.timescale;
  const pto = bigOf(tpl.presentationTimeOffset);
  const map = tpl.init ?? null;
  const segments: HlsSegment[] = [];
  const push = (number: number, time: bigint, start: number, duration: number) => {
    const uri = resolveUrl(fillTemplate(tpl.media, { id: rep.id, number, bandwidth: rep.bandwidth, time }), tpl.base);
    segments.push(segment(segments.length, number, uri, start, duration, map));
  };
  const elapsed = live && live.availabilityStartTime !== undefined ? nowSec - live.availabilityStartTime - tpl.periodStart + tpl.availabilityTimeOffset : undefined;

  if (tpl.timeline) {
    let limit = tpl.periodDuration !== undefined ? pto + BigInt(Math.round(tpl.periodDuration * ts)) : undefined;
    let edge = false;
    if (elapsed !== undefined) {
      const nowT = pto + BigInt(Math.floor(elapsed * ts));
      if (limit === undefined || nowT < limit) {
        limit = nowT;
        edge = true;
      }
    }
    let n = tpl.startNumber;
    for (const s of expandTimeline(tpl.timeline, limit, edge)) {
      if (tpl.endNumber !== undefined && n > tpl.endNumber) break;
      push(n, s.t, Number(s.t - pto) / ts, s.d / ts);
      n++;
    }
  } else if (tpl.duration) {
    const segDur = tpl.duration / ts;
    const durT = BigInt(Math.round(tpl.duration));
    const inPeriod = tpl.periodDuration !== undefined ? Math.max(1, Math.ceil(tpl.periodDuration / segDur - 1e-9)) : undefined;
    let firstK = 0;
    let lastK: number;
    if (live) {
      if (elapsed === undefined) throw new Error('This live MPD has no availabilityStartTime, so its segment numbers cannot be worked out.');
      // Segment k is complete at (k + 1) * segDur and stays until timeShiftBufferDepth after that.
      lastK = Math.floor(elapsed / segDur) - 1;
      const depth = Math.min(live.timeShiftBufferDepth ?? Infinity, LIVE_WINDOW_CAP_SEC);
      firstK = Math.max(0, Math.floor((elapsed - depth) / segDur));
      if (inPeriod !== undefined) lastK = Math.min(lastK, inPeriod - 1);
    } else {
      if (inPeriod === undefined) {
        throw new Error('The MPD gives no mediaPresentationDuration, Period duration or SegmentTimeline, so the number of segments is unknown.');
      }
      lastK = inPeriod - 1;
    }
    if (tpl.endNumber !== undefined) lastK = Math.min(lastK, tpl.endNumber - tpl.startNumber);
    if (lastK - firstK + 1 > MAX_SEGMENTS) throw new Error('The MPD lists too many segments.');
    for (let k = firstK; k <= lastK; k++) {
      const start = k * segDur;
      const duration = tpl.periodDuration !== undefined ? Math.min(segDur, tpl.periodDuration - start) : segDur;
      push(tpl.startNumber + k, pto + BigInt(k) * durT, start, duration);
    }
  }
  const first = segments[0]?.sequence ?? tpl.startNumber;
  const last = segments.length ? segments[segments.length - 1]!.sequence : first - 1;
  return { first, last, segments };
}

/**
 * The segments of a Representation available at `nowSec` (epoch seconds,
 * already corrected by the UTCTiming clock offset). For a static MPD or a
 * SegmentTimeline this is what the MPD lists; for the $Number$ form of a
 * dynamic MPD it follows the clock, so a live recorder calls this again on each
 * tick without parsing the MPD again.
 */
export function availableRange(rep: DashRepresentation, live: DashLive | undefined, nowSec: number): DashWindow {
  if (rep.template) {
    const w = templateWindow(rep, rep.template, live, nowSec);
    return { first: w.first, last: w.last, media: toPlaylist(w.segments, !live, containerOf(rep)) };
  }
  const media = rep.media ?? toPlaylist([], !live, containerOf(rep));
  const first = media.segments[0]?.sequence ?? 0;
  const last = media.segments.length ? media.segments[media.segments.length - 1]!.sequence : first - 1;
  return { first, last, media };
}

// ---------------------------------------------------------------------------
// Segment information across levels

const SEG_KINDS: SegKind[] = ['SegmentBase', 'SegmentList', 'SegmentTemplate'];

/**
 * The deepest level that has a SegmentBase, SegmentList or SegmentTemplate
 * decides the kind; that kind's attributes then inherit per attribute from the
 * shallower levels, and child elements come from the deepest level that has them.
 */
function segInfoOf(levels: Element[]): SegInfo | undefined {
  let kind: SegKind | undefined;
  for (const level of levels) for (const k of SEG_KINDS) if (kid(level, k)) kind = k;
  if (!kind) return undefined;
  const els = levels.map((l) => kid(l, kind)).filter((e): e is Element => !!e);
  const attrs: Record<string, string> = {};
  for (const e of els) for (const a of Array.from(e.attributes)) attrs[a.localName] = a.value.trim();
  const deepest = (name: string) => {
    for (let i = els.length - 1; i >= 0; i--) {
      const c = kid(els[i], name);
      if (c) return c;
    }
    return undefined;
  };
  let segmentUrls: Element[] = [];
  for (let i = els.length - 1; i >= 0 && !segmentUrls.length; i--) segmentUrls = kids(els[i]!, 'SegmentURL');
  return { kind, attrs, timeline: deepest('SegmentTimeline'), init: deepest('Initialization'), segmentUrls };
}

/** Seconds of media a timeline or a list covers, for Periods whose length the MPD leaves out. */
function segInfoSpan(seg: SegInfo | undefined): number | undefined {
  if (!seg || seg.kind === 'SegmentBase') return undefined;
  const ts = num(seg.attrs.timescale) ?? 1;
  const pto = bigOf(seg.attrs.presentationTimeOffset);
  const entries = timelineOf(seg.timeline);
  if (entries?.length) {
    if (entries[entries.length - 1]!.r < 0) return undefined;
    const list = expandTimeline(entries, undefined, false);
    const lastSeg = list[list.length - 1];
    return lastSeg ? Number(lastSeg.t + BigInt(Math.round(lastSeg.d)) - pto) / ts : undefined;
  }
  const d = num(seg.attrs.duration);
  if (seg.kind === 'SegmentList' && d && seg.segmentUrls.length) return (seg.segmentUrls.length * d) / ts;
  return undefined;
}

// ---------------------------------------------------------------------------
// Walking the MPD

function collectPeriod(period: Element, index: number, start: number, duration: number | undefined, base: string): PeriodDraft {
  const notes: string[] = [];
  const drafts: Draft[] = [];
  const periodBase = baseOf(period, base);
  let webm = 0;
  kids(period, 'AdaptationSet').forEach((set, setIndex) => {
    if (xlinkHref(set)) {
      notes.push('Skipped an adaptation set that loads from another file (xlink), which Magpie does not resolve.');
      return;
    }
    const reps = kids(set, 'Representation');
    const kinds = reps.map((r) => kindOf(set, r));
    // Text and image sets are left out without a note, before their EssentialProperty (thumbnail tiles, fonts) is looked at.
    if (!kinds.some((k) => k === 'video' || k === 'audio')) return;
    const veto = essentialVeto(set);
    if (veto) {
      notes.push(veto);
      return;
    }
    const setBase = baseOf(set, periodBase);
    const setEncrypted = isProtected(set);
    const setRole = roleOf(set);
    reps.forEach((el, i) => {
      const kind = kinds[i];
      if (kind !== 'video' && kind !== 'audio') return;
      const mimeType = attr(el, 'mimeType') ?? attr(set, 'mimeType') ?? '';
      const codecs = attr(el, 'codecs') ?? attr(set, 'codecs');
      const repVeto = essentialVeto(el);
      if (repVeto) {
        notes.push(repVeto);
        return;
      }
      if (/\/webm$/i.test(mimeType)) {
        webm++;
        return;
      }
      const rep: DashRepresentation = {
        id: attr(el, 'id') ?? `${setIndex}-${drafts.length}`,
        type: kind,
        mimeType: mimeType || (kind === 'video' ? 'video/mp4' : 'audio/mp4'),
        codecs,
        bandwidth: num(attr(el, 'bandwidth')),
        width: num(attr(el, 'width') ?? attr(set, 'width')),
        height: num(attr(el, 'height') ?? attr(set, 'height')),
        frameRate: attr(el, 'frameRate') ?? attr(set, 'frameRate'),
        audioSamplingRate: num(attr(el, 'audioSamplingRate') ?? attr(set, 'audioSamplingRate')),
        lang: attr(el, 'lang') ?? attr(set, 'lang'),
        role: setRole ?? roleOf(el),
        encrypted: setEncrypted || isProtected(el),
        setIndex,
        fold: [],
      };
      drafts.push({ rep, base: baseOf(el, setBase), seg: segInfoOf([period, set, el]) });
    });
  });
  if (webm) notes.push(`Skipped ${webm} WebM representation${webm === 1 ? '' : 's'}; WebM DASH is not supported.`);
  let periodDuration = duration;
  if (periodDuration === undefined) {
    for (const d of drafts) {
      const span = segInfoSpan(d.seg);
      if (span !== undefined) periodDuration = Math.max(periodDuration ?? 0, span);
    }
  }
  return { el: period, index, id: attr(period, 'id'), start, duration: periodDuration, drafts, notes };
}

/**
 * Fills `media`, `segmentBase`, `template` and `fold` on a draft. Returns a
 * note instead when the Representation cannot be used. `mpdDir` is the
 * directory of the MPD itself, which no fold rule may cover whole.
 */
function resolveDraft(d: Draft, p: PeriodDraft, live: DashLive | undefined, nowSec: number, mpdDir: string): string | null {
  const { rep, base, seg } = d;
  if (!seg) return 'Skipped a representation with no SegmentBase, SegmentList or SegmentTemplate.';
  const a = seg.attrs;
  const ts = num(a.timescale) ?? 1;
  const initEl = seg.init;
  const initUri = (source: string | undefined) => resolveUrl(fillTemplate(source ?? '', { id: rep.id, bandwidth: rep.bandwidth }), base);

  if (seg.kind === 'SegmentBase') {
    const indexRange = dashRange(a.indexRange);
    if (!indexRange) return 'Skipped a representation whose SegmentBase has no indexRange.';
    rep.segmentBase = {
      url: base,
      initRange: dashRange(attr(initEl, 'range')),
      indexRange,
      presentationTimeOffset: (num(a.presentationTimeOffset) ?? 0) / ts,
    };
    rep.fold = [base];
    return null;
  }

  if (seg.kind === 'SegmentTemplate') {
    if (!a.media) return 'Skipped a representation whose SegmentTemplate has no media pattern.';
    const timeline = timelineOf(seg.timeline);
    const duration = num(a.duration);
    if (!timeline?.length && !duration) return 'Skipped a representation whose SegmentTemplate has neither a duration nor a SegmentTimeline.';
    const initSource = a.initialization ?? attr(initEl, 'sourceURL');
    const init = initSource || initEl ? { uri: initUri(initSource), byteRange: dashRange(attr(initEl, 'range')) } : undefined;
    rep.template = {
      base,
      media: a.media,
      init,
      timescale: ts,
      duration: timeline?.length ? undefined : duration,
      startNumber: num(a.startNumber) ?? 1,
      endNumber: num(a.endNumber),
      presentationTimeOffset: /^\d+$/.test(a.presentationTimeOffset ?? '') ? a.presentationTimeOffset! : '0',
      timeline: timeline?.length ? timeline : undefined,
      availabilityTimeOffset: num(a.availabilityTimeOffset) ?? 0,
      periodStart: p.start,
      periodDuration: p.duration,
    };
    const w = availableRange(rep, live, nowSec);
    rep.media = w.media;
    const rule = templateRule(rep, rep.template, mpdDir);
    rep.fold = [...new Set([...(init ? [init.uri] : []), ...(rule ? [rule] : [])])];
    return null;
  }

  // SegmentList.
  if (!seg.segmentUrls.length) return 'Skipped a representation whose SegmentList has no SegmentURL.';
  const startNumber = num(a.startNumber) ?? 1;
  const pto = bigOf(a.presentationTimeOffset);
  const map = initEl ? { uri: resolveUrl(attr(initEl, 'sourceURL') ?? '', base), byteRange: dashRange(attr(initEl, 'range')) } : null;
  const entries = timelineOf(seg.timeline);
  const times = entries?.length ? expandTimeline(entries, p.duration !== undefined ? pto + BigInt(Math.round(p.duration * ts)) : undefined, false) : undefined;
  const fixed = num(a.duration);
  const segDur = fixed ? fixed / ts : p.duration !== undefined ? p.duration / seg.segmentUrls.length : 0;
  const segments: HlsSegment[] = [];
  seg.segmentUrls.forEach((u, i) => {
    const time = times?.[i];
    if (times && !time) return;
    const start = time ? Number(time.t - pto) / ts : i * segDur;
    let duration = time ? time.d / ts : segDur;
    if (!time && p.duration !== undefined && fixed) duration = Math.max(0, Math.min(segDur, p.duration - start));
    const uri = resolveUrl(attr(u, 'media') ?? '', base);
    segments.push(segment(segments.length, startNumber + i, uri, start, duration, map, dashRange(attr(u, 'mediaRange'))));
  });
  rep.media = toPlaylist(segments, !live, containerOf(rep));
  const rule = listRule(segments.map((s) => s.uri), mpdDir);
  rep.fold = [...new Set([...(map ? [map.uri] : []), ...(rule ? [rule] : [])])];
  return null;
}

/** Stands in for $Number$ and $Time$ while a media pattern is resolved, so templateRule can find where they were. */
const SLOT = 'MAGPIEFOLDSLOT';

/**
 * The fold rule for a template's media segments: the media URL with
 * $RepresentationID$ and $Bandwidth$ filled in, up to the first $Number$ or
 * $Time$ placeholder, then `*`, then what follows the last one. Every segment
 * URL of the representation starts with that prefix and ends with that
 * suffix. A placeholder is marked before the URL is resolved, so an escaped
 * `$$` in the pattern does not cut the rule short. Null when the rule would
 * be too broad (see foldRule).
 */
export function templateRule(rep: DashRepresentation, tpl: DashTemplate, mpdDir: string): string | null {
  const marked = tpl.media.replace(TEMPLATE_RE, (whole, name: string | undefined) => (name === 'Number' || name === 'Time' || name === 'SubNumber' ? SLOT : whole));
  const url = resolveUrl(fillTemplate(marked, { id: rep.id, bandwidth: rep.bandwidth }), tpl.base);
  const first = url.indexOf(SLOT);
  // A pattern without a number or time names one URL for every segment.
  if (first < 0) return url;
  const last = url.lastIndexOf(SLOT) + SLOT.length;
  // A slash between the first and the last placeholder puts them in different directories, and the * spans both.
  return foldRule(url.slice(0, first), url.slice(last), mpdDir, url.slice(first, last).includes('/'));
}

/**
 * The fold rule for a SegmentList's media: the URL itself when every segment
 * is a range of one file, else the longest prefix and suffix all the URLs
 * share (see foldRule). One rule, not one URL per segment, since a long list
 * would otherwise go into storage.session whole.
 */
export function listRule(uris: string[], mpdDir: string): string | null {
  const distinct = [...new Set(uris)];
  if (distinct.length <= 1) return distinct[0] ?? null;
  const shortest = Math.min(...distinct.map((u) => u.length));
  let p = 0;
  while (p < shortest && distinct.every((u) => u[p] === distinct[0]![p])) p++;
  // The suffix stops where the prefix ends, so a URL shorter than both together never matches twice over.
  let s = 0;
  while (s < shortest - p && distinct.every((u) => u[u.length - 1 - s] === distinct[0]![distinct[0]!.length - 1 - s])) s++;
  const first = distinct[0]!;
  // URLs that differ by a slash sit in different directories, and the * would span every directory below the prefix.
  const crosses = distinct.some((u) => u.slice(p, u.length - s).includes('/'));
  return foldRule(first.slice(0, p), first.slice(first.length - s), mpdDir, crosses);
}

/** A suffix that is a file extension and nothing more, like `.mp4`, which every file of that type ends with. */
const EXTENSION_ONLY = /^\.[a-z0-9]+$/i;

/**
 * A fold rule `prefix*suffix`, matched by URLs that start with the prefix and
 * end with the suffix (see matchesFoldRule in detect.ts). Null when the rule
 * is broad and its suffix is empty or only an extension. Broad means the
 * prefix stops at the MPD's own directory, a parent of it, or the root of an
 * origin, or the * spans directories (`crosses`). `*.mp4` there would fold
 * every MP4 beside the MPD, a progressive fallback included, under it, so the
 * representation lists its init URL alone instead.
 */
export function foldRule(prefix: string, suffix: string, mpdDir: string, crosses = false): string | null {
  // A rule splits at its last *, so a * in the suffix would move the split; keep only what follows it.
  const tail = suffix.slice(suffix.lastIndexOf('*') + 1);
  const broad = crosses || mpdDir.startsWith(prefix) || originRoot(prefix);
  if (broad && (!tail || EXTENSION_ONLY.test(tail))) return null;
  return `${prefix}*${tail}`;
}

/** True when `prefix` reaches no further than the root of an origin: `https://cdn.example/`, or a cut inside the host. */
function originRoot(prefix: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/./i.test(prefix);
}

/** The directory an MPD sits in, with its trailing slash. */
function dirOf(url: string): string {
  try {
    return new URL('.', url).href;
  } catch {
    return url;
  }
}

function parseLive(mpd: Element, periodStart: number): DashLive {
  return {
    availabilityStartTime: isoDate(attr(mpd, 'availabilityStartTime')),
    publishTime: isoDate(attr(mpd, 'publishTime')),
    minimumUpdatePeriod: isoDuration(attr(mpd, 'minimumUpdatePeriod')),
    timeShiftBufferDepth: isoDuration(attr(mpd, 'timeShiftBufferDepth')),
    suggestedPresentationDelay: isoDuration(attr(mpd, 'suggestedPresentationDelay')),
    minBufferTime: isoDuration(attr(mpd, 'minBufferTime')),
    periodStart,
    utcTiming: kids(mpd, 'UTCTiming').map((u) => ({ schemeIdUri: attr(u, 'schemeIdUri') ?? '', value: attr(u, 'value') ?? '' })),
  };
}

/**
 * Parses an MPD. `now` is the wall clock in epoch milliseconds, corrected by
 * the caller for the UTCTiming offset; it only matters for dynamic MPDs.
 * Throws on XML that does not parse, a root that is not MPD, an MPD without a
 * Period, and a static MPD whose length cannot be worked out.
 */
export function parseMpd(text: string, manifestUrl: string, now = Date.now()): DashManifest {
  if (typeof DOMParser === 'undefined') throw new Error('parseMpd needs DOMParser: run it in the engine host, not the Chrome service worker.');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (!root || hasParserError(root)) throw new Error('The MPD is not well formed XML.');
  if (root.localName !== 'MPD') throw new Error('Not a DASH manifest: the root element is not MPD.');
  const type = attr(root, 'type') === 'dynamic' ? 'dynamic' : 'static';
  const nowSec = now / 1000;
  const mpdBase = baseOf(root, manifestUrl);
  const mpdDuration = isoDuration(attr(root, 'mediaPresentationDuration'));
  const ast = isoDate(attr(root, 'availabilityStartTime'));

  const periodEls = kids(root, 'Period');
  if (!periodEls.length) throw new Error('The MPD has no Period.');
  const notes: string[] = [];

  // Period starts: Period@start, else the end of the previous Period, else 0.
  const starts: (number | undefined)[] = [];
  const explicit = periodEls.map((p) => isoDuration(attr(p, 'duration')));
  periodEls.forEach((p, i) => {
    const s = isoDuration(attr(p, 'start'));
    const prevStart = starts[i - 1];
    const prevDur = explicit[i - 1];
    starts.push(s ?? (i === 0 ? 0 : prevStart !== undefined && prevDur !== undefined ? prevStart + prevDur : undefined));
  });
  const periods: PeriodDraft[] = [];
  periodEls.forEach((p, i) => {
    if (xlinkHref(p)) {
      notes.push('Skipped a Period that loads from another file (xlink), which Magpie does not resolve.');
      return;
    }
    const start = starts[i] ?? 0;
    const nextStart = starts[i + 1];
    const duration =
      explicit[i] ??
      (nextStart !== undefined ? nextStart - start : i === periodEls.length - 1 && mpdDuration !== undefined ? mpdDuration - start : undefined);
    periods.push(collectPeriod(p, i, start, duration, mpdBase));
  });
  if (!periods.length) throw new Error('Every Period in the MPD loads from another file (xlink), which Magpie does not resolve.');

  let chosen: PeriodDraft;
  if (type === 'dynamic') {
    // The live edge is in the last Period that has started.
    const elapsed = ast !== undefined ? nowSec - ast : Infinity;
    chosen = [...periods].reverse().find((p) => p.start <= elapsed) ?? periods[0]!;
  } else {
    // Multi Period VOD is what server side ad insertion produces, and Period 1 is usually a preroll.
    // A Period whose length is still unknown makes templateWindow throw later, if its segments depend on it.
    chosen = periods.reduce((best, p) => ((p.duration ?? 0) > (best.duration ?? 0) ? p : best), periods[0]!);
  }
  if (periodEls.length > 1) {
    const length = chosen.duration !== undefined ? `, ${fmtDuration(chosen.duration)}` : '';
    notes.push(
      type === 'dynamic'
        ? `Period ${chosen.index + 1} of ${periodEls.length} (the current one${length}) is recorded; other Periods are not joined.`
        : `Period ${chosen.index + 1} of ${periodEls.length} (the longest${length}) is saved; other Periods are not joined.`,
    );
  }
  notes.push(...chosen.notes);

  const live = type === 'dynamic' ? parseLive(root, chosen.start) : undefined;
  const video: DashRepresentation[] = [];
  const audio: DashRepresentation[] = [];
  const mpdDir = dirOf(manifestUrl);
  for (const d of chosen.drafts) {
    const note = resolveDraft(d, chosen, live, nowSec, mpdDir);
    if (note) {
      notes.push(note);
      continue;
    }
    (d.rep.type === 'video' ? video : audio).push(d.rep);
  }
  if (!audio.length) for (const r of video) if (hasVideoCodec(r.codecs) && hasAudioCodec(r.codecs)) r.muxed = true;
  video.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));

  const knownDurations = periods.map((p) => p.duration);
  const sum = periods.length === periodEls.length && knownDurations.every((x) => x !== undefined) ? knownDurations.reduce((a, b) => a! + b!, 0) : undefined;
  return {
    type,
    duration: mpdDuration ?? (type === 'static' ? sum : undefined),
    periodCount: periodEls.length,
    periodIndex: chosen.index,
    periodId: chosen.id,
    periodStart: chosen.start,
    periodDuration: chosen.duration,
    video,
    audio,
    notes: [...new Set(notes)],
    live,
  };
}

// ---------------------------------------------------------------------------
// Choosing and labelling

function codecRank(r: DashRepresentation): number {
  return codecList(r.codecs).some((c) => codecFamily(c) === 'mp4a') ? 0 : 1;
}

/**
 * The audio to merge: the set with Role main, else the first audio set; within
 * it mp4a before ec-3, ac-3, opus or flac, then the highest bandwidth. When the
 * chosen set has no mp4a but a set with the same language and role does, that
 * set wins, since Chrome cannot decode E-AC-3 and the saved file would be silent.
 */
export function chooseAudio(manifest: DashManifest): DashRepresentation | undefined {
  const audio = manifest.audio;
  if (!audio.length) return undefined;
  const isMain = (r: DashRepresentation) => r.role?.toLowerCase() === 'main';
  let setIndex = (audio.find(isMain) ?? audio[0]!).setIndex;
  const inSet = (i: number) => audio.filter((r) => r.setIndex === i);
  if (!inSet(setIndex).some((r) => codecRank(r) === 0)) {
    const first = inSet(setIndex)[0]!;
    const twin = audio.find((r) => r.setIndex !== setIndex && codecRank(r) === 0 && (r.lang ?? '') === (first.lang ?? '') && (r.role ?? '') === (first.role ?? ''));
    if (twin) setIndex = twin.setIndex;
  }
  return [...inSet(setIndex)].sort((a, b) => codecRank(a) - codecRank(b) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
}

/** Label in the HLS variantLabel style: "1280x720 · 2014 kbps · avc1.64001f". */
export function videoLabel(rep: DashRepresentation): string {
  const parts: string[] = [];
  if (rep.width && rep.height) parts.push(`${rep.width}x${rep.height}`);
  if (rep.type === 'audio' && rep.lang && rep.lang !== 'und') parts.push(languageName(rep.lang));
  if (rep.bandwidth) parts.push(`${(rep.bandwidth / 1000).toFixed(0)} kbps`);
  if (rep.codecs) parts.push(rep.codecs);
  return parts.join(' · ') || rep.id;
}

/**
 * Server time in epoch seconds from a UTCTiming element: `body` is the
 * response to a GET of `value` for http-xsdate and http-iso, or the Date header
 * of a HEAD for http-head. The direct scheme carries the time in `value`.
 * Undefined for schemes Magpie does not implement (NTP, SNTP).
 */
export function utcTimingTime(timing: DashUtcTiming, body?: string): number | undefined {
  const scheme = timing.schemeIdUri.toLowerCase();
  if (/^urn:mpeg:dash:utc:direct:201[24]$/.test(scheme)) return isoDate(timing.value);
  if (/^urn:mpeg:dash:utc:http-(xsdate|iso):201[24]$/.test(scheme)) return isoDate(body);
  if (/^urn:mpeg:dash:utc:http-head:201[24]$/.test(scheme)) {
    const ms = body ? Date.parse(body.trim()) : NaN;
    return Number.isNaN(ms) ? undefined : ms / 1000;
  }
  return undefined;
}
