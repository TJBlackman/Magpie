/**
 * The two track merge as the engine runs it: Merger turns fetched segments of
 * a video side and an optional audio side into one fMP4 file, and mergePass
 * fetches both sides and writes them in playlist order. Kept apart from
 * engine.ts, which needs the browser, so scripts/merge-check.ts can run this
 * exact code under Node on the fixture files.
 */
import type { HlsSegment } from '../core/hls';
import { orderedPool } from './fetcher';
import {
  mergeSink,
  passthroughSink,
  sniffContainer,
  tsTrackProducer,
  type MergeSink,
  type Side,
  type Sink,
  type TrackOutput,
  type TsTrackProducer,
  type Write,
} from './mux';

/** Segment fetches in flight for one stream. */
export const PARALLEL = 4;
/** How far fetches may run ahead of the writer, in segments. */
export const WINDOW = 12;
/**
 * Fetches in flight for the audio side of a video and audio pair. The video
 * side keeps PARALLEL, so a pair fetches its video as fast as a single stream
 * would; audio is a few percent of the bytes and keeps up with 2. Six in all is
 * what browsers allow per host over HTTP/1.1.
 */
export const AUDIO_PARALLEL = 2;
export const SIDES: readonly Side[] = ['video', 'audio'];

export type Container = 'fmp4' | 'ts';

export function containerName(c: Container): string {
  return c === 'ts' ? 'MPEG-TS' : 'fMP4';
}

/**
 * The writing end of a download or recording made of a video stream and a
 * separate audio stream, or of one stream alone. A side is fMP4, written with
 * the init segment the caller fetched, or MPEG-TS, which a tsTrackProducer
 * turns into an init and fragments one segment at a time. Two sides go through
 * mergeSink, one through passthroughSink. The joined init needs both inits,
 * and an MPEG-TS side has its init only once its first segment is through
 * mux.js, so the init is written just before the first fragment, anchored at
 * the earlier of the two sides' next fragments.
 */
export class Merger {
  private readonly producers: Partial<Record<Side, TsTrackProducer>> = {};
  private readonly inits: Partial<Record<Side, Uint8Array>>;
  private readonly sniffed = new Set<Side>();
  private merge: MergeSink | null = null;
  private single: Sink | null = null;
  // Plain fields, not constructor parameter properties: Node strips types from merge-check but does not transform those.
  private readonly write: Write;
  private readonly durationSec: number;
  private readonly containers: Partial<Record<Side, Container>>;

  constructor(write: Write, durationSec: number, containers: Partial<Record<Side, Container>>, inits: Partial<Record<Side, Uint8Array>>) {
    this.write = write;
    this.durationSec = durationSec;
    this.containers = containers;
    this.inits = { ...inits };
    for (const side of SIDES) if (containers[side] === 'ts') this.producers[side] = tsTrackProducer(side, durationSec);
  }

  /** The init written at offset 0 of the current file, null before its first fragment. */
  get firstInit(): Uint8Array | null {
    return (this.merge ?? this.single)?.firstInit ?? null;
  }

  /**
   * One fetched segment of `side` as the fragments to push, in order. The
   * first segment of a side must be the container its playlist named. An
   * MPEG-TS side's first segment must carry the side's track, and later ones
   * the same codec settings, since the joined init is written once.
   */
  async fragments(side: Side, data: Uint8Array): Promise<Uint8Array[]> {
    const container = this.containers[side];
    if (!container) throw new Error(`This download has no ${side} side`);
    if (!this.sniffed.has(side)) {
      this.sniffed.add(side);
      const found = sniffContainer(data);
      if (found !== 'unknown' && found !== container) {
        throw new Error(`The ${side} playlist names ${containerName(container)} segments, but they are ${containerName(found)}`);
      }
    }
    const producer = this.producers[side];
    return producer ? this.take(side, await producer.push(data)) : [data];
  }

  private take(side: Side, out: TrackOutput): Uint8Array[] {
    if (out.init) {
      if (this.inits[side]) throw new Error(`The MPEG-TS ${side} changes its codec settings partway through, which a merged file cannot follow`);
      this.inits[side] = out.init;
    } else if (!this.inits[side]) {
      throw new Error(`The MPEG-TS ${side} segments carry no ${side} track`);
    }
    return out.fragments;
  }

