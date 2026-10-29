import { liveStartIndex, parseHls, variantLabel, type ByteRange, type HlsRendition, type HlsSegment, type MediaPlaylist } from '../core/hls';
import { availableRange, chooseAudio, parseMpd, utcTimingTime, videoLabel, type DashLive, type DashManifest, type DashRepresentation, type DashUtcTiming } from '../core/dash';
import { fmtDuration, languageName } from '../core/format';
import { segmentsFromSidx } from '../core/sidx';
import { buildFilename, withPart, withTimestamp } from '../core/filename';
import { err, ok, type Candidate, type Inspection, type Job, type Result, type Variant } from '../core/types';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../core/settings';
import { makeEntry } from '../core/archive';
import { decryptSegment } from './crypto';
import { mp4Duration } from './duration';
import { fetchBytes, fetchRange, fetchText, HttpError, orderedPool, RangeIgnoredError } from './fetcher';
import { Merger, mergePass, PARALLEL, SIDES, WINDOW, type Container, type PassSide } from './merge';
import { boxes, passthroughSink, patchDurations, sniffContainer, tsSink, type Side, type Sink, type Write } from './mux';
import type { Platform } from './platform';
import { OutputFile } from './store';
import { FILE_SAMPLE, SEGMENT_CAP, THUMB_TIMEOUT, fetchPrefix, frameFromMp4 } from './thumbnail';
import { withoutThumb } from '../core/thumbs';

/** A live recording starts this many seconds back, to cover what the player was showing. */
const LIVE_LEAD_IN = 30;
/**
 * Failures in a row after which a live recording ends and saves what it has:
 * playlist or MPD reloads that fail, and for live DASH also passes that had
 * segments of one side to fetch and loaded none of them, which must last
 * LIVE_DEAD_MS and LIVE_DEAD_SEGMENTS as well (see LiveCursor.endPass).
 */
const LIVE_MAX_FAILURES = 6;
/**
 * A live DASH side that loads nothing ends the recording only once this much
 * wall clock has passed too, and this many of its segment durations. Passes
 * run as often as once a second, so six of them alone end a stream whose
 * packager publishes a 7 s segment 6 s after the clock names it.
 */
const LIVE_DEAD_MS = 30_000;
const LIVE_DEAD_SEGMENTS = 3;
/**
 * Seconds between reloads of a live MPD: its minimumUpdatePeriod, this default
 * when it gives none, never more often than the floor and never less often
 * than the cap, so a recording notices Stop and the end of the stream in time.
 */
const MPD_RELOAD_DEFAULT = 2;
const MPD_RELOAD_MIN = 1;
const MPD_RELOAD_MAX = 10;
/** How long inspecting a live MPD waits for its UTCTiming time server before it trusts the local clock. */
const CLOCK_TIMEOUT = 3000;
const MAX_INSPECTIONS = 100;
/**
 * How long an inspection is trusted, in milliseconds. Signed segment URLs
 * expire and a manifest can be replaced, so start() inspects again past this
 * age, and a DASH download that waited in the queue longer reads its MPD again
 * when it runs, as an HLS download reads its playlist again in run().
 */
const INSPECTION_MAX_AGE = 10 * 60 * 1000;
/**
 * Without OPFS (Firefox private windows) a recording lives in memory until it is
 * saved, and saving briefly needs about twice its size. Live recordings there
 * are saved in parts of this size so a long stream cannot use up the RAM.
 */
const MEMORY_PART_BYTES = 2 * 1024 ** 3;
const PART_NOTE = 'Firefox private windows keep recordings in memory, so this one is saved in parts of 2 GB as it goes.';

// Why a separate audio track is not merged. Each says what the download holds instead.
const AUDIO_LIVE = 'Live streams with separate audio record video only.';
const AUDIO_MASTER = 'The audio rendition points at another master playlist; video only.';
const audioUnreadable = (e: unknown) => `The audio rendition could not be read (${describe(e)}); video only.`;
const AUDIO_EMPTY = 'The audio rendition lists no segments, so it is not merged; video only.';
const AUDIO_NO_INIT = 'The stream names fMP4 segments but no init segment, so its separate audio is not merged; video only.';
const AUDIO_DISCONTINUITY = 'The stream has discontinuities (usually ad breaks), so its separate audio is not merged; video only.';
const AUDIO_NEW_INIT = 'The stream switches to another init segment partway through, so its separate audio is not merged; video only.';
const DRM_MPD = 'This stream uses DRM (the MPD marks its video or its audio protected), which Magpie does not download.';
const DRM_INIT = 'This stream uses DRM (its init segment is encrypted), which Magpie does not download.';
const DASH_NO_AUDIO = 'No audio representation in the MPD can be used (see above), so the download is video only.';
// Live DASH: what cannot be recorded.
const LIVE_SEGMENT_BASE = 'This live MPD addresses its media with SegmentBase, which Magpie cannot record.';
const liveTs = (side: 'video' | 'audio') => `This live MPD serves its ${side} as MPEG-TS segments, which Magpie does not record yet.`;
// Why a live recording ended early. A recording that ends early saves what it has, and the reason becomes the job's
// note (liveEnded); one that ends before its first segment fails with the reason instead (nothingRecorded).
const LIVE_LEFT = 'A track the recording followed left the MPD';
const LIVE_PERIOD = 'The stream moved on to another Period (often an ad break or the next programme)';
const LIVE_RESTART = 'The stream restarted (its MPD has a new availabilityStartTime)';
const LIVE_NEW_INIT = 'The stream switched to another init segment';
const LIVE_TIMES_BACK = 'The stream restarted (its segment times went back)';
const LIVE_SILENT = 'The stream stopped answering';
const liveEnded = (why: string) => `${why}, so the recording ended there.`;
const nothingRecorded = (why: string | undefined) => (why ? `${why} before anything was recorded.` : 'No segments were recorded.');
const LIVE_GAP = 'Some seconds are missing: segments left the live window before they could be fetched.';

/** Where a live recording writes, and how it starts a new part. */
interface LiveOutput {
  current(): OutputFile;
  /** Save the current file as a finished part and open the next one. */
  nextPart(): Promise<void>;
}
const LIVE_NOTE = 'Live stream. Download records from about 30 seconds back until you press Stop or the stream ends.';

/**
 * Stop for a live recording: unlike cancel, the job finishes its current step,
 * fetches the playlist once more, and saves. Also cuts its waits short.
 */
class StopFlag {
  requested = false;
  private wake: (() => void) | null = null;

  request(): void {
    this.requested = true;
    this.wake?.();
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done);
      this.wake = done;
      if (this.requested || signal.aborted) done();
    });
  }
}

/** One stream of a download: its segments, and whether the last one may be missing. */
export interface Track {
  media: MediaPlaylist;
  /**
   * A DASH $Number$ template lists ceil(duration / segment) segments, and
   * packagers round differently, so the last one may not exist. A 403, 404 or
   * 410 there is skipped instead of failing the job (see missingLast).
   */
  lastOptional?: boolean;
}

/** What a DASH variant downloads, resolved at inspect time so run() never reads the MPD as a playlist. */
interface DashPlan {
  /** The video representation, or the audio one when the MPD has no video. */
  main: Track;
  /** The separate audio merged into the file. */
  audio?: Track;
  /** Set for a dynamic MPD: the variant is recorded, and the recorder reads the MPD again on its own schedule. */
  live?: DashLivePlan;
  /** When the MPD text the plan came from was fetched, epoch ms (see INSPECTION_MAX_AGE). */
  readAt: number;
}

/** What a live DASH recording follows from one MPD reload to the next. */
interface DashLivePlan {
  /** Representation ids, looked up again in every reload. */
  mainId: string;
  mainType: 'video' | 'audio';
  audioId?: string;
  /** Seconds the server's clock is ahead of the local one, from the MPD's UTCTiming at inspect time. */
  clockOffset: number;
}

/**
 * What an inspected MPD keeps for start() and thumbnail(). Every expanded
 * segment list of every representation, for up to MAX_INSPECTIONS candidates,
 * is a lot of memory for MPDs most of which are never downloaded, so only the
 * text is kept and parsed again when a variant is needed (parseMpd takes
 * milliseconds). A SegmentBase representation's segments come from its sidx,
 * which costs a fetch, so the lists read at inspect are kept too.
 */
interface DashSource {
  text: string;
  url: string;
  /** When the text was fetched, epoch ms. */
  at: number;
  /** Seconds the server's clock is ahead of the local one (see DashLivePlan). */
  clockOffset: number;
  /** Segment lists read from the sidx of SegmentBase representations, by repKey. */
  indexed: Record<string, MediaPlaylist>;
  /** What each variant downloads, by variant id: repKey of the main representation and of the merged audio. */
  picks: Record<string, { main: string; audio?: string }>;
}

interface Inspected {
  candidate: Candidate;
  inspection: Inspection;
  /** When the inspection was made, epoch ms (see staleInspection). */
  at: number;
  /** A media playlist inspected directly, not through a master. */
  media?: MediaPlaylist;
  /** DASH: the MPD to read the variants' plans from again (see dashPlan). */
  dash?: DashSource;
}

interface Running {
  job: Job;
  abort: AbortController;
  stop: StopFlag;
}

interface Queued {
  job: Job;
  candidate: Candidate;
  variant: Variant;
  media?: MediaPlaylist;
  dash?: DashPlan;
}

export class Engine {
  private jobs = new Map<string, Job>();
  private running = new Map<string, Running>();
  /** Jobs waiting for a free slot, oldest first. */
  private queue: Queued[] = [];
  private maxConcurrent = DEFAULT_SETTINGS.maxConcurrent;
  /** Latest inspection per candidate. Every new HLS or DASH manifest gets one, so only the newest are kept. */
  private inspections = new Map<string, Inspected>();

