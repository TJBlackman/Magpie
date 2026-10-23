import type { Settings } from './settings';

export type MediaKind = 'hls' | 'dash' | 'file';

/** A piece of media the sniffer saw a tab load. */
export interface Candidate {
  id: string;
  tabId: number;
  url: string;
  kind: MediaKind;
  mime: string;
  contentLength: number | null;
  pageUrl: string;
  pageTitle: string;
  /** Referer the page's own request carried, replayed on our fetches. */
  referer: string;
  seenAt: number;
  /** The player keeps reloading this manifest, or its playlist has no end: a live stream. */
  live?: boolean;
  /** How often the page reloaded this manifest after the first sighting. */
  reloads?: number;
  /** Set on a variant or rendition playlist whose master is listed; such rows are hidden. */
  parentId?: string;
  /** For a master playlist: the variant and rendition playlist URLs it lists. */
  children?: string[];
}

export interface Variant {
  id: string;
  label: string;
  /** Absolute URL of the media playlist, or the file itself. */
  uri: string;
  bandwidth?: number;
  resolution?: string;
  codecs?: string;
  /** Set when the variant relies on a separate audio rendition (not merged in v1). */
  audioGroup?: string;
  audioUri?: string;
}

export interface Inspection {
  candidateId: string;
  kind: MediaKind;
  variants: Variant[];
  /** Human readable notes, e.g. "live stream, records until you press Stop". */
  notes: string[];
  /** Media playlist without EXT-X-ENDLIST. Unknown for a master. */
  live?: boolean;
  /** For a master playlist: every variant and rendition playlist URL it lists. */
  children?: string[];
}

export type JobState =
  | 'queued'
  | 'inspecting'
  | 'downloading'
  | 'muxing'
  | 'saving'
  | 'done'
  | 'error'
  | 'cancelled';

/** Done, failed or cancelled: nothing more will happen to the job. */
export const isFinished = (state: JobState) => state === 'done' || state === 'error' || state === 'cancelled';

export interface Job {
  id: string;
  candidateId: string;
  title: string;
  filename: string;
  url: string;
  kind: MediaKind;
  variantLabel: string;
  state: JobState;
  segmentsTotal: number;
  segmentsDone: number;
  bytes: number;
  /** Full size when the server tells us (plain files); drives the progress bar. */
  bytesTotal?: number;
  /** 1 based place in the queue while state is 'queued'. */
  queuePosition?: number;
  /** Recording a live stream: runs until Stop or the stream ends. */
  live?: boolean;
  /** Seconds of media saved so far (live recordings). */
  duration?: number;
  /** Something the user should know that is not an error, e.g. a gap in a recording. */
  note?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  downloadId?: number;
}

/** Messages the UI sends to the background. The background answers or forwards. */
export type UiRequest =
  | { type: 'candidates'; tabId?: number }
  | { type: 'clearCandidates'; tabId: number }
  | { type: 'inspect'; candidateId: string }
  | { type: 'start'; candidateId: string; variantId: string }
  | { type: 'cancel'; jobId: string }
  | { type: 'stop'; jobId: string }
  | { type: 'jobs' }
  | { type: 'removeJob'; jobId: string }
  | { type: 'clearFinished' }
  | { type: 'activeTab' }
  | { type: 'openSettings' };

/** Messages the background forwards to the engine host. */
export type EngineRequest =
  | { type: 'inspect'; candidate: Candidate }
  | { type: 'start'; candidate: Candidate; variantId: string; settings: Settings }
  | { type: 'configure'; settings: Settings }
  | { type: 'cancel'; jobId: string }
  | { type: 'stop'; jobId: string }
  | { type: 'jobs' }
  | { type: 'removeJob'; jobId: string }
  | { type: 'clearFinished' };

/** Messages the engine host sends to the background (Chrome offscreen path). */
export type EngineToBg =
  | { type: 'saveBlob'; blobUrl: string; filename: string; jobId: string }
  | { type: 'headerRule'; host: string; referer: string; origin: string }
  | { type: 'jobsChanged'; jobs: Job[] };

export type Envelope =
  | { magpie: 'bg'; req: UiRequest }
  | { magpie: 'engine'; req: EngineRequest }
  | { magpie: 'engine-to-bg'; req: EngineToBg }
  | { magpie: 'ui'; event: { type: 'jobs'; jobs: Job[] } | { type: 'candidates'; tabId: number } };

export interface Ok<T> {
  ok: true;
  value: T;
}
export interface Err {
  ok: false;
  error: string;
}
export type Result<T> = Ok<T> | Err;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = (error: string): Err => ({ ok: false, error });
