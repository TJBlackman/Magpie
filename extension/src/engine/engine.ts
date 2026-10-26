import { liveStartIndex, parseHls, variantLabel, type HlsMedia, type HlsSegment } from '../core/hls';
import { buildFilename, withPart, withTimestamp } from '../core/filename';
import { err, isFinished, ok, type Candidate, type Inspection, type Job, type Result, type Variant } from '../core/types';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../core/settings';
import { makeEntry, type ArchiveEntry } from '../core/archive';
import { decryptSegment } from './crypto';
import { mp4Duration } from './duration';
import { fetchBytes, fetchText, HttpError, orderedPool } from './fetcher';
import { passthroughSink, patchDurations, sniffContainer, tsSink, type Sink, type Write } from './mux';
import type { Platform } from './platform';
import { OutputFile } from './store';

const PARALLEL = 4;
const WINDOW = 12;
/** A live recording starts this many seconds back, to cover what the player was showing. */
const LIVE_LEAD_IN = 30;
/** Consecutive failed playlist reloads after which a live recording ends and saves what it has. */
const LIVE_MAX_FAILURES = 6;
const MAX_INSPECTIONS = 100;
/**
 * Without OPFS (Firefox private windows) a recording lives in memory until it is
 * saved, and saving briefly needs about twice its size. Live recordings there
 * are saved in parts of this size so a long stream cannot use up the RAM.
 */
const MEMORY_PART_BYTES = 2 * 1024 ** 3;
const PART_NOTE = 'Firefox private windows keep recordings in memory, so this one is saved in parts of 2 GB as it goes.';

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

interface Running {
  job: Job;
  abort: AbortController;
  stop: StopFlag;
}

interface Queued {
  job: Job;
  candidate: Candidate;
  variant: Variant;
  media?: HlsMedia;
}

export class Engine {
  private jobs = new Map<string, Job>();
  private running = new Map<string, Running>();
  /** Jobs waiting for a free slot, oldest first. */
  private queue: Queued[] = [];
  private maxConcurrent = DEFAULT_SETTINGS.maxConcurrent;
  /** Latest inspection per candidate. Every new HLS manifest gets one, so only the newest are kept. */
  private inspections = new Map<string, { candidate: Candidate; inspection: Inspection; media?: HlsMedia }>();