  /**
   * `partBytes` is the size at which a live recording held in memory is saved
   * as a part (MEMORY_PART_BYTES); tests make it small to reach a second part.
   */
  constructor(
    private readonly platform: Platform,
    private readonly partBytes = MEMORY_PART_BYTES,
  ) {
    void OutputFile.sweep(new Set());
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Apply settings. Raising the limit starts queued jobs right away. */
  configure(settings: Settings): void {
    this.maxConcurrent = normalizeSettings(settings).maxConcurrent;
    this.pump();
  }

  remove(jobId: string): void {
    const r = this.running.get(jobId);
    if (r) r.abort.abort();
    this.queue = this.queue.filter((q) => q.job.id !== jobId);
    this.jobs.delete(jobId);
    this.emit();
  }

  /** Drop every failed job from the list. */
  clearFailed(): void {
    for (const job of this.list()) if (job.state === 'error') this.jobs.delete(job.id);
    this.emit();
  }

  /** Drop a job at once. A running one is aborted and cleans up on its own; a queued one never starts. */
  cancel(jobId: string): void {
    this.queue = this.queue.filter((q) => q.job.id !== jobId);
    this.running.get(jobId)?.abort.abort();
    this.jobs.delete(jobId);
    this.pump();
  }

  /**
   * One frame of the stream as a small JPEG data URL. Costs one segment of the
   * lowest rendition, or the first megabyte of a plain file, and nothing more.
   */
  async thumbnail(candidate: Candidate): Promise<Result<string>> {
    const signal = AbortSignal.timeout(THUMB_TIMEOUT);
    try {
      await this.platform.setHeaderRule(new URL(candidate.url).host, candidate.referer || candidate.pageUrl, originOf(candidate.pageUrl));
      const parts = candidate.kind === 'file' ? [await fetchPrefix(candidate.url, FILE_SAMPLE, signal)] : await this.sample(candidate, signal);
      const frame = await frameFromMp4(parts, candidate.kind !== 'file');
      return frame ? ok(frame) : err('No frame could be decoded.');
    } catch (e) {
      return err(describe(e));
    }
  }

  /**
   * Init segment plus one media segment of the lowest HLS rendition or DASH
   * video representation, as fragmented MP4 that starts at 0.
   */
  private async sample(candidate: Candidate, signal: AbortSignal): Promise<Uint8Array[]> {
    let entry = this.inspections.get(candidate.id);
    if (!entry || staleInspection(entry, candidate)) {
      const r = await this.inspect(candidate);
      if (!r.ok) throw new Error(r.error);
      entry = this.inspections.get(candidate.id)!;
    }
    let media = entry.media;
    if (candidate.kind === 'dash') {
      // The lowest bandwidth video representation. Variants are sorted highest first, and trick mode sets never become variants.
      const variant = entry.inspection.variants.filter((v) => !v.audioOnly).at(-1);
      const plan = variant && entry.dash ? dashPlan(entry.dash, variant.id) : undefined;
      if (!plan) throw new Error('The MPD has no video');
      media = plan.main.media;
    } else if (!media) {
      // A master: the lowest rendition is the cheapest frame. Variants are sorted by bandwidth, highest first.
      const variant = entry.inspection.variants[entry.inspection.variants.length - 1];
      if (!variant) throw new Error('No variant');
      const parsed = parseHls(await fetchText(variant.uri, signal), variant.uri);
      if (parsed.kind !== 'media') throw new Error('Variant pointed at another master playlist');
      media = parsed;
    } else if (!media.endList) {
      // A live playlist from the inspection is stale; its segments may be gone.
      const parsed = parseHls(await fetchText(candidate.url, signal), candidate.url);
      if (parsed.kind === 'media') media = parsed;
    }
    // Live: a segment that is surely complete. On demand: the first.
    const seg = media.endList ? media.segments[0] : media.segments[Math.max(0, media.segments.length - 2)];
    if (!seg) throw new Error('Playlist has no segments');
    await this.platform.setHeaderRule(new URL(seg.uri).host, candidate.referer || candidate.pageUrl, originOf(candidate.pageUrl));
    const whole = seg.key.method !== 'NONE' || !!seg.byteRange;
    const [raw, init] = await Promise.all([
      // An encrypted segment must be whole to decrypt; a plain one is cut at the cap.
      whole ? fetchBytes(seg.uri, { signal, byteRange: seg.byteRange, retries: 1 }) : fetchPrefix(seg.uri, SEGMENT_CAP, signal),
      seg.map ? fetchBytes(seg.map.uri, { signal, byteRange: seg.map.byteRange, retries: 1 }) : null,
    ]);
    const data = await decryptSegment(raw, seg.key, seg.sequence, signal);
    const parts: Uint8Array[] = [];
    const sink = sinkFor(media.container, data, async (chunk) => void parts.push(chunk), seg.duration);
    await sink.push(data, init);
    await sink.flush();
    return parts;
  }

  private keepInspection(id: string, entry: Omit<Inspected, 'at'>) {
    this.inspections.delete(id);
    this.inspections.set(id, { ...entry, at: Date.now() });
    if (this.inspections.size > MAX_INSPECTIONS) this.inspections.delete(this.inspections.keys().next().value!);
  }

  /** End a live recording and save what it has. */
  stop(jobId: string): void {
    this.running.get(jobId)?.stop.request();
  }

  /**
   * Sets the Referer and Origin rule for each new host a job or inspection
   * fetches from, once per host. Returns the function that does it.
   */
  private hostRules(candidate: Candidate): (uri: string) => Promise<void> {
    const ruled = new Set<string>();
    return async (uri) => {
      const host = new URL(uri).host;
      if (ruled.has(host)) return;
      ruled.add(host);
      await this.platform.setHeaderRule(host, candidate.referer || candidate.pageUrl, originOf(candidate.pageUrl));
    };
  }

  /** Header rules for every host the tracks fetch from: segments, init segments and keys. */
  private async allowTracks(candidate: Candidate, tracks: Track[]): Promise<void> {
    const allow = this.hostRules(candidate);
    for (const { media } of tracks) {
      for (const seg of media.segments) {
        await allow(seg.uri);
        if (seg.map) await allow(seg.map.uri);
        if (seg.key.uri) await allow(seg.key.uri);
      }
    }
  }

  async inspect(candidate: Candidate): Promise<Result<Inspection>> {
    const signal = new AbortController().signal;
    try {
      const allow = this.hostRules(candidate);
      await allow(candidate.url);
      if (candidate.kind === 'file') {
        const size = candidate.contentLength ? ` · ${fmtBytes(candidate.contentLength)}` : '';
        const inspection: Inspection = {
          candidateId: candidate.id,
          kind: 'file',
          variants: [{ id: 'file', label: `${candidate.mime || 'file'}${size}`, uri: candidate.url }],
          notes: [],
        };
        this.keepInspection(candidate.id, { candidate, inspection });
        return ok(inspection);
      }
      if (candidate.kind === 'dash') {
        const { inspection, source } = await this.inspectDash(candidate, allow, signal);
        this.keepInspection(candidate.id, { candidate, inspection, dash: source });
        return ok(inspection);
      }
      const text = await fetchText(candidate.url, signal);
      const playlist = parseHls(text, candidate.url);
      const notes: string[] = [];
      let variants: Variant[];
      if (playlist.kind === 'master') {
        const sorted = [...playlist.variants].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
        // Each distinct audio playlist is read once, to tell whether it can be merged.
        const verdicts = new Map<string, Promise<string | null>>();
        const verdict = (uri: string) => {
          let p = verdicts.get(uri);
          if (!p) {
            p = audioVerdict(uri, allow, signal);
            verdicts.set(uri, p);
          }
          return p;
        };
        const found = await Promise.all(
          sorted.map(async (v, i): Promise<{ variant: Variant; note?: string }> => {
            const variant: Variant = { id: `v${i}`, label: variantLabel(v), uri: v.uri, bandwidth: v.bandwidth, resolution: v.resolution, codecs: v.codecs };
            const group = v.audio ? playlist.renditions.filter((r) => r.type === 'AUDIO' && r.groupId === v.audio) : [];
            const audio = mainRendition(group);
            // No URI: the main audio is in the variant's own segments, and renditions with a URI are other languages.
            if (!audio?.uri) return { variant };
            variant.audioGroup = audio.groupId;
            // Read even when the candidate looks live: that comes from counting reloads, and a page that
            // fetches a VOD master twice would otherwise save video only. A live audio playlist says so itself.
            const problem = await verdict(audio.uri);
            if (problem) return { variant, note: problem };
            // NAME, else the language by name (see parseHls): "+ English", never "+ en".
            const name = audio.name || 'audio';
            variant.label = `${variant.label} + ${name}`;
            variant.audioUri = audio.uri;
            variant.audioLabel = name;
            return { variant, note: group.length > 1 ? `Audio: ${name} (default). Other languages are not selectable yet.` : undefined };
          }),
        );
        variants = found.map((f) => f.variant);
        for (const { note } of found) if (note && !notes.includes(note)) notes.push(note);
        if (variants.length === 0) return err('Master playlist has no variants.');
        if (candidate.live || found.some((f) => f.note === AUDIO_LIVE)) notes.push(LIVE_NOTE);
      } else {
        variants = [
          {
            id: 'v0',
            label: playlist.endList
              ? `${playlist.segments.length} segments · ${fmtDuration(playlist.totalDuration)} · ${playlist.container}`
              : `Live · ${playlist.container}`,
            uri: candidate.url,
          },
        ];
        if (!playlist.endList) notes.push(LIVE_NOTE);
        if (playlist.segments.some((s) => s.key.method !== 'NONE' && s.key.method !== 'AES-128')) {
          notes.push(`Uses ${playlist.segments[0]!.key.method}, which looks like DRM. Download will fail.`);
        }
      }
      const inspection: Inspection =
        playlist.kind === 'master'
          ? {
              candidateId: candidate.id,
              kind: 'hls',
              variants,
              notes,
              children: [...playlist.variants.map((v) => v.uri), ...playlist.renditions.flatMap((r) => (r.uri ? [r.uri] : []))],
            }
          : { candidateId: candidate.id, kind: 'hls', variants, notes, live: !playlist.endList };
      this.keepInspection(candidate.id, { candidate, inspection, media: playlist.kind === 'media' ? playlist : undefined });
      return ok(inspection);
    } catch (e) {
      return err(describe(e));
    }
  }

  /**
   * Read an MPD into variants: one per video representation, highest
   * bandwidth first, each with the chosen audio merged in. An MPD without
   * video gives one variant per audio representation. Representations that
   * use DRM, name no init segment, or whose SegmentBase index cannot be read
   * are left out with a note. The MPD is refused when no video is left (no
   * audio, for an audio only MPD), or when every audio representation uses
   * DRM. SegmentBase indexes are read here, so a download needs nothing more
   * than the MPD text again (see DashSource). A dynamic MPD gives the same
   * variants, to record: its segment windows are worked out on the server's
   * clock, read from the MPD's UTCTiming, and the recorder reads the MPD again
   * as it goes.
   */
  private async inspectDash(candidate: Candidate, allow: (uri: string) => Promise<void>, signal: AbortSignal): Promise<{ inspection: Inspection; source: DashSource }> {
    const text = await fetchText(candidate.url, signal);
    const readAt = Date.now();
    let manifest = parseMpd(text, candidate.url);
    const live = manifest.type === 'dynamic';
    let offset = 0;
    if (live) {
      offset = await clockOffset(manifest.live?.utcTiming ?? [], candidate.url, allow, signal);
      // Which segments are out follows the clock, so read the windows again on the server's.
      if (offset) manifest = parseMpd(text, candidate.url, Date.now() + offset * 1000);
    }
    if (!manifest.video.length && !manifest.audio.length) throw new Error(manifest.notes.join(' ') || 'The MPD lists no video or audio Magpie can download.');
    const notes = [...manifest.notes];
    const audioOnly = manifest.video.length === 0;

    // DRM: a ladder can protect its HD representations and leave SD clear, so only the protected ones go.
    // Every video protected refuses the MPD, and so does every audio: a clear video with no sound is not what was asked for.
    const drm = [...manifest.video, ...manifest.audio].filter((r) => r.encrypted);
    let video = manifest.video.filter((r) => !r.encrypted);
    let audio = manifest.audio.filter((r) => !r.encrypted);
    if ((!audioOnly && !video.length) || (manifest.audio.length && !audio.length)) throw new Error(DRM_MPD);
    if (drm.length) notes.push(leftOut(drm, 'DRM protected, which Magpie does not download'));

    // An fMP4 representation without an init segment cannot be written, alone or merged; say so now, not when the download fails.
    const noInit = [...video, ...audio].filter(lacksInit);
    if (noInit.length) {
      notes.push(leftOut(noInit, 'no initialization segment, which an fMP4 download needs'));
      video = video.filter((r) => !noInit.includes(r));
      audio = audio.filter((r) => !noInit.includes(r));
    }

    const indexed: Record<string, MediaPlaylist> = {};
    if (!live) {
      // SegmentBase: the segment list is in the file's sidx, which the MPD only points at. Inspect runs on
      // sight, so one representation whose file is gone or whose server ignores Range drops out alone.
      // Representations that failed for the same reason share one note, keyed by its wording for one.
      const failed = new Map<string, { why: Why; reps: DashRepresentation[] }>();
      const load = async (reps: DashRepresentation[]): Promise<DashRepresentation[]> => {
        const results = await Promise.allSettled(reps.map((rep) => loadIndex(rep, allow, signal)));
        return reps.filter((rep, i) => {
          const r = results[i]!;
          if (r.status === 'fulfilled') {
            if (r.value) indexed[repKey(rep)] = r.value;
            return true;
          }
          const why = indexProblem(r.reason);
          const key = typeof why === 'string' ? why : why(false);
          failed.set(key, { why, reps: [...(failed.get(key)?.reps ?? []), rep] });
          return false;
        });
      };
      video = await load(video);
      if (audioOnly) audio = await load(audio);
      else {
        // Only the audio that is merged is read: the choice, then the next choice while indexes fail.
        let pool = audio;
        let picked: DashRepresentation | undefined;
        while (!picked && pool.length) {
          const pick = chooseAudio({ ...manifest, audio: pool })!;
          picked = (await load([pick]))[0];
          pool = pool.filter((r) => r !== pick);
        }
        audio = picked ? [picked] : [];
      }
      for (const { why, reps } of failed.values()) notes.push(leftOut(reps, why));
    }
    if (audioOnly ? !audio.length : !video.length) throw new Error(notes.join(' ') || 'No representation in the MPD can be downloaded.');
    if (!audioOnly && manifest.audio.length && !audio.length) notes.push(DASH_NO_AUDIO);

    // The merged audio, or the first variant of an audio only MPD.
    const chosen = chooseAudio({ ...manifest, audio });
    const merge = audioOnly ? undefined : chosen;
    // An audio only MPD offers every audio representation, the chosen one first.
    const reps = audioOnly ? [...(chosen ? [chosen] : []), ...audio.filter((r) => r !== chosen)] : video;
    const used = merge ? [...reps, merge] : reps;
    if (live) {
      // A live stream grows by new segments, which a SegmentBase file and its one sidx cannot list.
      if (used.some((r) => r.segmentBase)) throw new Error(LIVE_SEGMENT_BASE);
      const ts = used.find((r) => r.media?.container === 'ts');
      if (ts) throw new Error(liveTs(ts.type));
    }

    const audioName = merge?.lang && merge.lang !== 'und' ? languageName(merge.lang) : 'audio';
    const variants: Variant[] = [];
    const picks: DashSource['picks'] = {};
    let merged = false;
    reps.forEach((rep, i) => {
      if (!rep.media) return;
      const id = `${audioOnly ? 'a' : 'v'}${i}`;
      // Either side may be fMP4 or MPEG-TS; downloadPair turns MPEG-TS into fragments of its own.
      const withAudio = !!merge?.media && !rep.muxed;
      merged ||= withAudio;
      variants.push({
        id,
        label: withAudio ? `${videoLabel(rep)} + ${audioName}` : videoLabel(rep),
        uri: firstUri(rep) ?? candidate.url,
        bandwidth: rep.bandwidth,
        resolution: rep.width && rep.height ? `${rep.width}x${rep.height}` : undefined,
        codecs: rep.codecs,
        audioUri: withAudio ? firstUri(merge!) : undefined,
        audioLabel: withAudio ? audioName : undefined,
        audioOnly: audioOnly || undefined,
      });
      picks[id] = { main: repKey(rep), audio: withAudio ? repKey(merge!) : undefined };
    });
    if (!variants.length) throw new Error(notes.join(' ') || 'No representation in the MPD has segments.');
    if (merged && new Set(manifest.audio.map((r) => r.setIndex)).size > 1) {
      notes.push(`Audio: ${audioName} (default). Other languages are not selectable yet.`);
    }
    if (live) notes.push(LIVE_NOTE);
    // Fold rules of every representation, used or not: the player may fetch any of them, protected ones included.
    const children = [...new Set([...manifest.video, ...manifest.audio].flatMap((r) => r.fold))];
    const inspection: Inspection = { candidateId: candidate.id, kind: 'dash', variants, notes, children };
    if (live) inspection.live = true;
    return { inspection, source: { text, url: candidate.url, at: readAt, clockOffset: offset, indexed, picks } };
  }

  async start(candidate: Candidate, variantId: string): Promise<Result<Job>> {
    let entry = this.inspections.get(candidate.id);
    // The variant the sheet showed, to find again by its label if the manifest is read again and its ladder changed.
    const shown = entry?.inspection.variants.find((v) => v.id === variantId);
    if (!entry || staleInspection(entry, candidate)) {
      const r = await this.inspect(candidate);
      if (r.ok) entry = this.inspections.get(candidate.id)!;
      // An inspection that is only old still names this manifest, and run() reads an HLS playlist (or an old MPD)
      // again anyway, so a failed read (a network blip) keeps it. A live MPD's window has moved on since, and a
      // new URL is another manifest.
      else if (!entry || entry.candidate.url !== candidate.url || (candidate.kind === 'dash' && entry.inspection.live)) return r;
    }
    const picked = pickVariant(entry.inspection.variants, shown, variantId);
    if (!picked.ok) return picked;
    const variant = picked.value;

    const job: Job = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      candidateId: candidate.id,
      title: candidate.pageTitle || candidate.url,
      filename: buildFilename(candidate.pageTitle, candidate.kind, variant.audioOnly ? 'audio' : undefined, candidate.mime, candidate.url, variant.label),
      url: variant.uri,
      kind: candidate.kind,
      variantLabel: variant.label,
      state: 'queued',
      segmentsTotal: 0,
      segmentsDone: 0,
      bytes: 0,
      startedAt: Date.now(),
      thumb: candidate.thumb,
    };
    let dash: DashPlan | undefined;
    if (entry.dash) {
      try {
        dash = dashPlan(entry.dash, variant.id);
      } catch (e) {
        return err(describe(e));
      }
    }
    if (dash?.live) {
      // A dynamic MPD is known to be live before the job runs (a live HLS playlist only once run() reads it).
      job.live = true;
      job.filename = withTimestamp(job.filename, new Date());
    }
    this.jobs.set(job.id, job);
    this.queue.push({ job, candidate, variant, media: entry.media, dash });
    this.pump();
    return ok(job);
  }

