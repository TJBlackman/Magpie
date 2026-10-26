import { manifestUrl } from './detect';
import type { Candidate } from './types';

/** One finished download. Kept small on purpose: what it was, when, how long, and where it came from. */
export interface ArchiveEntry {
  /** The job id. */
  id: string;
  /** Page title at download time, '' when the page had none. */
  title: string;
  /** Saved file name. Shown when there is no title, and as the row's tooltip. */
  file: string;
  /** Page the video played on, '' when unknown or too long to keep. */
  page: string;
  /** streamKey() of the stream, for matching only. */
  src: string;
  /** When the download finished, ms. */
  at: number;
  /** Length in seconds, when known. */
  secs?: number;
  /** Downloaded in a private window. Kept out of storage.local unless the user allows it. */
  priv?: true;
}

export const ARCHIVE_KEY = 'archive';
const MAX_TEXT = 300;
const MAX_URL = 2000;
const MAX_SRC = 4000;

/** Query parameter names that carry signatures, expiry times and cache busters, never the video. */
const VOLATILE_NAMES = new Set([
  '_', 't', 'ts', 'time', 'timestamp', 'cb', 'cachebust', 'rnd', 'rand', 'nonce',
  'token', '__token__', 'sig', 'signature', 'hmac', 'acl', 'expires', 'expiry', 'exp',
  'policy', 'key-pair-id', 'hdnts', 'hdnea', 'md5',
]);
const VOLATILE_PREFIXES = ['x-amz-', 'x-goog-'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Unix time from 2020 to 2049 in seconds or milliseconds. Expiry times and cache busters sit near now. */
export function epochLike(value: string): boolean {
  if (/^\d{10}$/.test(value)) return Number(value) >= 1.6e9 && Number(value) <= 2.5e9;
  if (/^\d{13}$/.test(value)) return Number(value) >= 1.6e12 && Number(value) <= 2.5e12;
  return false;
}

/** A query parameter that changes between visits to the same video. A time shaped value under an id name (`id`, `vid`, `media_id`) is an id. */
export function volatileParam(name: string, value: string): boolean {
  const n = name.toLowerCase();
  return VOLATILE_NAMES.has(n) || VOLATILE_PREFIXES.some((p) => n.startsWith(p)) || (epochLike(value) && !n.endsWith('id'));
}

/**
 * A long opaque value with letters and digits under an unknown name: a
 * signature or session token. UUIDs and hex strings (ObjectIds, SHA-1 and MD5
 * hashes) are kept, since sites use them as video ids.
 */
function tokenLike(value: string): boolean {
  return value.length >= 16 && /\d/.test(value) && /[a-z]/i.test(value) && !UUID.test(value) && !/^[0-9a-f]+$/i.test(value);
}

/** A path segment that carries a token: `exp=...~acl=...~hmac=...` style, a known signing key, or a Unix time. */
const PATH_TOKEN = /^(exp|expires|token|__token__|hdnts|hdntl|hdnea|hmac|sig|signature|acl|policy)=/i;
function tokenSegment(segment: string): boolean {
  return /~|%7e/i.test(segment) || PATH_TOKEN.test(segment) || epochLike(segment);
}

function parse(url: string): URL | null {
  try {
    return new URL(manifestUrl(url));
  } catch {
    return null;
  }
}

function build(u: URL, path: string, keep: (name: string, value: string) => boolean): string {
  const params = [...u.searchParams].filter(([k, v]) => keep(k, v)).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const q = new URLSearchParams(params).toString();
  return `${u.origin}${path}${q ? `?${q}` : ''}`;
}

/**
 * The stream's identity across visits: origin, path, and the query without
 * LL-HLS directives, signatures, expiry times and cache busters. Ids like
 * `?id=1234567` stay, so two videos behind one endpoint keep apart.
 */
export function streamKey(url: string): string {
  const u = parse(url);
  return u ? build(u, u.pathname, (k, v) => !volatileParam(k, v)) : url;
}

/**
 * A looser key, only ever compared between streams of the same page. Path
 * segments holding a token (`exp=...~acl=...~hmac=...`) or a Unix time become
 * `*`, and long opaque query values are dropped too.
 */
export function skeleton(url: string): string {
  const u = parse(url);
  if (!u) return url;
  const path = u.pathname
    .split('/')
    .map((s) => (tokenSegment(s) ? '*' : s))
    .join('/');
  return build(u, path, (k, v) => !volatileParam(k, v) && !tokenLike(v));
}

const TRACKING = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid)$/i;

