/** User settings, stored in storage.local under SETTINGS_KEY. */
export interface Settings {
  /** Downloads that may run at once. Extra ones wait in a first in, first out queue. */
  maxConcurrent: number;
}

export const SETTINGS_KEY = 'settings';
export const MAX_CONCURRENT_LIMIT = 10;
export const DEFAULT_SETTINGS: Settings = { maxConcurrent: 2 };

/** Fill gaps and clamp values from storage, which may be missing or stale. */
export function normalizeSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const n = Math.round(Number(o.maxConcurrent));
  return {
    maxConcurrent: Number.isFinite(n) ? Math.min(MAX_CONCURRENT_LIMIT, Math.max(1, n)) : DEFAULT_SETTINGS.maxConcurrent,
  };
}