  /** Start queued jobs, oldest first, while there are free slots. A job known to be live starts at once. */
  private pump(): void {
    // Live recordings run until Stop and move at the stream's own pace, so they do not hold a slot.
    const busy = () => [...this.running.values()].filter((r) => !r.job.live).length;
    for (;;) {
      const i = busy() < this.maxConcurrent ? 0 : this.queue.findIndex((q) => q.job.live);
      if (i < 0 || i >= this.queue.length) break;
      const { job, candidate, variant, media, dash } = this.queue.splice(i, 1)[0]!;
      const abort = new AbortController();
      const stop = new StopFlag();
      this.running.set(job.id, { job, abort, stop });
      job.queuePosition = undefined;
      job.state = 'inspecting';
      void this.run(job, candidate, variant, media, dash, abort.signal, stop).finally(() => {
        this.running.delete(job.id);
        this.pump();
      });
    }
    this.queue.forEach((q, i) => (q.job.queuePosition = i + 1));
    this.emit();
  }

  private async run(job: Job, candidate: Candidate, variant: Variant, prefetched: MediaPlaylist | undefined, dash: DashPlan | undefined, signal: AbortSignal, stop: StopFlag) {
    let out = new OutputFile(`${job.id}.bin`);
    let part = 1;
    /** Bytes in parts already saved, so job.bytes keeps counting across parts. */
    let savedBytes = 0;
    /** Length in seconds for the archive, when known. */
    let secs: number | undefined;
    try {
      await this.platform.setHeaderRule(new URL(variant.uri).host, candidate.referer || candidate.pageUrl, originOf(candidate.pageUrl));
      await out.open();
      const write = (chunk: Uint8Array) => out.append(chunk).then(() => void (job.bytes = savedBytes + out.bytes));
      const liveOutput: LiveOutput = {
        current: () => out,
        nextPart: async () => {
          await this.save(out, withPart(job.filename, part), job.id);
          savedBytes += out.bytes;
          part++;
          out = new OutputFile(`${job.id}.${part}.bin`);
          await out.open();
        },
      };

      if (job.kind === 'file') {
        job.state = 'downloading';
        job.segmentsTotal = 1;
        this.emit();
        await streamFile(
          variant.uri,
          write,
          signal,
          (b) => {
            job.bytes = b;
            this.emitThrottled();
          },
          (total) => {
            job.bytesTotal = total;
            this.emit();
          },
        );
        job.segmentsDone = 1;
      } else if (job.kind === 'dash' && dash?.live) {
        // A dynamic MPD: start() made this a live job, and the recorder reads the MPD on its own schedule.
        job.state = 'downloading';
        this.emit();
        await this.recordLiveDash(candidate.url, dash.live, liveOutput, write, job, candidate, signal, stop);
        secs = job.duration;
      } else if (job.kind === 'dash') {
        // start() parsed the MPD text the inspection kept, so a fresh inspection is not fetched again. One that
        // waited in the queue past INSPECTION_MAX_AGE may name segment URLs whose signatures have expired.
        if (dash && Date.now() - dash.readAt > INSPECTION_MAX_AGE) {
          job.state = 'inspecting';
          this.emit();
          dash = await this.freshDashPlan(candidate, variant);
        }
        if (!dash) throw new Error('This DASH stream has nothing to download; open it again.');
        const { main, audio } = dash;
        if (main.media.segments.length === 0) throw new Error('The representation has no segments');
        job.segmentsTotal = main.media.segments.length;
        job.state = 'downloading';
        this.emit();
        if (audio) {
          const saved = await this.downloadPair(main, audio, write, job, candidate, signal);
          // A last segment that did not exist shortens the file; the joined init went out with the listed length.
          if (saved.init && saved.duration !== main.media.totalDuration) await out.overwriteStart(patchDurations(saved.init, saved.duration));
          secs = saved.duration;
        } else {
          await this.allowTracks(candidate, [main]);
          secs = await this.downloadHls(main.media, write, job, signal, { lastOptional: main.lastOptional, drm: true });
        }
      } else {
        job.state = 'inspecting';
        this.emit();
        // A live playlist from the inspection is stale by now; fetch the current one.
        let media = prefetched?.endList && variant.uri === candidate.url ? prefetched : undefined;
        if (!media) {
          const text = await fetchText(variant.uri, signal);
          const parsed = parseHls(text, variant.uri);
          if (parsed.kind !== 'media') throw new Error('Variant pointed at another master playlist');
          media = parsed;
        }
        if (!media.endList) {
          job.live = true;
          job.filename = withTimestamp(job.filename, new Date());
          job.state = 'downloading';
          this.pump();
          await this.recordLive(variant.uri, media, liveOutput, write, job, candidate, signal, stop);
          secs = job.duration;
        } else {
          if (media.segments.length === 0) throw new Error('Playlist has no segments');
          await this.platform.setHeaderRule(new URL(media.segments[0]!.uri).host, candidate.referer || candidate.pageUrl, originOf(candidate.pageUrl));
          job.segmentsTotal = media.segments.length;
          const audio = variant.audioUri ? await this.audioPlaylist(variant.audioUri, media, job, candidate, signal) : null;
          job.state = 'downloading';
          this.emit();
          if (audio) {
            secs = (await this.downloadPair({ media }, { media: audio }, write, job, candidate, signal)).duration;
          } else {
            await this.downloadHls(media, write, job, signal);
            secs = media.totalDuration;
          }
        }
      }

      job.state = 'saving';
      this.emit();
      // A recording that ended right after a part was saved leaves an empty last part.
      if (part > 1 && out.bytes === 0) await out.abort();
      else {
        const saved = await this.save(out, part > 1 ? withPart(job.filename, part) : job.filename, job.id);
        if (job.kind === 'file') secs = await mp4Duration(saved.file);
      }
      // The job stays 'saving' until history has the entry, then leaves the list:
      // the file is in the browser's downloads, and the record, if any, is in history.
      // A recording saved in parts is listed under its first part.
      await this.archive(job, part > 1 ? withPart(job.filename, 1) : job.filename, candidate, secs);
      this.jobs.delete(job.id);
      this.emit();
    } catch (e) {
      await out.abort();
      // Cancelled: the job already left the list. Failed: it stays, with the reason.
      if (!signal.aborted) {
        job.state = 'error';
        job.error = describe(e);
        job.finishedAt = Date.now();
      }
      this.emit();
    }
  }

