/*
 * The update check. The background reads version.json from the website at most
 * every 12 hours and keeps the answer in storage.local; the popup compares it
 * with the installed version. The request carries no version, ID or cookie.
 */

export const SITE_URL = 'https://magpie.trevorblackman.dev/';
export const VERSION_URL = `${SITE_URL}version.json`;
/** What the last check found. Written by the background. */
export const UPDATE_KEY = 'update';
/** The newer version whose banner the user closed. Written by the popup, so the two never overwrite each other. */
export const DISMISSED_KEY = 'updateDismissed';
export const CHECK_EVERY = 12 * 3_600_000;
/** After a check that failed, the next one is due sooner. */
export const RETRY_EVERY = 30 * 60_000;

export interface UpdateState {
  /** When the last check ended, whether it reached the website or not. 0 for never. */
  checkedAt: number;
  ok: boolean;
  /** The version on the website, from the last check that reached it. */
  latest: string | null;
}

/** [major, minor, patch] from "0.5.1". Anything after the three numbers ("0.5.1 preview") is ignored. */
function parts(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? m.slice(1).map(Number) : null;
}

/** Whether version a comes after version b. False when either is unreadable. */
export function isNewer(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** The version in version.json, or null when the file is not what we expect. */
export function parseVersionFile(raw: unknown): string | null {
  const v = raw && typeof raw === 'object' ? (raw as { version?: unknown }).version : undefined;
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

/** Fill gaps in a stored state, which may be missing or from an older build. */
export function normalizeUpdate(raw: unknown): UpdateState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof UpdateState, unknown>>;
  return {
    checkedAt: typeof o.checkedAt === 'number' && Number.isFinite(o.checkedAt) ? o.checkedAt : 0,
    ok: o.ok === true,
    latest: parseVersionFile({ version: o.latest }),
  };
}

/** Whether it is time to ask the website again. A clock that moved backwards counts as due. */
export function checkDue(state: UpdateState, now: number): boolean {
  const age = now - state.checkedAt;
  return age < 0 || age >= (state.ok ? CHECK_EVERY : RETRY_EVERY);
}

/** The version to tell the user about, or null when the installed one is current. */
export function updateFor(state: UpdateState, installed: string): string | null {
  return state.latest && isNewer(state.latest, installed) ? state.latest : null;
}
