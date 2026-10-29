/**
 * Merges the fixture video and audio renditions through the engine's own
 * Merger and mergePass (src/engine/merge.ts) and checks the result with
 * ffprobe and ffmpeg inside WSL. Run it after any change to the merge or to
 * src/engine/mux.ts: pnpm --dir extension merge:check (needs pnpm fixtures).
 *
 * Every case runs the way a download does: each side's segments carry their
 * playlist start (the running EXTINF sum for HLS, k times the template
 * duration for DASH), mergePass fetches them from disk and writes them by that
 * start with ties to video, and Merger anchors the file at the earlier of the
 * two first fragments. The fMP4 pairs hand Merger both init files; the TS pair
 * goes through a tsTrackProducer per side inside Merger. The TS video only
 * case runs Merger with no audio side, which writes the producer's video
 * through passthroughSink.
 */
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { HlsSegment } from '../src/core/hls.ts';
import type { Container, PassSide } from '../src/engine/merge.ts';
import type { Side } from '../src/engine/mux.ts';

// module.registerHooks arrived in Node 22.15 and 23.5. A namespace import, not a named one, so an older Node
// reaches this message instead of failing to link the import.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 15) || (major === 23 && minor < 5)) {
  console.error(`merge-check needs Node 22.15 or newer for module.registerHooks; this is Node ${process.versions.node}.`);
  process.exit(1);
}

// The engine's modules import each other without a file extension, as the bundler expects; Node needs
// the .ts spelled out. Registered before the dynamic import below, which is the first to need it.
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Not a .ts module: resolve it as written.
      }
    }
    return nextResolve(specifier, context);
  },
});
const { Merger, mergePass } = await import('../src/engine/merge.ts');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const media = join(root, 'testsite', 'public', 'media');
const downloads = join(root, 'e2e', 'downloads');

interface Pair {
  name: string;
  out: string;
  /** fmp4: init files plus segments. ts: TS segments through tsTrackProducer. ts-video-only: the TS video alone. */
  kind: 'fmp4' | 'ts' | 'ts-video-only';
  videoInit?: string;
  video: string[];
  audioInit?: string;
  audio: string[];
  durationSec: number;
  /** Segment durations per side, in playlist order, which give each segment its playlist start. */
  videoDurations: number[];
  audioDurations: number[];
}