  /**
   * The plan for `variant` from a new inspection of the MPD, for a download
   * that starts long after its inspection. The variant is found again by its
   * label, so a ladder that changed meanwhile cannot swap the quality.
   */
  private async freshDashPlan(candidate: Candidate, variant: Variant): Promise<DashPlan> {
    const r = await this.inspect(candidate);
    if (!r.ok) throw new Error(r.error);
    const entry = this.inspections.get(candidate.id);
    const again = entry?.inspection.variants.find((v) => v.label === variant.label);
    const plan = again && entry?.dash ? dashPlan(entry.dash, again.id) : undefined;
    if (!plan) throw new Error('The MPD no longer lists this quality; open it again.');
    return plan;
  }

  /**
   * The audio rendition playlist to merge with `video`, or null when the pair
   * cannot be merged: the job's note then says why, in the words inspect uses,
   * and the file is video only. A playlist that fails to load is one of those
   * cases, as it is at inspect, not a reason to fail the job.
   */
  private async audioPlaylist(uri: string, video: MediaPlaylist, job: Job, candidate: Candidate, signal: AbortSignal): Promise<MediaPlaylist | null> {
    const { media, problem } = await readAudio(uri, this.hostRules(candidate), signal, video);
    if (problem) job.note = problem;
    return media;
  }

  /**
   * Move a finished download to the archive. False when the archive is off or
   * did not answer. Never throws: the file is saved, so nothing here may send
   * the job down the error path that deletes it.
   */
  private async archive(job: Job, filename: string, candidate: Candidate, secs: number | undefined): Promise<boolean> {
    try {
      return await this.platform.archive(makeEntry({ ...job, filename }, candidate, secs));
    } catch {
      return false;
    }
  }

  /** Hand a finished file to the browser's downloads and drop our copy once it has had time to read it. */
  private async save(out: OutputFile, filename: string, jobId: string): Promise<{ id: number | undefined; file: File }> {
    const file = await out.finish();
    const blobUrl = URL.createObjectURL(file);
    const id = await this.platform.saveBlob(blobUrl, filename, jobId);
    const release = () => {
      URL.revokeObjectURL(blobUrl);
      void OutputFile.remove(out.name);
    };
    // A file held in memory goes as soon as the browser has written it out; an OPFS file gets five minutes.
    if (out.inMemory && id !== undefined && this.platform.whenSaved) void this.platform.whenSaved(id).then(release);
    else setTimeout(release, 5 * 60 * 1000);
    return { id, file };
  }

  /**
   * Download one playlist into the file and return the seconds saved. `drm`
   * refuses an encrypted init (DASH, where the MPD may not say so), and
   * `lastOptional` skips a last segment that does not exist (see Track).
   */
  private async downloadHls(media: MediaPlaylist, write: Write, job: Job, signal: AbortSignal, opts: { lastOptional?: boolean; drm?: boolean } = {}): Promise<number> {
    const track: Track = { media, lastOptional: opts.lastOptional };
    const initFor = initLoader(signal);
    const pool = orderedPool(
      media.segments.length,
      PARALLEL,
      WINDOW,
      async (i) => {
        const seg = media.segments[i]!;
        const [raw, init] = await Promise.all([
          fetchBytes(seg.uri, { signal, byteRange: seg.byteRange }).catch((e: unknown) => {
            if (missingLast(track, i, e)) return null;
            throw e;
          }),
          initFor(seg),
        ]);
        if (!raw) return null;
        const data = await decryptSegment(raw, seg.key, seg.sequence, signal);
        return { data, init };
      },
      signal,
    );

    let sink: Sink | null = null;
    let checked: Uint8Array | null = null;
    let duration = media.totalDuration;
    for (let i = 0; i < media.segments.length; i++) {
      const got = await pool.next();
      if (!got) {
        job.segmentsTotal--;
        duration -= media.segments[i]!.duration;
        continue;
      }
      const { data, init } = got;
      if (opts.drm && init && init !== checked) {
        if (isEncrypted(init)) throw new Error(DRM_INIT);
        checked = init;
      }
      // After an EXT-X-DISCONTINUITY the file carries on at the playlist time, as a player plays it.
      if (sink && media.segments[i]!.discontinuity) await sink.discontinuity(media.segments[i]!.start);
      sink ??= sinkFor(media.container, data, write, media.totalDuration);
      await sink.push(data, init);
      job.segmentsDone = i + 1;
      this.emitThrottled();
    }
    job.state = 'muxing';
    this.emit();
    await sink?.flush();
    return duration;
  }

  /**
   * Download a video and a separate audio stream into one file. Each side is
   * fMP4 with one init segment, or MPEG-TS, which goes through a
   * tsTrackProducer of its own (see Merger); mixed pairs work the same way.
   * Each side has its own pool, and fragments go out by playlist time (see
   * mergePass). Progress counts video segments only; audio is a few percent of
   * the bytes. Returns the seconds of video saved and the init written at
   * offset 0.
   */
  private async downloadPair(video: Track, audio: Track, write: Write, job: Job, candidate: Candidate, signal: AbortSignal): Promise<{ duration: number; init: Uint8Array | null }> {
    const tracks: Record<Side, Track> = { video, audio };
    const containers = {} as Record<Side, Container>;
    for (const side of SIDES) {
      const segs = tracks[side].media.segments;
      if (!segs.length) throw new Error(`The ${side} playlist has no segments`);
      containers[side] = pairContainer(tracks[side].media);
      if (containers[side] === 'fmp4' && segs.some((s) => !s.map)) throw new Error(`The ${side} has no init segment, so it cannot be merged`);
      // The joined init is written once, at the start of the file.
      if (initKeys(segs).size > 1) throw new Error(`The ${side} switches to another init segment partway through, which a merged file cannot follow`);
    }
    await this.allowTracks(candidate, [video, audio]);
    // An fMP4 init goes into the joined init. An MPEG-TS one (a DASH Initialization or an HLS EXT-X-MAP holding the
    // PAT and PMT) goes in front of every segment. The init's bytes tell which it is (see initContainer).
    const [videoInit, audioInit] = await Promise.all(
      SIDES.map((side) => {
        const map = tracks[side].media.segments[0]!.map;
        return map ? fetchBytes(map.uri, { signal, byteRange: map.byteRange }) : null;
      }),
    );
    const fetched: Record<Side, Uint8Array | null> = { video: videoInit ?? null, audio: audioInit ?? null };
    const inits: Partial<Record<Side, Uint8Array>> = {};
    for (const side of SIDES) {
      containers[side] = initContainer(fetched[side], containers[side]);
      if (containers[side] !== 'fmp4') continue;
      if (isEncrypted(fetched[side]!)) throw new Error(DRM_INIT);
      inits[side] = fetched[side]!;
    }
    const merger = new Merger(write, video.media.totalDuration, containers, inits);

    const side = (s: Side): PassSide => {
      const t = tracks[s];
      const prefix = containers[s] === 'ts' ? fetched[s] : null;
      return {
        segments: t.media.segments,
        fetch: async (i, sig) => {
          const seg = t.media.segments[i]!;
          try {
            const raw = await fetchBytes(seg.uri, { signal: sig, byteRange: seg.byteRange });
            const data = await decryptSegment(raw, seg.key, seg.sequence, sig);
            return prefix ? joinBytes(prefix, data) : data;
          } catch (e) {
            if (missingLast(t, i, e)) return null;
            throw e;
          }
        },
      };
    };
    let duration = video.media.totalDuration;
    await mergePass(merger, { video: side('video'), audio: side('audio') }, signal, {
      after: (s, index, pushed) => {
        if (s === 'video') {
          if (pushed) job.segmentsDone = index + 1;
          else {
            job.segmentsTotal--;
            duration -= video.media.segments[index]!.duration;
          }
        }
        this.emitThrottled();
      },
    });
    job.state = 'muxing';
    this.emit();
    await merger.finish();
    return { duration, init: merger.firstInit };
  }

