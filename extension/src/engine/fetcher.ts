import type { ByteRange } from '../core/hls';

export interface FetchOptions {
  signal: AbortSignal;
  byteRange?: ByteRange;
  retries?: number;
}

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

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

/**
 * Fetch bytes with cookies, optional Range, and bounded retries. Fetches run
 * from the extension origin; Referer/Origin are patched by the platform
 * adapter (DNR on Chrome, webRequest on Firefox) before the job starts.
 */
export async function fetchBytes(url: string, opts: FetchOptions): Promise<Uint8Array> {
  const retries = opts.retries ?? 3;
  let attempt = 0;
  for (;;) {
    try {
      const headers: Record<string, string> = {};
      if (opts.byteRange) {
        const { offset, length } = opts.byteRange;
        headers.Range = `bytes=${offset}-${offset + length - 1}`;
      }
      const res = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        headers,
        signal: opts.signal,
      });
      if (!res.ok) throw new HttpError(res.status, url);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (opts.byteRange && res.status === 200 && buf.byteLength > opts.byteRange.length) {
        // Server ignored Range and sent the whole file; slice locally.
        return buf.subarray(opts.byteRange.offset, opts.byteRange.offset + opts.byteRange.length);
      }
      return buf;
    } catch (e) {
      if (opts.signal.aborted) throw e;
      // These do not change on a retry. 410 Gone is final by definition, and a missing last DASH segment answers with it.
      if (e instanceof HttpError && (e.status === 403 || e.status === 404 || e.status === 410 || e.status === 401)) throw e;
      if (attempt++ >= retries) throw e;
      await sleep(400 * 2 ** attempt, opts.signal);
    }
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
