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
  /** Human readable notes, e.g. "live stream, only listed segments will be saved". */
  notes: string[];
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
  | { type: 'jobs' }
  | { type: 'removeJob'; jobId: string }
  | { type: 'activeTab' }
  | { type: 'openSettings' };

/** Messages the background forwards to the engine host. */
export type EngineRequest =
  | { type: 'inspect'; candidate: Candidate }
  | { type: 'start'; candidate: Candidate; variantId: string; settings: Settings }
  | { type: 'configure'; settings: Settings }
  | { type: 'cancel'; jobId: string }
  | { type: 'jobs' }
  | { type: 'removeJob'; jobId: string };

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