  /**
   * Record a live media playlist: fetch the segments published so far (from
   * LIVE_LEAD_IN seconds back), then reload the playlist every target duration
   * and append each new segment by media sequence number. Ends on Stop, on
   * EXT-X-ENDLIST, or when the playlist stops answering, and saves what it has.
   */
  private async recordLive(
    url: string,
    first: MediaPlaylist,
    output: LiveOutput,
    write: Write,
    job: Job,
    candidate: Candidate,
    signal: AbortSignal,
    stop: StopFlag,
  ) {
    const initFor = initLoader(signal);
    const allow = this.hostRules(candidate);
    const gap = LIVE_GAP;

    let media = first;
    // The lead in counts live seconds; a preroll in the window is not footage.
    const liveAtStart = media.segments.filter((s) => !stitchedAd(media, s));
    let next = liveAtStart[liveStartIndex({ ...media, segments: liveAtStart }, LIVE_LEAD_IN)]?.sequence ?? (media.segments.at(-1)?.sequence ?? media.mediaSequence - 1) + 1;
    let sink: Sink | null = null;
    /**
     * Where the current part's content ends in the file by the playlist's count, in seconds: the segments
     * written plus the holes left by any that could not be fetched (a sink places a segment by the stream's
     * clock, so a missing one leaves its seconds empty). The MPEG-TS sink measures its own end instead
     * (Sink.end), exact where EXTINF is nominal (Twitch's 2.000 s segments run 2.002 s); this count stands
     * for fMP4. The header gets the end, and a cut carries on from it.
     */
    let partEnd = 0;
    /** Seconds of stitched ads left out, and the note that says so. */
    let adSeconds = 0;
    let adNote: string | undefined;
    /** The last listed segment was an ad, so the next one kept starts on the stream's clock again. */
    let afterAd = false;
    /** The next segment written starts on another clock than the last one did. */
    let cut = false;
    let failures = 0;
    let finalPass = false;
    /** Why the recording ended early, if it did. */
    let why: string | undefined;
    job.duration = 0;
    // The init went out before the length was known; give it the part's span.
    const finishPart = async () => {
      if (!sink) return;
      await sink.flush();
      const end = sink.end ?? partEnd;
      if (sink.firstInit && end) await output.current().overwriteStart(patchDurations(sink.firstInit, end));
    };

    for (;;) {
      const newest = media.segments.at(-1);
      if (newest && next - (newest.sequence + 1) > Math.max(3, media.segments.length)) {
        // The whole window is far behind what we already have: the stream restarted its numbering, and its clock.
        next = media.segments[0]!.sequence;
        cut = true;
        job.note = 'The stream restarted during the recording.';
      }
      const listed = media.segments.filter((s) => s.sequence >= next);
      // Segments that left the window unfetched are a hole of about their number times a segment's length,
      // unless a cut is pending, which closes it. After an ad they were likely more of the ad.
      if (listed.length && listed[0]!.sequence > next && job.segmentsDone > 0 && !afterAd) {
        job.note = gap;
        if (!cut) partEnd += (listed[0]!.sequence - next) * (listed.reduce((a, s) => a + s.duration, 0) / listed.length);
      }
      // Stitched ads are left out. The segment after one, like any after an EXT-X-DISCONTINUITY, is on
      // another clock than the last one written, and the sink carries the file on from where it is.
      const fresh: HlsSegment[] = [];
      const cuts = new Set<number>();
      for (const seg of listed) {
        if (stitchedAd(media, seg)) {
          adSeconds += seg.duration;
          afterAd = true;
          continue;
        }
        if (seg.discontinuity || afterAd) cuts.add(seg.sequence);
        afterAd = false;
        fresh.push(seg);
      }
      if (adSeconds && (!job.note || job.note === adNote)) {
        adNote = `Skipped ${Math.round(adSeconds)} s of Twitch ads.`;
        job.note = adNote;
      }
      for (const seg of fresh) {
        await allow(seg.uri);
        if (seg.map) await allow(seg.map.uri);
      }

      const pool = orderedPool(
        fresh.length,
        PARALLEL,
        WINDOW,
        async (i) => {
          const seg = fresh[i]!;
          // An init that no longer loads: an EXT-X-MAP stays in force past the fMP4 ad it came with, so the
          // TS segments after one list the ad's init, and its signed URL may have expired with the ad.
          const initOrNull = async () => {
            const loading = initFor(seg);
            if (!loading) return null;
            try {
              return await loading;
            } catch (e) {
              if (signal.aborted || !(e instanceof HttpError || e instanceof TypeError)) throw e;
              return null;
            }
          };
          try {
            const [raw, init] = await Promise.all([fetchBytes(seg.uri, { signal, byteRange: seg.byteRange }), initOrNull()]);
            const data = await decryptSegment(raw, seg.key, seg.sequence, signal);
            // An MPEG-TS segment carries its own program tables, so it goes on without the init; fMP4 cannot.
            if (seg.map && !init && sniffContainer(data) !== 'ts') return null;
            return { data, init };
          } catch (e) {
            // A segment that expired or failed to load leaves a gap; decrypt and other errors end the job.
            if (signal.aborted || !(e instanceof HttpError || e instanceof TypeError)) throw e;
            return null;
          }
        },
        signal,
      );
      for (const seg of fresh) {
        const got = await pool.next();
        next = seg.sequence + 1;
        if (cuts.has(seg.sequence)) cut = true;
        if (!got) {
          job.note = gap;
          // The hole it leaves, unless a cut is pending, which closes it.
          if (!cut) partEnd += seg.duration;
          continue;
        }
        if (sink && cut) await sink.discontinuity(sink.end ?? partEnd);
        cut = false;
        sink ??= sinkFor(media.container, got.data, write, 0);
        await sink.push(got.data, got.init);
        job.segmentsDone++;
        job.duration += seg.duration;
        partEnd += seg.duration;
        if (output.current().inMemory && output.current().bytes >= this.partBytes) {
          await finishPart();
          await output.nextPart();
          sink = null;
          partEnd = 0;
          job.note = PART_NOTE;
        }
        this.emitThrottled();
      }
      // Past any ads at the end of the window too, so they are not counted again next pass.
      if (listed.length) next = listed.at(-1)!.sequence + 1;

      if (media.endList || finalPass) break;
      const target = (media.targetDuration || 2) * 1000;
      // As the HLS spec asks: wait one target duration after a change (ads count), half of one when nothing was new.
      await stop.sleep(listed.length ? target : target / 2, signal);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      // After Stop, reload once more so the file runs up to the moment of the click.
      finalPass = stop.requested;
      try {
        const parsed = parseHls(await fetchText(url, signal), url);
        if (parsed.kind !== 'media') throw new Error('The live playlist turned into a master playlist');
        media = parsed;
        failures = 0;
      } catch (e) {
        if (signal.aborted) throw e;
        if (finalPass || ++failures >= LIVE_MAX_FAILURES) {
          why = LIVE_SILENT;
          break;
        }
      }
    }

    if (!sink && !job.segmentsDone) throw new Error(nothingRecorded(why));
    if (why) job.note = liveEnded(why);
    job.state = 'muxing';
    this.emit();
    await finishPart();
  }

