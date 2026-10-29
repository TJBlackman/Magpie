import type { ArchiveEntry } from './archive';
import type { RedditPost } from './reddit';
import type { Settings } from './settings';

/** `post` is a Reddit post read from the page: a row whose download is every file of the post. */
export type MediaKind = 'hls' | 'dash' | 'file' | 'post';

/**
 * One file of a post. The post's files download as ordinary jobs that share a
 * group; the post goes to history once, when the last of them is saved.
 */
export interface AssetGroup {
  id: string;
  /** 0 based place of this file among the group's. */
  index: number;
  total: number;
  /** The post row, so the card grays while any of its files is on Downloads. */
  candidateId: string;
  /** The post, for its history entry. */
  post: Pick<Candidate, 'url' | 'pageUrl' | 'pageTitle' | 'incognito' | 'kind' | 'thumb'>;
}

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
  /** Set on a variant or rendition playlist whose master is listed, or a file an MPD lists; such rows are hidden. */
  parentId?: string;
  /**
   * For a master playlist: the variant and rendition playlist URLs it lists.
   * For an MPD: fold rules for the files its representations fetch, each an
   * exact URL or `prefix*suffix` (see Inspection.children).
   */
  children?: string[];
  /** Seen in a private window. */
  incognito?: boolean;
  /** Set on copies sent to the UI when the archive already has this stream. Never stored. */
  archived?: boolean;
  /** One frame of the stream as a small JPEG data URL, once captured. For a post, the URL of its preview image. */
  thumb?: string;
  /** The Reddit post this row is, with the files it saves. */
  post?: RedditPost;
  /** Set on one file of a post, a candidate the background makes for the engine. */
  group?: AssetGroup;
  /** Where to save, relative to the downloads folder, with extension. Replaces the name built from the title. */
  saveAs?: string;
}

export interface Variant {
  id: string;
  label: string;
  /** Absolute URL of the media playlist, or the file itself. */
  uri: string;
  bandwidth?: number;
  resolution?: string;
  codecs?: string;
  /** AUDIO group of a variant whose main audio is a separate rendition, merged or not. */
  audioGroup?: string;
  /**
   * The separate audio merged into this variant's file: the rendition playlist
   * (HLS) or the audio init segment (DASH). Unset when the download is video
   * only, see the inspection notes for why.
   */
  audioUri?: string;
  /** Name or language of the audio that will be merged, for labels. */
  audioLabel?: string;
  /** No video: an audio only DASH representation, saved as .m4a. */
  audioOnly?: boolean;
}

export interface Inspection {
  candidateId: string;
  kind: MediaKind;
  variants: Variant[];
  /** Human readable notes, e.g. "live stream, records until you press Stop". */
  notes: string[];
  /** Media playlist without EXT-X-ENDLIST, or a dynamic MPD. Unknown for an HLS master. */
  live?: boolean;
  /**
   * For a master playlist: every variant and rendition playlist URL it lists.
   * For an MPD: rules that fold the player's own requests under it, so they
   * get no rows of their own. Per representation, the exact URL of its init
   * segment, and for its media either the exact URL (a SegmentBase file, or a
   * SegmentList whose segments are ranges of one file) or one rule
   * `prefix*suffix`, which matches any URL that starts with the prefix and
   * ends with the suffix: for a SegmentTemplate the media URL up to its first
   * $Number$ or $Time$ placeholder and after its last, for a SegmentList what
   * every segment URL shares at each end. A rule that would cover the MPD's
   * own directory with no suffix is left out. So at most two strings per
   * representation, however many segments it has, since candidates live in
   * storage.session.
   */
  children?: string[];
}

/**
 * A job is listed while it waits, runs or has failed. One that finishes leaves
 * the list for history the moment it is saved, and a cancelled one leaves at once.
 */
export type JobState = 'queued' | 'inspecting' | 'downloading' | 'muxing' | 'saving' | 'error';

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
  /** The candidate's frame, so the row looks the same as it did on the page. */
  thumb?: string;
  /** One file of a post: the Downloads tab lists the group as one row. `saved` is how many of the group's files are saved so far. */
  group?: Pick<AssetGroup, 'id' | 'index' | 'total' | 'candidateId'> & { saved?: number };
  startedAt: number;
  /** When the job failed. */
  finishedAt?: number;
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
  | { type: 'clearFailed' }
  | { type: 'activeTab' }
  | { type: 'archive' }
  | { type: 'removeArchive'; id: string }
  | { type: 'clearArchive' }
  /** Thumbnails for rows that arrived in a change event, which carries none. Answered with a ThumbMap. */
  | { type: 'thumbs'; jobs?: string[]; archive?: string[] }
  /** Read version.json if the last check is old enough. Answers at once; the result lands in storage.local under UPDATE_KEY. */
  | { type: 'checkUpdate' };

/** Messages the background forwards to the engine host. */
export type EngineRequest =
  | { type: 'inspect'; candidate: Candidate }
  | { type: 'thumbnail'; candidate: Candidate }
  | { type: 'start'; candidate: Candidate; variantId: string; settings: Settings }
  | { type: 'configure'; settings: Settings }
  | { type: 'cancel'; jobId: string }
  | { type: 'stop'; jobId: string }
  | { type: 'jobs' }
  | { type: 'removeJob'; jobId: string }
  | { type: 'clearFailed' };

/** Messages the engine host sends to the background (Chrome offscreen path). */
export type EngineToBg =
  | { type: 'saveBlob'; blobUrl: string; filename: string; jobId: string }
  | { type: 'headerRule'; host: string; referer: string; origin: string }
  | { type: 'jobsChanged'; jobs: Job[] }
  | { type: 'archive'; entry: ArchiveEntry };

export type Envelope =
  | { magpie: 'bg'; req: UiRequest }
  | { magpie: 'engine'; req: EngineRequest }
  | { magpie: 'engine-to-bg'; req: EngineToBg }
  /** Change events. `jobs` and `archive` rows come without thumbnails; the UI keeps those from list answers and asks `thumbs` for new rows. */
  | { magpie: 'ui'; event: { type: 'jobs'; jobs: Job[] } | { type: 'candidates'; tabId: number } | { type: 'archive'; entries: ArchiveEntry[] } };

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