/** Files in `dir` matching `pattern`, sorted by name (the names carry zero padded indexes). */
function list(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** The EXTINF durations of a media playlist, in order. */
function extinf(playlist: string): number[] {
  return [...readFileSync(playlist, 'utf8').matchAll(/#EXTINF:([0-9.]+)/g)].map((m) => Number(m[1]));
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function pairs(): Pair[] {
  const hls = join(media, 'hls-altaudio');
  const ts = join(media, 'hls-altaudio-ts');
  const dash = join(media, 'dash');
  const mpd = readFileSync(join(dash, 'manifest.mpd'), 'utf8');
  const total = /mediaPresentationDuration="PT([0-9.]+)S"/.exec(mpd);
  const template = /timescale="(\d+)" duration="(\d+)"/.exec(mpd);
  const segment = template ? Number(template[2]) / Number(template[1]) : 0;
  const dashVideo = list(dash, /^chunk-0-\d+\.m4s$/);
  // All six audio chunks, although the MPD lists five: the check wants every packet.
  const dashAudio = list(dash, /^chunk-2-\d+\.m4s$/);
  const tsVideo = extinf(join(ts, 'video', 'index.m3u8'));
  return [
    {
      name: 'hls',
      out: join(downloads, 'merge-hls.mp4'),
      kind: 'fmp4',
      videoInit: join(hls, 'video', 'init_1.mp4'),
      video: list(join(hls, 'video'), /^seg\d+\.m4s$/),
      audioInit: join(hls, 'audio', 'init_0.mp4'),
      audio: list(join(hls, 'audio'), /^seg\d+\.m4s$/),
      durationSec: sum(extinf(join(hls, 'video', 'index.m3u8'))),
      videoDurations: extinf(join(hls, 'video', 'index.m3u8')),
      audioDurations: extinf(join(hls, 'audio', 'index.m3u8')),
    },
    {
      name: 'dash',
      out: join(downloads, 'merge-dash.mp4'),
      kind: 'fmp4',
      videoInit: join(dash, 'init-0.m4s'),
      video: dashVideo,
      audioInit: join(dash, 'init-2.m4s'),
      audio: dashAudio,
      durationSec: Number(total?.[1] ?? 0),
      // $Number$ segment k starts at k template durations, the sixth audio chunk at 20 s.
      videoDurations: dashVideo.map(() => segment),
      audioDurations: dashAudio.map(() => segment),
    },
    {
      name: 'ts',
      out: join(downloads, 'merge-ts.mp4'),
      kind: 'ts',
      video: list(join(ts, 'video'), /^seg\d+\.ts$/),
      audio: list(join(ts, 'audio'), /^seg\d+\.ts$/),
      durationSec: sum(tsVideo),
      videoDurations: tsVideo,
      audioDurations: extinf(join(ts, 'audio', 'index.m3u8')),
    },
    {
      name: 'ts-video-only',
      out: join(downloads, 'merge-ts-video-only.mp4'),
      kind: 'ts-video-only',
      video: list(join(ts, 'video'), /^seg\d+\.ts$/),
      audio: [],
      durationSec: sum(tsVideo),
      videoDurations: tsVideo,
      audioDurations: [],
    },
  ];
}

function read(file: string): Uint8Array {
  return new Uint8Array(readFileSync(file));
}

/** One side as mergePass takes it: segments with their playlist starts, fetched from disk. */
function passSide(files: string[], durations: number[]): PassSide {
  let start = 0;
  const segments = files.map((uri, index): HlsSegment => {
    const duration = durations[index] ?? 0;
    const seg: HlsSegment = { index, sequence: index, uri, duration, title: '', start, key: { method: 'NONE' }, map: null, discontinuity: false };
    start += duration;
    return seg;
  });
  return { segments, fetch: async (index) => read(files[index]!) };
}

/** Merge a pair the way the engine's downloadPair does, and write the file. */
async function merge(pair: Pair): Promise<void> {
  const chunks: Uint8Array[] = [];
  const write = async (chunk: Uint8Array) => {
    chunks.push(chunk);
  };
  const containers: Partial<Record<Side, Container>> =
    pair.kind === 'fmp4' ? { video: 'fmp4', audio: 'fmp4' } : pair.kind === 'ts' ? { video: 'ts', audio: 'ts' } : { video: 'ts' };
  const inits: Partial<Record<Side, Uint8Array>> = pair.kind === 'fmp4' ? { video: read(pair.videoInit!), audio: read(pair.audioInit!) } : {};
  const merger = new Merger(write, pair.durationSec, containers, inits);
  const sides: Partial<Record<Side, PassSide>> = { video: passSide(pair.video, pair.videoDurations) };
  if (pair.audio.length) sides.audio = passSide(pair.audio, pair.audioDurations);
  await mergePass(merger, sides, new AbortController().signal, { after: () => {} });
  await merger.finish();
  writeFileSync(pair.out, Buffer.concat(chunks));
}

function wslPath(winPath: string): string {
  if (process.platform !== 'win32') return winPath;
  return winPath.replace(/^([A-Za-z]):\\/, (_, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

/** Run ffmpeg or ffprobe, inside WSL on Windows (the host has neither on PATH). */
function run(tool: 'ffmpeg' | 'ffprobe', args: string[]): string {
  const opts = { encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] as ('ignore' | 'pipe')[] };
  return process.platform === 'win32' ? execFileSync('wsl', ['-u', 'trevor', '--', tool, ...args], opts) : execFileSync(tool, args, opts);
}

/** framemd5 lines without comments, reduced by `pick`. */
function framemd5(text: string, pick: (fields: string[]) => string): string[] {
  return text
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => pick(l.trim().split(/,\s*/)));
}

// framemd5 fields: stream, dts, pts, duration, size, hash, then any side data.
// The source's first audio packet carries skip samples side data with a hash
// of its own, so pick fields by position, not from the end.

/** Size and hash, the comparison hashOnly in e2e/fixtures.ts makes: timestamps may shift after a remux. */
const sizeAndHash = (f: string[]) => `${f[4]},${f[5]}`;
const hash = (f: string[]) => f[5] ?? '';

function videoFrames(file: string): string[] {
  return framemd5(run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', wslPath(file), '-map', '0:v', '-f', 'framemd5', '-']), sizeAndHash);
}

function audioPackets(file: string): string[] {
  return framemd5(run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', wslPath(file), '-map', '0:a', '-c', 'copy', '-f', 'framemd5', '-']), hash);
}

function streams(file: string): { type: string; start: number }[] {
  const out = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', wslPath(file)]);
  const parsed = JSON.parse(out) as { streams?: { codec_type?: string; start_time?: string }[] };
  return (parsed.streams ?? []).map((s) => ({ type: s.codec_type ?? '', start: Number(s.start_time) }));
}

/** How many entries of `got` equal `want` at the same index. */
function matching(got: string[], want: string[]): number {
  return got.filter((g, i) => g === want[i]).length;
}

let failed = 0;

/** Run one check and print PASS or FAIL. A tool that refuses the file counts as a failure. */
function check(name: string, run: () => { ok: boolean; detail: string }) {
  let result: { ok: boolean; detail: string };
  try {
    result = run();
  } catch (e) {
    result = { ok: false, detail: errorText(e) };
  }
  if (!result.ok) failed++;
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${name}: ${result.detail}`);
}

/** The first lines of a failed tool's stderr, or the error message. */
function errorText(e: unknown): string {
  const stderr = (e as { stderr?: unknown }).stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr : e instanceof Error ? e.message : String(e);
  return text.trim().split('\n').slice(0, 3).join(' | ');
}

async function main() {
  if (!existsSync(media)) {
    console.error(`No fixtures at ${media}. Run pnpm fixtures first.`);
    process.exit(1);
  }
  mkdirSync(downloads, { recursive: true });
  const refFrames = framemd5(readFileSync(join(media, 'ref', '720.framemd5'), 'utf8'), sizeAndHash);
  const refPackets = audioPackets(join(media, 'src', '720.mp4'));

  for (const pair of pairs()) {
    try {
      await merge(pair);
    } catch (e) {
      check(`${pair.name} merge`, () => ({ ok: false, detail: errorText(e) }));
      continue;
    }
    const withAudio = pair.kind !== 'ts-video-only';
    console.log(`${pair.name}: ${pair.video.length} video and ${pair.audio.length} audio segments ${withAudio ? 'merged' : 'written'} into ${pair.out}`);

    check(`${pair.name} streams`, () => {
      const found = streams(pair.out);
      const video = found.filter((s) => s.type === 'video').length;
      const audio = found.filter((s) => s.type === 'audio').length;
      const want = withAudio ? 2 : 1;
      return { ok: found.length === want && video === 1 && audio === want - 1, detail: `${video} video, ${audio} audio, ${found.length} in all` };
    });

    check(`${pair.name} video frames`, () => {
      const frames = videoFrames(pair.out);
      const same = matching(frames, refFrames);
      return { ok: frames.length === refFrames.length && same === refFrames.length, detail: `${same} of ${refFrames.length} match ref/720.framemd5 (${frames.length} decoded)` };
    });

    if (!withAudio) {
      check(`${pair.name} start time`, () => {
        const video = streams(pair.out).find((s) => s.type === 'video');
        if (!video) return { ok: false, detail: 'needs a video stream' };
        return { ok: Math.abs(video.start) < 0.05, detail: `video ${video.start} s` };
      });
      continue;
    }

    check(`${pair.name} audio packets`, () => {
      const packets = audioPackets(pair.out);
      const same = matching(packets, refPackets);
      return { ok: packets.length === refPackets.length && same === refPackets.length, detail: `${same} of ${refPackets.length} match src/720.mp4 (${packets.length} in file)` };
    });

    check(`${pair.name} start times`, () => {
      const found = streams(pair.out);
      const video = found.find((s) => s.type === 'video');
      const audio = found.find((s) => s.type === 'audio');
      if (!video || !audio) return { ok: false, detail: 'needs a video and an audio stream' };
      const gap = Math.abs(video.start - audio.start);
      return { ok: gap < 0.05, detail: `video ${video.start} s, audio ${audio.start} s, ${Math.round(gap * 1000)} ms apart` };
    });
  }

  console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
  process.exit(failed ? 1 : 0);
}

await main();