  /**
   * Record a dynamic MPD. Each pass reloads the MPD, finds the followed
   * representations again by id, works out which of their segments are out on
   * the server clock (availableRange), and appends those after the last one
   * written, video and audio through the same merge as a download (mergePass).
   * The first pass starts LIVE_LEAD_IN seconds back from the live edge. A
   * segment that fails at the edge is asked for again next pass (LiveCursor).
   * Passes run every minimumUpdatePeriod (see liveReloadMs). Ends on Stop,
   * after one more pass; when the MPD turns static, after fetching the rest;
   * when the Period or a followed representation goes away; when an init
   * segment's bytes change (see initState); when segment times go back (an
   * encoder restart); when the MPD stops answering; or when one side has
   * loaded none of the segments it asked for long enough (see
   * LiveCursor.endPass; an expired token answers 401 or 403 on every segment
   * while the MPD still loads). Saves what it has in every case.
   */
  private async recordLiveDash(url: string, plan: DashLivePlan, output: LiveOutput, write: Write, job: Job, candidate: Candidate, signal: AbortSignal, stop: StopFlag) {
    const allow = this.hostRules(candidate);
    const follow: Partial<Record<Side, { id: string; type: 'video' | 'audio' }>> = { video: { id: plan.mainId, type: plan.mainType } };
    if (plan.audioId !== undefined) follow.audio = { id: plan.audioId, type: 'audio' };
    const sides = SIDES.filter((s) => follow[s]);
    const cursors: Record<Side, LiveCursor> = { video: new LiveCursor(), audio: new LiveCursor() };
    /** The init segment each side was recorded with; the joined init cannot change partway. */
    const usedInits: Partial<Record<Side, UsedInit>> = {};
    const loadInit = async (map: InitRef) => {
      await allow(map.uri);
      return fetchBytes(map.uri, { signal, byteRange: map.byteRange });
    };
    let merger: Merger | null = null;
    /** The MPD of the first pass, which later reloads must still match (see periodChange). */
    let started: DashManifest | null = null;
    /** Where the recording starts, in Period seconds, once the first pass has segments. */
    let startSec: number | undefined;
    /** Seconds in the current part; the whole recording unless it is saved in parts. */
    let partDuration = 0;
    let failures = 0;
    let finalPass = false;
    /** Why the recording ended early, if it did. */
    let why: string | undefined;
    let reloadMs = liveReloadMs(undefined);
    job.duration = 0;
    // The init went out before the length was known; give it the recorded duration.
    const finishPart = async () => {
      if (!merger) return;
      await merger.finish();
      const init = merger.firstInit;
      if (init && partDuration) await output.current().overwriteStart(patchDurations(init, partDuration));
    };

    for (;;) {
      let manifest: DashManifest | null = null;
      try {
        manifest = parseMpd(await fetchText(url, signal), url, Date.now() + plan.clockOffset * 1000);
      } catch (e) {
        if (signal.aborted) throw e;
        if (finalPass || ++failures >= LIVE_MAX_FAILURES) {
          why = LIVE_SILENT;
          break;
        }
      }

      if (manifest) {
        const reps: Partial<Record<Side, DashRepresentation>> = {};
        for (const s of sides) reps[s] = findRep(manifest, follow[s]!.id, follow[s]!.type);
        why = (started && periodChange(started, manifest)) || (sides.some((s) => !reps[s]) ? LIVE_LEFT : undefined);
        if (why) break;
        started ??= manifest;
        reloadMs = liveReloadMs(manifest.live);
        // A static MPD lists every segment there will be: this pass fetches the rest and the recording ends.
        const ended = manifest.type === 'static';
        const nowSec = Date.now() / 1000 + plan.clockOffset;
        const windows: Partial<Record<Side, HlsSegment[]>> = {};
        const maps: Partial<Record<Side, InitRef>> = {};
        for (const s of sides) {
          windows[s] = availableRange(reps[s]!, manifest.live, nowSec).media.segments;
          const map = reps[s]!.template?.init ?? windows[s]![0]?.map;
          if (map) maps[s] = map;
        }
        // The joined init cannot change partway, so an init with other bytes ends the recording. While a renamed
        // init cannot be read, which init the segments need is unknown: the pass writes nothing and counts as a
        // failed reload.
        let unreadable = false;
        for (const s of sides) {
          const used = usedInits[s];
          if (!used || !maps[s]) continue;
          const state = await initState(used, maps[s]!, loadInit);
          if (state === 'changed') why = LIVE_NEW_INIT;
          unreadable ||= state === 'unreadable';
        }
        if (why) break;
        if (!unreadable) failures = 0;
        else if (finalPass || ++failures >= LIVE_MAX_FAILURES) {
          why = LIVE_SILENT;
          break;
        }
        if (!merger && sides.every((s) => maps[s])) {
          for (const s of sides) await allow(maps[s]!.uri);
          const inits = await Promise.all(sides.map((s) => fetchBytes(maps[s]!.uri, { signal, byteRange: maps[s]!.byteRange })));
          if (inits.some(isEncrypted)) throw new Error(DRM_INIT);
          const containers: Partial<Record<Side, Container>> = {};
          const byside: Partial<Record<Side, Uint8Array>> = {};
          sides.forEach((s, i) => {
            containers[s] = 'fmp4';
            byside[s] = inits[i]!;
            usedInits[s] = { key: mapKey(maps[s]!), bytes: inits[i]! };
          });
          merger = new Merger(write, 0, containers, byside);
        }
        startSec ??= liveStartSec(windows.video!, LIVE_LEAD_IN);
        if (merger && startSec !== undefined && !unreadable) {
          const fresh: Partial<Record<Side, HlsSegment[]>> = {};
          const pass: Partial<Record<Side, PassSide>> = {};
          const picked: Partial<Record<Side, ReturnType<LiveCursor['fresh']>>> = {};
          for (const s of sides) picked[s] = cursors[s].fresh(windows[s]!, startSec);
          // Segment times went back inside the same Period: the encoder restarted without a new Period or
          // availabilityStartTime. Timeline.rebase shifts each track by one amount, fixed at its first fragment,
          // and clamps what lands before 0, so fragments on the new clock would pile up at 0 behind the ones
          // written. The file ends where the old clock did.
          if (sides.some((s) => picked[s]!.restarted)) {
            why = LIVE_TIMES_BACK;
            break;
          }
          for (const s of sides) {
            const { segments, gap } = picked[s]!;
            if (gap && job.segmentsDone > 0) job.note = LIVE_GAP;
            fresh[s] = segments;
            for (const seg of segments) await allow(seg.uri);
            pass[s] = { segments, fetch: liveFetch(segments) };
          }
          const current = merger;
          await mergePass(current, pass, signal, {
            before: async (s) => {
              // A part starts with a video segment, so the audio that plays with it goes into the same part.
              if (s !== 'video' || !output.current().inMemory || output.current().bytes < this.partBytes) return;
              await finishPart();
              await output.nextPart();
              current.restart();
              partDuration = 0;
              job.note = PART_NOTE;
            },
            after: (s, index, pushed) => {
              const seg = fresh[s]![index]!;
              if (!pushed) return cursors[s].failed();
              if (cursors[s].loaded(seg)) job.note = LIVE_GAP;
              if (s === 'video') {
                job.segmentsDone++;
                job.duration = (job.duration ?? 0) + seg.duration;
                partDuration += seg.duration;
              }
              this.emitThrottled();
            },
          });
          // Every side closes its pass so each count stays right; a side that keeps failing ends the recording.
          if (sides.map((s) => cursors[s].endPass()).some(Boolean)) {
            why = LIVE_SILENT;
            break;
          }
        }
        if (ended && !unreadable) break;
      }

      if (finalPass) break;
      await stop.sleep(reloadMs, signal);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      // After Stop, reload once more so the file runs up to the moment of the click.
      finalPass = stop.requested;
    }

    // A Period change or a track that left before the first segment is the reason, not an empty recording.
    if (!job.segmentsDone) throw new Error(nothingRecorded(why));
    if (why) job.note = liveEnded(why);
    job.state = 'muxing';
    this.emit();
    await finishPart();
  }

  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private emitThrottled() {
    const now = Date.now();
    if (now - this.lastEmit > 250) {
      this.emit();
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.emit();
      }, 250);
    }
  }
  /** Change notice without thumbnails: those travel once, with a list answer, not several times a second. */
  private emit() {
    this.lastEmit = Date.now();
    this.platform.jobsChanged(this.list().map(withoutThumb));
  }
}

/**
 * The rendition a player plays for an AUDIO group: DEFAULT=YES, else the first
 * AUTOSELECT=YES, else the first. When it has no URI the main audio is in the
 * variant's own segments, and the other renditions are dubs.
 */
export function mainRendition(group: HlsRendition[]): HlsRendition | undefined {
  return group.find((r) => r.isDefault) ?? group.find((r) => r.autoselect) ?? group[0];
}

/**
 * Why an audio playlist cannot be merged with its video, or null when it can:
 * both complete, one init segment each, no discontinuities. Either side may be
 * fMP4 or MPEG-TS (see pairContainer), but fMP4 needs its init. At inspect
 * time only the audio is known; run() checks again with both.
 */
export function pairProblem(audio: MediaPlaylist, video?: MediaPlaylist): string | null {
  const sides = video ? [video, audio] : [audio];
  if (sides.some((m) => !m.endList)) return AUDIO_LIVE;
  if (!audio.segments.length) return AUDIO_EMPTY;
  if (sides.some((m) => pairContainer(m) === 'fmp4' && !isFmp4(m))) return AUDIO_NO_INIT;
  // A discontinuity before the first segment changes nothing.
  if (sides.some((m) => m.segments.some((s, i) => i > 0 && s.discontinuity))) return AUDIO_DISCONTINUITY;
  if (sides.some((m) => initKeys(m.segments).size > 1)) return AUDIO_NEW_INIT;
  return null;
}

/**
 * True when an init segment shows encryption: an encv or enca sample entry
 * (moov > trak > mdia > minf > stbl > stsd) or a pssh box in moov. Some MPDs
 * leave ContentProtection out, and the saved file would not play.
 */
export function isEncrypted(init: Uint8Array): boolean {
  for (const moov of boxes(init, 0, init.byteLength, 'moov')) {
    for (const b of boxes(init, moov.body, moov.end)) {
      if (b.type === 'pssh') return true;
      if (b.type !== 'trak') continue;
      for (const mdia of boxes(init, b.body, b.end, 'mdia')) {
        for (const minf of boxes(init, mdia.body, mdia.end, 'minf')) {
          for (const stbl of boxes(init, minf.body, minf.end, 'stbl')) {
            for (const stsd of boxes(init, stbl.body, stbl.end, 'stsd')) {
              // stsd is a full box: version, flags and an entry count come before the sample entries.
              for (const entry of boxes(init, stsd.body + 8, stsd.end)) if (entry.type === 'encv' || entry.type === 'enca') return true;
            }
          }
        }
      }
    }
  }
  return false;
}

/**
 * Read an audio rendition playlist to merge with `video` (when known): the
 * playlist, or null and the note that says why the download is video only.
 * Inspect and run() both read it here, so a playlist that fails to load says
 * the same in the sheet and on the job. Throws only when `signal` aborts.
 */
async function readAudio(
  uri: string,
  allow: (uri: string) => Promise<void>,
  signal: AbortSignal,
  video?: MediaPlaylist,
): Promise<{ media: MediaPlaylist | null; problem: string | null }> {
  try {
    await allow(uri);
    const parsed = parseHls(await fetchText(uri, signal), uri);
    if (parsed.kind !== 'media') return { media: null, problem: AUDIO_MASTER };
    const problem = pairProblem(parsed, video);
    return { media: problem ? null : parsed, problem };
  } catch (e) {
    if (signal.aborted) throw e;
    return { media: null, problem: audioUnreadable(e) };
  }
}

/** Read an audio rendition playlist at inspect time: null when it can be merged, else the note that says why not. */
async function audioVerdict(uri: string, allow: (uri: string) => Promise<void>, signal: AbortSignal): Promise<string | null> {
  return (await readAudio(uri, allow, signal)).problem;
}

/**
 * Fill a SegmentBase representation's segments from the sidx its indexRange
 * points at, and return them. Null for the others, which the MPD resolves.
 * fetchRange, not fetchBytes: a server that ignores Range would hand over the
 * whole rendition, and inspect runs on sight.
 */
async function loadIndex(rep: DashRepresentation, allow: (uri: string) => Promise<void>, signal: AbortSignal): Promise<MediaPlaylist | null> {
  const sb = rep.segmentBase;
  if (rep.media || !sb) return null;
  await allow(sb.url);
  rep.media = segmentsFromSidx(rep, await fetchRange(sb.url, sb.indexRange, signal), sb.indexRange.offset);
  return rep.media;
}

/** Why representations were left out: the same words for one or many, or worded for each (`many` true for several). */
type Why = string | ((many: boolean) => string);

/** Why a SegmentBase index could not be read, short enough for a note that names several representations. */
function indexProblem(e: unknown): Why {
  if (e instanceof RangeIgnoredError) {
    return (many) => `the server ignores Range requests, so reading ${many ? 'their indexes' : 'its index'} would download the whole ${many ? 'files' : 'file'}`;
  }
  const detail = e instanceof HttpError ? `HTTP ${e.status}` : describe(e);
  return (many) => `${many ? 'their segment indexes' : 'its segment index'} could not be read (${detail})`;
}