/** The page without its hash and tracking parameters, or '' for anything but http(s). */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.hash = '';
    u.search = new URLSearchParams([...u.searchParams].filter(([k]) => !TRACKING.test(k))).toString();
    return u.toString();
  } catch {
    return '';
  }
}

export interface ArchiveIndex {
  src: Set<string>;
  /** pageKey and skeleton, joined by a space. */
  page: Set<string>;
}

export function indexArchive(entries: ArchiveEntry[]): ArchiveIndex {
  const index: ArchiveIndex = { src: new Set(), page: new Set() };
  for (const e of entries) {
    if (e.src) index.src.add(e.src);
    const p = pageKey(e.page);
    if (p && e.src) index.page.add(`${p} ${skeleton(e.src)}`);
  }
  return index;
}

type Seen = Pick<Candidate, 'url' | 'pageUrl' | 'live'>;

/**
 * True when the candidate is a stream the archive already has: the same stream
 * key on any page, or the same page with the same stream shape. A live stream
 * never is; its next recording holds new footage.
 *
 * `siblings` are the other streams in the same tab. When one of them has the
 * same page and shape but another stream key, the shape cannot tell the videos
 * apart (a course page, a feed), so only the exact stream key counts.
 */
export function isArchived(c: Seen, index: ArchiveIndex, siblings: Seen[] = []): boolean {
  if (c.live) return false;
  const key = streamKey(c.url);
  if (index.src.has(key)) return true;
  const p = pageKey(c.pageUrl);
  if (!p) return false;
  const shape = skeleton(c.url);
  if (!index.page.has(`${p} ${shape}`)) return false;
  return !siblings.some((s) => pageKey(s.pageUrl) === p && skeleton(s.url) === shape && streamKey(s.url) !== key);
}

/** The entry for a finished job. */
export function makeEntry(
  job: { id: string; filename: string; finishedAt?: number },
  candidate: Pick<Candidate, 'url' | 'pageUrl' | 'pageTitle' | 'incognito'>,
  secs?: number,
): ArchiveEntry {
  const src = streamKey(candidate.url);
  const entry: ArchiveEntry = {
    id: job.id,
    title: candidate.pageTitle.slice(0, MAX_TEXT),
    file: job.filename.slice(0, MAX_TEXT),
    // A cut URL would be a broken link, so a huge one is not kept at all.
    page: candidate.pageUrl.length <= MAX_URL ? candidate.pageUrl : '',
    src: src.length <= MAX_SRC ? src : '',
    at: job.finishedAt ?? Date.now(),
  };
  if (secs !== undefined && Number.isFinite(secs) && secs > 0) entry.secs = Math.round(secs * 10) / 10;
  if (candidate.incognito) entry.priv = true;
  return entry;
}

/** Newest first, one entry per id, at most `max`. */
export function addEntry(list: ArchiveEntry[], entry: ArchiveEntry, max: number): ArchiveEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, Math.max(0, max));
}

/** Entries read from storage, which may be missing, stale or hand edited. Newest first. */
export function normalizeArchive(raw: unknown): ArchiveEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ArchiveEntry[] = [];
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : '');
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
    const e: ArchiveEntry = {
      id: r.id,
      title: str(r.title, MAX_TEXT),
      file: str(r.file, MAX_TEXT),
      page: str(r.page, MAX_URL),
      src: str(r.src, MAX_SRC),
      at: r.at,
    };
    if (typeof r.secs === 'number' && Number.isFinite(r.secs) && r.secs > 0) e.secs = r.secs;
    if (r.priv === true) e.priv = true;
    out.push(e);
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Both stores read back as one list: one entry per id, newest first. Nothing is trimmed here. */
export function mergeStores(local: ArchiveEntry[], session: ArchiveEntry[]): ArchiveEntry[] {
  const byId = new Map<string, ArchiveEntry>();
  for (const e of [...local, ...session]) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

/**
 * Where each entry is stored. Private window entries go to storage.session,
 * which the browser clears when it closes, unless the user keeps them.
 */
export function splitForStorage(entries: ArchiveEntry[], keepPrivate: boolean): { local: ArchiveEntry[]; session: ArchiveEntry[] } {
  if (keepPrivate) return { local: entries, session: [] };
  return { local: entries.filter((e) => !e.priv), session: entries.filter((e) => e.priv) };
}
