import type { ByteRange } from '../core/hls';

export interface FetchOptions {
  signal: AbortSignal;
  byteRange?: ByteRange;
  retries?: number;
  /** Milliseconds without headers or body bytes after which a request is given up (StalledError); fetchIdle.ms when unset. */
  idleMs?: number;
}

/**
 * How long a request may send nothing, headers or body, before it is given
 * up, in milliseconds. Without a limit one connection that hangs holds a
 * download, or a live recording, forever: fetch() itself never times out.
 * An object so tests can shorten it.
 */
export const fetchIdle = { ms: 15_000 };

// Plain fields, not constructor parameter properties, in the error classes: scripts/merge-check.ts loads this
// module under Node, which strips types but does not transform parameter properties.
export class HttpError extends Error {
  status: number;
  url: string;

  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
    this.url = url;
  }
}

/**
 * A request that went quiet for the idle limit (see fetchIdle). A
 * TypeError like the network failures fetch() throws, so every caller that
 * retries those, or leaves a gap for them, does the same for a stall.
 */
export class StalledError extends TypeError {
  url: string;

  constructor(url: string, ms: number) {
    super(`Timed out: nothing from ${url} for ${Math.round(ms / 1000)} s`);
    this.url = url;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const t = setTimeout(() => {
      // A live recording's signal lives for hours; a listener left on it for every retry would pile up.
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Fetch bytes with cookies, optional Range, and bounded retries. Fetches run
 * from the extension origin; Referer/Origin are patched by the platform
 * adapter (DNR on Chrome, webRequest on Firefox) before the job starts. A
 * request that sends nothing for the idle limit is a StalledError, tried
 * once more at most, since each one costs the whole limit.
 */
export async function fetchBytes(url: string, opts: FetchOptions): Promise<Uint8Array> {
  const retries = opts.retries ?? 3;
  let attempt = 0;
  let stalls = 0;
  for (;;) {
    try {
      const headers: Record<string, string> = {};
      if (opts.byteRange) {
        const { offset, length } = opts.byteRange;
        headers.Range = `bytes=${offset}-${offset + length - 1}`;
      }
      const { status, body: buf } = await readAll(url, { credentials: 'include', cache: 'no-store', redirect: 'follow', headers }, opts.signal, opts.idleMs ?? fetchIdle.ms);
      if (opts.byteRange && status === 200 && buf.byteLength > opts.byteRange.length) {
        // Server ignored Range and sent the whole file; slice locally.
        return buf.subarray(opts.byteRange.offset, opts.byteRange.offset + opts.byteRange.length);
      }
      return buf;
    } catch (e) {
      if (opts.signal.aborted) throw e;
      // These do not change on a retry. 410 Gone is final by definition, and a missing last DASH segment answers with it.
      if (e instanceof HttpError && (e.status === 403 || e.status === 404 || e.status === 410 || e.status === 401)) throw e;
      if (e instanceof StalledError && stalls++ >= 1) throw e;
      if (attempt++ >= retries) throw e;
      await sleep(400 * 2 ** attempt, opts.signal);
    }
  }
}

/**
 * One request read to its end: the status and the body. HttpError when the
 * status is not ok, StalledError when headers or the next body bytes take
 * longer than `idleMs`.
 */
async function readAll(url: string, init: RequestInit, signal: AbortSignal, idleMs: number): Promise<{ status: number; body: Uint8Array }> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // Every wait races this, so a stall ends the call even where aborting the request does not end its body.
  let fail!: (e: unknown) => void;
  const stall = new Promise<never>((_, reject) => (fail = reject));
  stall.catch(() => {});
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctl.abort();
      reader?.cancel().catch(() => {});
      fail(new StalledError(url, idleMs));
    }, idleMs);
  };
  try {
    arm();
    const res = await Promise.race([fetch(url, { ...init, signal: ctl.signal }), stall]);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpError(res.status, url);
    }
    if (!res.body) return { status: res.status, body: new Uint8Array(await Promise.race([res.arrayBuffer(), stall])) };
    reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      arm();
      const { done, value } = await Promise.race([reader.read(), stall]);
      if (stalled) throw new StalledError(url, idleMs);
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const only = chunks.length === 1 ? chunks[0]! : null;
    if (only && only.byteOffset === 0 && only.byteLength === only.buffer.byteLength) return { status: res.status, body: only };
    const body = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      body.set(c, pos);
      pos += c.byteLength;
    }
    return { status: res.status, body };
  } catch (e) {
    if (stalled && !signal.aborted) throw new StalledError(url, idleMs);
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The server answered a Range request with other bytes than the range (the
 * whole file with 200, the rest of it with 206, or a 200 that cannot be the
 * range), and the body was cancelled.
 */
export class RangeIgnoredError extends Error {
  url: string;

  constructor(url: string) {
    super(`The server ignores Range requests for ${url}`);
    this.url = url;
  }
}

/**
 * Exactly the bytes of `range`, for a small read out of a large file (a DASH
 * SegmentBase index). Unlike fetchBytes, a server that ignores Range and sends
 * the whole file with 200 is refused: the body is cancelled once it runs past
 * the range, and the call throws RangeIgnoredError, so one index read never
 * pulls a whole rendition into memory. A 206 is held to the same limit, and
 * refused at once when its Content-Range starts elsewhere or ends past the
 * range. A 200 whose body fits in the range is the whole file, and the range
 * is cut from it, unless the body is exactly as long as the range and too
 * short to hold it from its offset: then the server answered the range with
 * the wrong status, and the body is the range, which must start with a sidx
 * box since only index reads come here. Retries once on a network error or a
 * 5xx.
 */
export async function fetchRange(url: string, range: ByteRange, signal: AbortSignal): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchRangeOnce(url, range, signal);
    } catch (e) {
      const retry = !signal.aborted && attempt === 0 && (e instanceof TypeError || (e instanceof HttpError && e.status >= 500));
      if (!retry) throw e;
      await sleep(400, signal);
    }
  }
}