  /**
   * Write one fragment of `side`. `heads` are the fragments each side has up
   * next, this one included: a new file is anchored at the earlier of them,
   * so both tracks shift by the same seconds.
   */
  async push(side: Side, fragment: Uint8Array, heads: Partial<Record<Side, Uint8Array[] | null>>): Promise<void> {
    if (!this.containers.audio) {
      this.single ??= passthroughSink(this.write);
      return this.single.push(fragment, this.inits[side] ?? null);
    }
    if (!this.merge) {
      const { video, audio } = this.inits;
      if (!video || !audio) throw new Error('The merge needs the init segments of both sides before the first fragment');
      const sink = mergeSink(this.write, this.durationSec);
      await sink.setInits(video, audio);
      const starts = SIDES.flatMap((s) => {
        const first = heads[s]?.[0];
        const t = first ? sink.startOf(s, first) : null;
        return t === null ? [] : [t];
      });
      if (starts.length) sink.anchor(Math.min(...starts));
      this.merge = sink;
    }
    await this.merge.push(side, fragment);
  }

  /** Write what mux.js still holds, then flush the sink. Call after the last segment of a file. */
  async finish(): Promise<void> {
    for (const side of SIDES) {
      const producer = this.producers[side];
      if (!producer) continue;
      const fragments = this.take(side, await producer.flush());
      for (const fragment of fragments) await this.push(side, fragment, { [side]: fragments });
    }
    await (this.merge ?? this.single)?.flush();
  }

  /** Start the next file (a recording saved in parts): the same inits again, and its own time 0. */
  restart(): void {
    this.merge = null;
    this.single = null;
  }
}

/** One side of a merge pass: its segments in playlist order and how to fetch one. */
export interface PassSide {
  segments: HlsSegment[];
  /** A segment's bytes, or null to leave it out. Throwing fails the pass. */
  fetch(index: number, signal: AbortSignal): Promise<Uint8Array | null>;
}

export interface PassHooks {
  /** Before a segment's fragments are written. */
  before?(side: Side, index: number): Promise<void>;
  /** After a segment was written (`pushed`) or left out, in the order they go out. */
  after(side: Side, index: number, pushed: boolean): void;
}

/**
 * Fetch each side's segments through a pool of its own and write them by
 * playlist start, the side whose next segment starts first, ties to video.
 * Playlist time, not tfdt: it keeps its order where a stream's clock jumps.
 * One side alone goes in order. A child AbortController per pass stops the
 * other side's fetches when one side fails, instead of leaving them to fail
 * unseen. A download makes one pass; a live recording one per MPD reload.
 */
export async function mergePass(merger: Merger, sides: Partial<Record<Side, PassSide>>, signal: AbortSignal, hooks: PassHooks): Promise<void> {
  const pass = new AbortController();
  const cancel = () => pass.abort();
  if (signal.aborted) pass.abort();
  else signal.addEventListener('abort', cancel, { once: true });
  try {
    const pools: Partial<Record<Side, { next: () => Promise<Uint8Array | null> }>> = {};
    for (const side of SIDES) {
      const s = sides[side];
      // The video gets the fetches a single stream would, the audio a few more beside it (see AUDIO_PARALLEL).
      const parallel = side === 'audio' ? AUDIO_PARALLEL : PARALLEL;
      if (s?.segments.length) pools[side] = orderedPool(s.segments.length, parallel, WINDOW, (i) => s.fetch(i, pass.signal), pass.signal);
    }
    /** A side's next segment as fragments, null fragments when it is left out; null when the side is done. */
    const pull = async (side: Side, index: number) => {
      const pool = pools[side];
      if (!pool || index >= sides[side]!.segments.length) return null;
      const data = await pool.next();
      return { index, fragments: data ? await merger.fragments(side, data) : null };
    };
    const startOf = (side: Side, index: number) => sides[side]!.segments[index]!.start;
    let [v, a] = await Promise.all([pull('video', 0), pull('audio', 0)]);
    while (v || a) {
      const side: Side = v && (!a || startOf('video', v.index) <= startOf('audio', a.index)) ? 'video' : 'audio';
      const next = (side === 'video' ? v : a)!;
      if (next.fragments) {
        await hooks.before?.(side, next.index);
        for (const fragment of next.fragments) await merger.push(side, fragment, { video: v?.fragments, audio: a?.fragments });
      }
      hooks.after(side, next.index, next.fragments !== null);
      if (side === 'video') v = await pull('video', next.index + 1);
      else a = await pull('audio', next.index + 1);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    pass.abort();
  }
}

