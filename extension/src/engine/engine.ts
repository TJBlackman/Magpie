import { parseHls, variantLabel, type HlsMedia, type HlsSegment } from '../core/hls';
import { buildFilename } from '../core/filename';
import { err, ok, type Candidate, type Inspection, type Job, type Result, type Variant } from '../core/types';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../core/settings';
import { decryptSegment } from './crypto';
import { fetchBytes, fetchText, orderedPool } from './fetcher';
import { passthroughSink, sniffContainer, tsSink, type Sink } from './mux';
import type { Platform } from './platform';
import { OutputFile } from './store';

const PARALLEL = 4;
const WINDOW = 12;

interface Running {
  job: Job;
  abort: AbortController;
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
        this.inspections.set(candidate.id, { candidate, inspection });
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
      } else {
        variants = [
          {
            id: 'v0',
            label: `${playlist.segments.length} segments · ${fmtDuration(playlist.totalDuration)} · ${playlist.container}`,
            uri: candidate.url,
          },
        ];
        if (!playlist.endList) notes.push('Live playlist: only the segments listed right now will be saved.');
        if (playlist.segments.some((s) => s.key.method !== 'NONE' && s.key.method !== 'AES-128')) {
          notes.push(`Uses ${playlist.segments[0]!.key.method}, which looks like DRM. Download will fail.`);
        }
      }
      const inspection: Inspection = { candidateId: candidate.id, kind: 'hls', variants, notes };
      this.inspections.set(candidate.id, { candidate, inspection, media: playlist.kind === 'media' ? playlist : undefined });
      return ok(inspection);
    } catch (e) {
      return err(describe(e));
    }
  }

  async start(candidate: Candidate, variantId: string): Promise<Result<Job>> {
    let entry = this.inspections.get(candidate.id);
    if (!entry) {
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
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const { job, candidate, variant, media } = this.queue.shift()!;
      const abort = new AbortController();
      this.running.set(job.id, { job, abort });
      job.queuePosition = undefined;
      job.state = 'inspecting';
      void this.run(job, candidate, variant, media, abort.signal).finally(() => {
        this.running.delete(job.id);
        this.pump();
      });
    }
    this.queue.forEach((q, i) => (q.job.queuePosition = i + 1));
    this.emit();
  }

  private async run(job: Job, candidate: Candidate, variant: Variant, prefetched: HlsMedia | undefined, signal: AbortSignal) {
    const out = new OutputFile(`${job.id}.bin`);
    try {
      await this.platform.setHeaderRule(new URL(variant.uri).host, candidate.referer || candidate.pageUrl, originOf(candidate.pageUrl));
      await out.open();
      const write = (chunk: Uint8Array) => out.append(chunk).then(() => void (job.bytes = out.bytes));

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
        let media = prefetched;
        if (!media || media.kind !== 'media' || variant.uri !== candidate.url) {
          const text = await fetchText(variant.uri, signal);
          const parsed = parseHls(text, variant.uri);
          if (parsed.kind !== 'media') throw new Error('Variant pointed at another master playlist');
          media = parsed;
        }
        if (media.segments.length === 0) throw new Error('Playlist has no segments');
        await this.platform.setHeaderRule(new URL(media.segments[0]!.uri).host, candidate.referer || candidate.pageUrl, originOf(candidate.pageUrl));
        job.segmentsTotal = media.segments.length;
        job.state = 'downloading';
        this.emit();
        await this.downloadHls(media, write, job, signal);
      }

      job.state = 'saving';
      this.emit();
      const file = await out.finish();
      const blobUrl = URL.createObjectURL(file);
      job.downloadId = await this.platform.saveBlob(blobUrl, job.filename, job.id);
      job.state = 'done';
      job.finishedAt = Date.now();
      this.emit();
      // Give the download manager time to read the blob before revoking.
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
        void OutputFile.remove(`${job.id}.bin`);
      }, 5 * 60 * 1000);
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

  private async downloadHls(media: HlsMedia, write: (c: Uint8Array) => Promise<void>, job: Job, signal: AbortSignal) {
    const initCache = new Map<string, Promise<Uint8Array>>();
    const initFor = (seg: HlsSegment): Promise<Uint8Array> | null => {
      if (!seg.map) return null;
      const key = `${seg.map.uri}|${seg.map.byteRange?.offset ?? ''}|${seg.map.byteRange?.length ?? ''}`;
      let p = initCache.get(key);
      if (!p) {
        p = fetchBytes(seg.map.uri, { signal, byteRange: seg.map.byteRange });
        initCache.set(key, p);
      }
      return p;
    };

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
      if (!sink) {
        const container = init ? 'fmp4' : media.container !== 'unknown' ? media.container : sniffContainer(data);
        sink = container === 'ts' ? tsSink(write, media.totalDuration) : passthroughSink(write);
      }
      await sink.push(data, init);
      job.segmentsDone = i + 1;
      this.emitThrottled();
    }
    job.state = 'muxing';
    this.emit();
    await sink?.flush();
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