  constructor(private readonly platform: Platform) {
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

  /** Drop every finished job from the list. Saved files stay where they are. */
  clearFinished(): void {
    for (const job of this.list()) {
      if (!isFinished(job.state)) continue;
      // A cancelled job can still be unwinding; make sure it stops.
      this.running.get(job.id)?.abort.abort();
      this.jobs.delete(job.id);
    }
    this.emit();
  }

  cancel(jobId: string): void {
    const waiting = this.queue.find((q) => q.job.id === jobId);
    if (waiting) {
      this.queue = this.queue.filter((q) => q !== waiting);
      waiting.job.state = 'cancelled';
      waiting.job.queuePosition = undefined;
      waiting.job.finishedAt = Date.now();
      this.emit();
      return;
    }
    const r = this.running.get(jobId);
    if (r) {
      r.abort.abort();
      r.job.state = 'cancelled';
      this.emit();
    }
  }

  private keepInspection(id: string, entry: { candidate: Candidate; inspection: Inspection; media?: HlsMedia }) {
    this.inspections.delete(id);
    this.inspections.set(id, entry);
    if (this.inspections.size > MAX_INSPECTIONS) this.inspections.delete(this.inspections.keys().next().value!);
  }

  /** End a live recording and save what it has. */
  stop(jobId: string): void {
    this.running.get(jobId)?.stop.request();
  }

  async inspect(candidate: Candidate): Promise<Result<Inspection>> {
    const signal = new AbortController().signal;
    try {
      await this.platform.setHeaderRule(new URL(candidate.url).host, candidate.referer || candidate.pageUrl, originOf(candidate.pageUrl));
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
        return err('DASH manifests are detected but not downloadable yet (phase 2).');
      }
      const text = await fetchText(candidate.url, signal);
      const playlist = parseHls(text, candidate.url);
      const notes: string[] = [];
      let variants: Variant[];
      if (playlist.kind === 'master') {
        const sorted = [...playlist.variants].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
        variants = sorted.map((v, i) => {
          const audio = v.audio ? playlist.renditions.find((r) => r.type === 'AUDIO' && r.groupId === v.audio && r.uri) : undefined;
          return {
            id: `v${i}`,
            label: variantLabel(v),
            uri: v.uri,
            bandwidth: v.bandwidth,
            resolution: v.resolution,
            codecs: v.codecs,
            audioGroup: audio?.groupId,
            audioUri: audio?.uri,
          };
        });
        if (variants.some((v) => v.audioUri)) {
          notes.push('Some renditions carry audio in a separate track. v1 saves video only for those; merging comes in phase 2.');
        }
        if (variants.length === 0) return err('Master playlist has no variants.');
        if (candidate.live) notes.push(LIVE_NOTE);
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

  async start(candidate: Candidate, variantId: string): Promise<Result<Job>> {
    let entry = this.inspections.get(candidate.id);
    // A live stream's manifest URL can change (fresh token), so an old inspection may point at a dead URL.
    if (!entry || entry.candidate.url !== candidate.url) {
      const r = await this.inspect(candidate);
      if (!r.ok) return r;
      entry = this.inspections.get(candidate.id)!;
    }
    const variant = entry.inspection.variants.find((v) => v.id === variantId) ?? entry.inspection.variants[0];
    if (!variant) return err('No variant to download.');

    const job: Job = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      candidateId: candidate.id,
      title: candidate.pageTitle || candidate.url,
      filename: buildFilename(candidate.pageTitle, candidate.kind, undefined, candidate.mime, candidate.url, variant.label),
      url: variant.uri,
      kind: candidate.kind,
      variantLabel: variant.label,
      state: 'queued',
      segmentsTotal: 0,
      segmentsDone: 0,
      bytes: 0,
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.queue.push({ job, candidate, variant, media: entry.media });
    this.pump();
    return ok(job);
  }

  /** Start queued jobs, oldest first, while there are free slots. */
  private pump(): void {
    // Live recordings run until Stop and move at the stream's own pace, so they do not hold a slot.
    const busy = () => [...this.running.values()].filter((r) => !r.job.live).length;
    while (busy() < this.maxConcurrent && this.queue.length > 0) {
      const { job, candidate, variant, media } = this.queue.shift()!;
      const abort = new AbortController();
      const stop = new StopFlag();
      this.running.set(job.id, { job, abort, stop });
      job.queuePosition = undefined;
      job.state = 'inspecting';
      void this.run(job, candidate, variant, media, abort.signal, stop).finally(() => {
        this.running.delete(job.id);
        this.pump();
      });
    }
    this.queue.forEach((q, i) => (q.job.queuePosition = i + 1));
    this.emit();
  }

  private async run(job: Job, candidate: Candidate, variant: Variant, prefetched: HlsMedia | undefined, signal: AbortSignal, stop: StopFlag) {
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
          const output: LiveOutput = {
            current: () => out,
            nextPart: async () => {
              job.downloadId = (await this.save(out, withPart(job.filename, part), job.id)).id;
              savedBytes += out.bytes;
              part++;
              out = new OutputFile(`${job.id}.${part}.bin`);
              await out.open();
            },
          };
          await this.recordLive(variant.uri, media, output, write, job, candidate, signal, stop);
          secs = job.duration;
        } else {
          if (media.segments.length === 0) throw new Error('Playlist has no segments');
          await this.platform.setHeaderRule(new URL(media.segments[0]!.uri).host, candidate.referer || candidate.pageUrl, originOf(candidate.pageUrl));
          job.segmentsTotal = media.segments.length;
          job.state = 'downloading';
          this.emit();
          await this.downloadHls(media, write, job, signal);
          secs = media.totalDuration;
        }
      }

      job.state = 'saving';
      this.emit();
      // A recording that ended right after a part was saved leaves an empty last part.
      if (part > 1 && out.bytes === 0) await out.abort();
      else {
        const saved = await this.save(out, part > 1 ? withPart(job.filename, part) : job.filename, job.id);
        job.downloadId = saved.id;
        if (job.kind === 'file') secs = await mp4Duration(saved.file);
      }
      job.finishedAt = Date.now();
      // The job stays 'saving' until the archive answers, so the list never flashes a done row that then vanishes.
      if (await this.archive(makeEntry(job, candidate, secs))) {
        this.jobs.delete(job.id);
      } else {
        job.state = 'done';
      }
      this.emit();
    } catch (e) {
      await out.abort();
      if (signal.aborted) {
        job.state = 'cancelled';
      } else {
        job.state = 'error';
        job.error = describe(e);
      }
      job.finishedAt = Date.now();
      this.emit();
    }
  }

