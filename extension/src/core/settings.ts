/** User settings, stored in storage.local under SETTINGS_KEY. */
export interface Settings {
  /** Downloads that may run at once. Extra ones wait in a first in, first out queue. */
  maxConcurrent: number;
  /** Finished downloads the archive keeps, newest first. 0 turns the archive off. */
  archiveSize: number;
  /** Keep archive entries from private windows after the browser closes. */
  archivePrivate: boolean;
  /** Fetch one small piece of each stream and show a frame of it on its row. */
  thumbnails: boolean;
}

export const SETTINGS_KEY = 'settings';
export const MAX_CONCURRENT_LIMIT = 10;
export const ARCHIVE_LIMIT = 500;
export const DEFAULT_SETTINGS: Settings = { maxConcurrent: 2, archiveSize: 25, archivePrivate: false, thumbnails: true };

/** A whole number from storage clamped to [min, max], or `fallback` when there is none. */
function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.round(v) : typeof v === 'string' && v.trim() ? Math.round(Number(v)) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Fill gaps and clamp values from storage, which may be missing or stale. */
export function normalizeSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    maxConcurrent: int(o.maxConcurrent, 1, MAX_CONCURRENT_LIMIT, DEFAULT_SETTINGS.maxConcurrent),
    archiveSize: int(o.archiveSize, 0, ARCHIVE_LIMIT, DEFAULT_SETTINGS.archiveSize),
    archivePrivate: o.archivePrivate === true,
    thumbnails: o.thumbnails !== false,
  };
}
