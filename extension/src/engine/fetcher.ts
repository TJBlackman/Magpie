import type { ByteRange } from '../core/hls';

export interface FetchOptions {
  signal: AbortSignal;
  byteRange?: ByteRange;
  retries?: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
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
      if (e instanceof HttpError && (e.status === 403 || e.status === 404 || e.status === 401)) throw e;
      if (attempt++ >= retries) throw e;
      await sleep(400 * 2 ** attempt, opts.signal);
    }
  }
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
      results.get(i)!.finally(() => {
        inflightDone.add(i);
      });
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