/**
 * True for an fMP4 representation that names no init segment: its fragments
 * alone do not play, and a merge needs the init for the joined moov. MPEG-TS
 * needs none, and a SegmentBase file always has one, the bytes before its index.
 */
function lacksInit(rep: DashRepresentation): boolean {
  if (/mp2t/i.test(rep.mimeType) || rep.segmentBase) return false;
  if (rep.template) return !rep.template.init;
  return !!rep.media?.segments.some((s) => !s.map);
}

/** A representation in a note: "1920x1080 6000 kbps", "audio English 128 kbps". */
function repName(rep: DashRepresentation): string {
  const lang = rep.lang && rep.lang !== 'und' ? ` ${languageName(rep.lang)}` : '';
  const parts = [rep.width && rep.height ? `${rep.width}x${rep.height}` : rep.type === 'audio' ? `audio${lang}` : `video ${rep.id}`];
  if (rep.bandwidth) parts.push(`${Math.round(rep.bandwidth / 1000)} kbps`);
  return parts.join(' ');
}

/** The note for representations inspect left out: "Left out 1920x1080 6000 kbps, 3840x2160 16000 kbps: DRM protected, ..." */
function leftOut(reps: DashRepresentation[], why: Why): string {
  return `Left out ${reps.map(repName).join(', ')}: ${typeof why === 'string' ? why : why(reps.length > 1)}.`;
}

/** The URL a variant names for a representation: its init, its file, or its first segment. */
function firstUri(rep: DashRepresentation): string | undefined {
  const first = rep.media?.segments[0];
  return first?.map?.uri ?? rep.template?.init?.uri ?? rep.segmentBase?.url ?? first?.uri;
}

/** A representation's key across parses of one MPD text: its kind, the position of its set, and its id. */
function repKey(rep: DashRepresentation): string {
  return `${rep.type}/${rep.setIndex}/${rep.id}`;
}

/**
 * What a variant of an inspected MPD downloads. The MPD text the inspection
 * kept is parsed again, on the server's clock when it is live, and the
 * representations inspect picked are found by key, with the segment lists it
 * read from their sidx. Undefined for a variant the inspection does not have.
 */
function dashPlan(source: DashSource, variantId: string): DashPlan | undefined {
  const pick = source.picks[variantId];
  if (!pick) return undefined;
  const manifest = parseMpd(source.text, source.url, Date.now() + source.clockOffset * 1000);
  const find = (key: string): DashRepresentation => {
    const rep = [...manifest.video, ...manifest.audio].find((r) => repKey(r) === key);
    if (rep && !rep.media) rep.media = source.indexed[key];
    if (!rep?.media) throw new Error('The MPD no longer lists what was inspected; open it again.');
    return rep;
  };
  const main = find(pick.main);
  const audio = pick.audio ? find(pick.audio) : undefined;
  return {
    main: track(main),
    audio: audio ? track(audio) : undefined,
    live: manifest.type === 'dynamic' ? { mainId: main.id, mainType: main.type, audioId: audio?.id, clockOffset: source.clockOffset } : undefined,
    readAt: source.at,
  };
}

/**
 * True when an inspection cannot serve `candidate` as it is: the URL changed
 * (a live stream's fresh token), the MPD is live (its window has moved on
 * since), or it is older than INSPECTION_MAX_AGE.
 */
function staleInspection(entry: Inspected, candidate: Candidate): boolean {
  return entry.candidate.url !== candidate.url || (candidate.kind === 'dash' && !!entry.inspection.live) || Date.now() - entry.at > INSPECTION_MAX_AGE;
}

/**
 * The variant start() downloads from `variants`. When the sheet's variant is
 * known (`shown`), only its label finds it: ids follow the ladder's order, so
 * in a ladder read again since, the same id can name another quality. The id
 * alone serves only when the sheet's inspection is gone (an engine that
 * restarted), and then must exist.
 */
function pickVariant(variants: Variant[], shown: Variant | undefined, variantId: string): Result<Variant> {
  const found = shown ? variants.find((v) => v.label === shown.label) : variants.find((v) => v.id === variantId);
  if (found) return ok(found);
  return err(variants.length ? "The stream's qualities changed; open it again and pick one." : 'No variant to download.');
}

function track(rep: DashRepresentation): Track {
  // Only the $Number$ form with a duration guesses its segment count; a timeline, a list and a sidx list what exists.
  return { media: rep.media!, lastOptional: rep.template?.duration !== undefined && !rep.template.timeline };
}

/**
 * Statuses a segment that does not exist comes back with: 404 and 410, and
 * 403 from S3 behind CloudFront, which answers 403 for a missing object when
 * the bucket does not let the CDN list it.
 */
const MISSING_STATUS = new Set([403, 404, 410]);

/** True when `e` says the last segment of a track whose last segment may not exist is missing (see Track). */
export function missingLast(t: Track, index: number, e: unknown): boolean {
  return !!t.lastOptional && index === t.media.segments.length - 1 && e instanceof HttpError && MISSING_STATUS.has(e.status);
}

function isFmp4(media: MediaPlaylist): boolean {
  return media.segments.length > 0 && media.segments.every((s) => s.map);
}

/** The distinct init segments a playlist uses. */
function initKeys(segments: HlsSegment[]): Set<string> {
  return new Set(segments.flatMap((s) => (s.map ? [mapKey(s.map)] : [])));
}

/** Where an init segment is: its URI and byte range. */
type InitRef = { uri: string; byteRange?: ByteRange };

/** One init segment as a string: its URI and byte range. */
function mapKey(map: InitRef): string {
  return `${map.uri}|${map.byteRange?.offset ?? ''}|${map.byteRange?.length ?? ''}`;
}

/** The init segment one side of a live recording was made with. */
export interface UsedInit {
  /** Its mapKey as the last reload named it. */
  key: string;
  bytes: Uint8Array;
}

/**
 * Whether the init a reload names for a side is still the one the recording
 * was made with. A new URL alone is not a new init: an absolute BaseURL whose
 * token rotates on every MPD response names the same file anew each time. So
 * a new URL is loaded and its bytes compared, and when they match it becomes
 * the URL the next reload is compared with. 'unreadable' when the new URL
 * fails with an HTTP or network error; anything else `load` throws (a cancel)
 * goes through.
 */
export async function initState(used: UsedInit, map: InitRef, load: (map: InitRef) => Promise<Uint8Array>): Promise<'same' | 'changed' | 'unreadable'> {
  const key = mapKey(map);
  if (key === used.key) return 'same';
  let bytes: Uint8Array;
  try {
    bytes = await load(map);
  } catch (e) {
    if (e instanceof HttpError || e instanceof TypeError) return 'unreadable';
    throw e;
  }
  if (!sameBytes(bytes, used.bytes)) return 'changed';
  used.key = key;
  return 'same';
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function streamFile(
  url: string,
  write: (c: Uint8Array) => Promise<void>,
  signal: AbortSignal,
  onBytes: (b: number) => void,
  onTotal: (total: number | undefined) => void,
) {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  // Content-Length is the full size for a plain 200. A compressed body would
  // make it the wire size instead, so ignore it when Content-Encoding is set.
  const len = Number(res.headers.get('content-length'));
  onTotal(len > 0 && !res.headers.get('content-encoding') ? len : undefined);
  const reader = res.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await write(value);
    total += value.byteLength;
    onBytes(total);
  }
}

/**
 * Twitch stitches ads into each viewer's live playlist: a run of segments on
 * a clock of its own behind EXT-X-DISCONTINUITY tags, titled after their
 * source, "Amazon|<creative id>" (streamlink's Twitch plugin keys on the same
 * title), where the stream's own segments are titled "live". They stand in
 * for the live content of the break, and the stream's clock runs on without
 * them. The playlist says it is Twitch's with EXT-X-TWITCH tags; elsewhere
 * titles mean nothing. Only the known ad title counts: an ad titled some
 * other way is recorded, behind cuts like any discontinuity, which is the
 * lesser harm next to dropping a stream whose live segments got a new title.
 */
export function stitchedAd(media: MediaPlaylist, seg: HlsSegment): boolean {
  return media.twitch && /^Amazon(\||$)/.test(seg.title);
}

/** Fetches each distinct EXT-X-MAP init segment once per job. One that failed is fetched again for the next segment that lists it. */
function initLoader(signal: AbortSignal): (seg: HlsSegment) => Promise<Uint8Array> | null {
  const cache = new Map<string, Promise<Uint8Array>>();
  return (seg) => {
    if (!seg.map) return null;
    const key = mapKey(seg.map);
    let p = cache.get(key);
    if (!p) {
      p = fetchBytes(seg.map.uri, { signal, byteRange: seg.map.byteRange });
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return p;
  };
}

/**
 * How a single stream is written: MPEG-TS through mux.js when the playlist or
 * the first segment's bytes say MPEG-TS, else fMP4 as fetched. An init
 * segment does not make it fMP4: a DASH Initialization for MPEG-TS (or an HLS
 * EXT-X-MAP before TS segments) holds the PAT and PMT, not a moov, and
 * passing it through would put raw MPEG-TS in an .mp4.
 */
export function sinkContainer(container: MediaPlaylist['container'], first: Uint8Array): Container {
  return container === 'ts' || sniffContainer(first) === 'ts' ? 'ts' : 'fmp4';
}

/**
 * The sink for a single stream (see sinkContainer). An MPEG-TS init (a DASH
 * Initialization or an HLS EXT-X-MAP holding the PAT and PMT) goes in front
 * of every segment, as downloadPair does, so mux.js finds the program tables
 * in each one. An fMP4 init, an EXT-X-MAP left in force past a stitched fMP4
 * ad, is nothing to mux.js and is left out.
 */
function sinkFor(container: MediaPlaylist['container'], first: Uint8Array, write: Write, durationSec: number): Sink {
  if (sinkContainer(container, first) === 'fmp4') return passthroughSink(write);
  const ts = tsSink(write, durationSec);
  return {
    push: (segment, segInit) => ts.push(segInit && initContainer(segInit, 'ts') === 'ts' ? joinBytes(segInit, segment) : segment, null),
    discontinuity: (atSec) => ts.discontinuity(atSec),
    flush: () => ts.flush(),
    get firstInit() {
      return ts.firstInit;
    },
    get end() {
      return ts.end;
    },
  };
}

/**
 * How one side of a merge is written. The playlist decides: fMP4 as fetched,
 * or MPEG-TS (packed ADTS audio too) through tsTrackProducer. A playlist that
 * does not say, an HLS one without EXT-X-MAP whose segment names give nothing
 * away, is MPEG-TS unless every segment has an init. Merger checks the choice
 * against the first segment.
 */
function pairContainer(media: MediaPlaylist): Container {
  if (media.container !== 'unknown') return media.container;
  return isFmp4(media) ? 'fmp4' : 'ts';
}

/**
 * How one side of a merge is written once its init segment is fetched: the
 * init's bytes decide when they tell, else the playlist (`listed`, see
 * pairContainer). hls.ts calls any playlist with an EXT-X-MAP fMP4, but an
 * MPEG-TS stream may carry one too, holding the PAT and PMT. Sync bytes at 0
 * and 188 (or one 188 byte packet) are MPEG-TS; an ftyp, moov or styp box at
 * the start is fMP4.
 */
export function initContainer(init: Uint8Array | null, listed: Container): Container {
  if (!init) return listed;
  if (init[0] === 0x47 && (init.byteLength === 188 || init[188] === 0x47)) return 'ts';
  const type = init.byteLength >= 8 ? String.fromCharCode(init[4]!, init[5]!, init[6]!, init[7]!) : '';
  return type === 'ftyp' || type === 'moov' || type === 'styp' ? 'fmp4' : listed;
}

function joinBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}