async function fetchRangeOnce(url: string, range: ByteRange, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    headers: { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` },
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(res.status, url);
  }
  if (res.status === 206) {
    // A server that honours the start of a range but not its end answers 206 with the rest of the file.
    const span = /^bytes\s+(\d+)-(\d+)\//i.exec(res.headers.get('content-range') ?? '');
    if (span && (Number(span[1]) !== range.offset || Number(span[2]) > range.offset + range.length - 1)) {
      await res.body?.cancel().catch(() => {});
      throw new RangeIgnoredError(url);
    }
    return readUpTo(res, range.length, url);
  }
  // 200: the whole file. Content-Length says at once when it is longer than the range; without it, read up to the range and stop.
  const length = Number(res.headers.get('content-length'));
  if (length > range.length && !res.headers.get('content-encoding')) {
    await res.body?.cancel().catch(() => {});
    throw new RangeIgnoredError(url);
  }
  const whole = await readUpTo(res, range.length, url);
  if (whole.byteLength === range.length && whole.byteLength < range.offset + range.length) {
    // Some servers and proxies answer a Range request with 200 and only the bytes asked for. Only index reads
    // come here, so those bytes are a sidx; a file that happens to be as long as the range is not the range.
    if (boxType(whole) === 'sidx') return whole;
    throw new RangeIgnoredError(url);
  }
  return whole.subarray(range.offset, range.offset + range.length);
}

/** The body of `res`, or RangeIgnoredError with the body cancelled as soon as it runs past `max` bytes. */
async function readUpTo(res: Response, max: number, url: string): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new RangeIgnoredError(url);
    }
  }
  const whole = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    whole.set(c, pos);
    pos += c.byteLength;
  }
  return whole;
}

/** The type of the box at the start of `data`, bytes 4 to 7. */
function boxType(data: Uint8Array): string {
  return data.byteLength >= 8 ? String.fromCharCode(data[4]!, data[5]!, data[6]!, data[7]!) : '';
}

export async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const bytes = await fetchBytes(url, { signal, retries: 2 });
  return new TextDecoder().decode(bytes);
}

/**
 * Run `tasks` with at most `limit` in flight, but never more than `window`
 * ahead of the consumer, which pulls results in order via `next()`.
 */
export function orderedPool<T>(
  count: number,
  limit: number,
  window: number,
  task: (index: number) => Promise<T>,
  signal: AbortSignal,
): { next: () => Promise<T>; } {
  const results = new Map<number, Promise<T>>();
  let consumed = 0;
  let launched = 0;
  const fill = () => {
    while (launched < count && launched - consumed < window && inFlight() < limit) {
      const i = launched++;
      results.set(i, task(i));
      // This chain only counts the task as settled. Its copy of a rejection is
      // swallowed here; next() still rejects with the real error from the task
      // itself. Without the catch, every fetch an abort cuts short is an
      // unhandled rejection.
      results
        .get(i)!
        .finally(() => {
          inflightDone.add(i);
        })
        .catch(() => {});
    }
  };
  const inflightDone = new Set<number>();
  const inFlight = () => {
    let n = 0;
    for (const i of results.keys()) if (!inflightDone.has(i)) n++;
    return n;
  };
  return {
    async next() {
      if (consumed >= count) throw new Error('pool exhausted');
      fill();
      const i = consumed;
      const p = results.get(i)!;
      // Re-fill whenever something settles so the pool stays full.
      p.finally(fill).catch(() => {});
      try {
        return await p;
      } finally {
        results.delete(i);
        inflightDone.delete(i);
        consumed++;
        if (!signal.aborted) fill();
      }
    },
  };
}