  /** Move a finished download to the archive. False when the archive is off or did not answer. */
  private async archive(entry: ArchiveEntry): Promise<boolean> {
    try {
      return await this.platform.archive(entry);
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

  private async downloadHls(media: HlsMedia, write: Write, job: Job, signal: AbortSignal) {
    const initFor = initLoader(signal);
    const pool = orderedPool(
      media.segments.length,
      PARALLEL,
      WINDOW,
      async (i) => {
        const seg = media.segments[i]!;
        const [raw, init] = await Promise.all([fetchBytes(seg.uri, { signal, byteRange: seg.byteRange }), initFor(seg)]);
        const data = await decryptSegment(raw, seg.key, seg.sequence, signal);
        return { data, init };
      },
      signal,
    );

    let sink: Sink | null = null;
    for (let i = 0; i < media.segments.length; i++) {
      const { data, init } = await pool.next();
      sink ??= sinkFor(init, media.container, data, write, media.totalDuration);
      await sink.push(data, init);
      job.segmentsDone = i + 1;
      this.emitThrottled();
    }
    job.state = 'muxing';
    this.emit();
    await sink?.flush();
  }

  /**
   * Record a live media playlist: fetch the segments published so far (from
   * LIVE_LEAD_IN seconds back), then reload the playlist every target duration
   * and append each new segment by media sequence number. Ends on Stop, on
   * EXT-X-ENDLIST, or when the playlist stops answering, and saves what it has.
   */
  private async recordLive(
    url: string,
    first: HlsMedia,
    output: LiveOutput,
    write: Write,
    job: Job,
    candidate: Candidate,
    signal: AbortSignal,
    stop: StopFlag,
  ) {
    const initFor = initLoader(signal);
    const ruled = new Set<string>();
    const allow = async (uri: string) => {
      const host = new URL(uri).host;
      if (ruled.has(host)) return;
      ruled.add(host);
      await this.platform.setHeaderRule(host, candidate.referer || candidate.pageUrl, originOf(candidate.pageUrl));
    };
    const gap = 'Some seconds are missing: segments left the live window before they could be fetched.';

    let media = first;
    let next = media.segments[liveStartIndex(media, LIVE_LEAD_IN)]?.sequence ?? media.mediaSequence;
    let sink: Sink | null = null;
    /** Seconds in the current part; the whole recording unless it is saved in parts. */
    let partDuration = 0;
    let failures = 0;
    let finalPass = false;
    job.duration = 0;
    // The init went out before the length was known; give it the recorded duration.
    const finishPart = async () => {
      if (!sink) return;
      await sink.flush();
      if (sink.firstInit && partDuration) await output.current().overwriteStart(patchDurations(sink.firstInit, partDuration));
    };

    for (;;) {
      const newest = media.segments.at(-1);
      if (newest && next - (newest.sequence + 1) > Math.max(3, media.segments.length)) {
        // The whole window is far behind what we already have: the stream restarted its numbering.
        next = media.segments[0]!.sequence;
        job.note = 'The stream restarted during the recording.';
      }
      const fresh = media.segments.filter((s) => s.sequence >= next);
      if (fresh.length && fresh[0]!.sequence > next && job.segmentsDone > 0) job.note = gap;
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
          try {
            const [raw, init] = await Promise.all([fetchBytes(seg.uri, { signal, byteRange: seg.byteRange }), initFor(seg)]);
            return { data: await decryptSegment(raw, seg.key, seg.sequence, signal), init };
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
        if (!got) {
          job.note = gap;
          continue;
        }
        sink ??= sinkFor(got.init, media.container, got.data, write, 0);
        await sink.push(got.data, got.init);
        job.segmentsDone++;
        job.duration += seg.duration;
        partDuration += seg.duration;
        if (output.current().inMemory && output.current().bytes >= MEMORY_PART_BYTES) {
          await finishPart();
          await output.nextPart();
          sink = null;
          partDuration = 0;
          job.note = PART_NOTE;
        }
        this.emitThrottled();
      }

      if (media.endList || finalPass) break;
      const target = (media.targetDuration || 2) * 1000;
      // As the HLS spec asks: wait one target duration after a change, half of one when nothing was new.
      await stop.sleep(fresh.length ? target : target / 2, signal);
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
          job.note = 'The stream stopped answering, so the recording ended there.';
          break;
        }
      }
    }

    if (!sink && !job.segmentsDone) throw new Error('No segments were recorded.');
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
  private emit() {
    this.lastEmit = Date.now();
    this.platform.jobsChanged(this.list());
  }
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

/** Fetches each distinct EXT-X-MAP init segment once per job. */
function initLoader(signal: AbortSignal): (seg: HlsSegment) => Promise<Uint8Array> | null {
  const cache = new Map<string, Promise<Uint8Array>>();
  return (seg) => {
    if (!seg.map) return null;
    const key = `${seg.map.uri}|${seg.map.byteRange?.offset ?? ''}|${seg.map.byteRange?.length ?? ''}`;
    let p = cache.get(key);
    if (!p) {
      p = fetchBytes(seg.map.uri, { signal, byteRange: seg.map.byteRange });
      cache.set(key, p);
    }
    return p;
  };
}

function sinkFor(init: Uint8Array | null, container: HlsMedia['container'], first: Uint8Array, write: Write, durationSec: number): Sink {
  const c = init ? 'fmp4' : container !== 'unknown' ? container : sniffContainer(first);
  return c === 'ts' ? tsSink(write, durationSec) : passthroughSink(write);
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

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m ? `${m}m ${sec}s` : `${sec}s`;
}