/** Seconds within which two segment times are the same time: timeline starts are ticks over a timescale, divided in floating point. */
const SAME_TIME = 0.001;
/**
 * Seconds of space between the last segment written and the next one that
 * still count as no gap. Timelines can leave a few ticks between S entries;
 * a missing segment is a second or more.
 */
const GAP_TOLERANCE = 0.1;

/**
 * Where one side of a live DASH recording stands, kept as Period time, not
 * segment numbers: a $Time$ SegmentTimeline numbers its segments from
 * startNumber on every reload, and packagers rarely move startNumber as the
 * window slides, so one number names a newer segment each time. A segment's
 * start in Period seconds is the same in every reload, for a timeline and for
 * the $Number$ form (number k starts at k segment durations).
 *
 * A segment that fails to load is not given up at once: while no later
 * segment of the side has loaded, it sits at the live edge and is most likely
 * not published yet (the clock and a held MPD run a little ahead of the
 * packager, and a stream that is ending still names the next number), so the
 * next pass asks for it again. Once a later segment loads, the failed ones
 * before it are a gap.
 */
export class LiveCursor {
  /** Start and end, in Period seconds, of the last segment written; undefined before the first. */
  last: { start: number; end: number } | undefined;
  /** Passes in a row that had segments to fetch and loaded none of them (see endPass). */
  deadPasses = 0;
  /** When the first of those passes began, epoch ms; undefined while the side loads. */
  private deadSince: number | undefined;
  /** When the current pass began, epoch ms. */
  private passAt = 0;
  /** Seconds of the longest segment the last pass with any to fetch asked for. */
  private segmentSec = 0;
  private missed = false;
  private tried = false;
  private got = false;

  /** `now` reads the clock in epoch ms; tests pass their own. */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The segments of `window` still to fetch, oldest first: those that start
   * after the last one written, or before the first, those that end after
   * `startSec`. `gap` is true when the window has moved past segments never
   * written. `restarted` is true when the whole window ends well before the
   * last one written starts, by more than three segments or the window's own
   * length, the same margin the HLS recorder gives a stale playlist: the
   * encoder restarted its clock inside the same Period, nothing in the window
   * starts after `last`, and without this the side would wait for ever with no
   * note. The cursor then starts over at the window's first segment. Starts a
   * pass (see endPass).
   */
  fresh(window: HlsSegment[], startSec: number): { segments: HlsSegment[]; gap: boolean; restarted: boolean } {
    this.missed = false;
    this.got = false;
    this.passAt = this.now();
    const newest = window.at(-1);
    const span = newest ? Math.max(3 * newest.duration, newest.start + newest.duration - window[0]!.start) : 0;
    const restarted = !!this.last && !!newest && newest.start + newest.duration < this.last.start - span - SAME_TIME;
    if (restarted) this.last = undefined;
    const last = this.last;
    let segments: HlsSegment[];
    let gap = false;
    if (restarted) segments = window;
    else if (last === undefined) segments = window.filter((s) => s.start + s.duration > startSec + SAME_TIME);
    else {
      segments = window.filter((s) => s.start > last.start + SAME_TIME);
      gap = segments.length > 0 && segments[0]!.start > last.end + GAP_TOLERANCE;
    }
    this.tried = segments.length > 0;
    if (this.tried) this.segmentSec = segments.reduce((m, s) => Math.max(m, s.duration), 0);
    return { segments, gap, restarted };
  }

  /** A segment was written. True when one before it in this pass failed, which leaves a gap. */
  loaded(segment: HlsSegment): boolean {
    const gap = this.missed;
    this.missed = false;
    this.got = true;
    this.deadPasses = 0;
    this.deadSince = undefined;
    this.last = { start: segment.start, end: segment.start + segment.duration };
    return gap;
  }

  /** A segment failed to load. Asked for again next pass unless a later one loads first. */
  failed(): void {
    this.missed = true;
  }

  /**
   * Close a pass and say whether the side is dead. A pass that had segments
   * to fetch and loaded none counts; one that loaded any resets the count,
   * and one with nothing new leaves it. A segment that is only late loads
   * within a few passes, so a side is dead, refused for good by the server
   * (an expired token: 401 or 403 on every segment), only once it has loaded
   * nothing for the longest of LIVE_MAX_FAILURES passes, LIVE_DEAD_MS of wall
   * clock from the start of the first of them, and LIVE_DEAD_SEGMENTS times
   * the segments it asks for. A count of passes alone is a few seconds at the
   * fastest reload, shorter than a slow packager takes to publish one long
   * segment.
   */
  endPass(): boolean {
    if (this.tried && !this.got) {
      this.deadPasses++;
      this.deadSince ??= this.passAt;
    }
    this.tried = false;
    if (this.deadSince === undefined || this.deadPasses < LIVE_MAX_FAILURES) return false;
    return this.now() - this.deadSince >= Math.max(LIVE_DEAD_MS, LIVE_DEAD_SEGMENTS * this.segmentSec * 1000);
  }
}

/**
 * Where a live recording starts, in Period seconds: LIVE_LEAD_IN back from the
 * live edge, as for HLS, always taking in the newest segment. Undefined while
 * nothing is out.
 */
export function liveStartSec(window: HlsSegment[], leadInSec: number): number | undefined {
  const media: MediaPlaylist = { kind: 'media', segments: window, targetDuration: 0, mediaSequence: 0, endList: false, totalDuration: 0, twitch: false, container: 'fmp4' };
  return window[liveStartIndex(media, leadInSec)]?.start;
}

/**
 * Why a reloaded MPD is no longer the presentation a recording started on, or
 * null. Another Period (by id, or by start when the MPD gives no ids) is
 * usually an ad break or the next programme, and a new availabilityStartTime
 * restarts the segment clock; neither continues the same file. Turning static
 * at the end keeps the Period and is not a change.
 */
export function periodChange(from: DashManifest, to: DashManifest): string | null {
  const moved = from.periodId !== undefined || to.periodId !== undefined ? from.periodId !== to.periodId : from.periodStart !== to.periodStart;
  if (moved) return LIVE_PERIOD;
  const was = from.live?.availabilityStartTime;
  const now = to.live?.availabilityStartTime;
  return was !== undefined && now !== undefined && was !== now ? LIVE_RESTART : null;
}

/** Milliseconds between reloads of a live MPD (see MPD_RELOAD_DEFAULT). */
export function liveReloadMs(live: DashLive | undefined): number {
  return Math.min(MPD_RELOAD_MAX, Math.max(MPD_RELOAD_MIN, live?.minimumUpdatePeriod ?? MPD_RELOAD_DEFAULT)) * 1000;
}

function findRep(manifest: DashManifest, id: string, type: 'video' | 'audio'): DashRepresentation | undefined {
  return (type === 'video' ? manifest.video : manifest.audio).find((r) => r.id === id);
}

/** Fetch for a live pass: a segment that fails to load comes back null, and LiveCursor decides between asking again and a gap. */
function liveFetch(segments: HlsSegment[]): PassSide['fetch'] {
  return async (i, signal) => {
    const seg = segments[i]!;
    try {
      return await fetchBytes(seg.uri, { signal, byteRange: seg.byteRange });
    } catch (e) {
      // Not out yet, expired or unreachable; anything else (or a cancel) ends the job.
      if (signal.aborted || !(e instanceof HttpError || e instanceof TypeError)) throw e;
      return null;
    }
  };
}

/** The first UTCTiming element Magpie reads: the time in the element itself, in the body of a GET, or in the Date header of a HEAD. */
export function supportedTiming(timings: DashUtcTiming[]): DashUtcTiming | undefined {
  return timings.find((t) => /^urn:mpeg:dash:utc:(direct|http-xsdate|http-iso|http-head):201[24]$/i.test(t.schemeIdUri));
}

/**
 * Seconds the server's clock is ahead of the local one, from the MPD's first
 * UTCTiming element Magpie reads. Which live segments exist follows the clock,
 * and a local clock a segment off asks for segments not out yet or misses the
 * newest. 0 without such an element, or when its time server does not answer
 * within CLOCK_TIMEOUT. http-head reads the Date header, which counts whole
 * seconds, so it is good to about a second; segments are longer than that.
 */
export async function clockOffset(timings: DashUtcTiming[], manifestUrl: string, allow: (uri: string) => Promise<void>, signal: AbortSignal): Promise<number> {
  const timing = supportedTiming(timings);
  if (!timing) return 0;
  if (/:direct:/i.test(timing.schemeIdUri)) {
    const server = utcTimingTime(timing);
    return server === undefined ? 0 : server - Date.now() / 1000;
  }
  const quick = new AbortController();
  const timer = setTimeout(() => quick.abort(), CLOCK_TIMEOUT);
  const cancel = () => quick.abort();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    // The value may list several servers; the first will do.
    const url = new URL(timing.value.split(/\s+/)[0]!, manifestUrl).href;
    await allow(url);
    const head = /:http-head:/i.test(timing.schemeIdUri);
    const sent = Date.now();
    const body = head ? await headDate(url, quick.signal) : new TextDecoder().decode(await fetchBytes(url, { signal: quick.signal, retries: 0 }));
    const server = utcTimingTime(timing, body);
    if (server === undefined) return 0;
    // The server read its clock about halfway through the round trip. A Date header drops the fraction of its
    // second, so the time it names was on average half a second earlier than the read.
    return server + (head ? 0.5 : 0) - (sent + Date.now()) / 2000;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

/** The Date header of a HEAD request, for the http-head UTCTiming scheme. Undefined when the server sends none. */
async function headDate(url: string, signal: AbortSignal): Promise<string | undefined> {
  const res = await fetch(url, { method: 'HEAD', credentials: 'include', cache: 'no-store', signal });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.headers.get('date') ?? undefined;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
