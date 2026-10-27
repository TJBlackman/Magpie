import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRange, HttpError, orderedPool, RangeIgnoredError } from './fetcher';

describe('orderedPool', () => {
  it('rejects next() with the task error and leaves no unhandled rejection behind', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const abort = new AbortController();
      const pool = orderedPool(3, 3, 3, async (i) => {
        if (i === 0) throw new Error('first failed');
        // The others fail the way a fetch does when the job is aborted.
        await new Promise((r) => setTimeout(r, 5));
        throw new DOMException('aborted', 'AbortError');
      }, abort.signal);
      await expect(pool.next()).rejects.toThrow('first failed');
      abort.abort();
      // Give the other tasks time to settle and Node time to report what nobody caught.
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('hands results back in order', async () => {
    const pool = orderedPool(4, 2, 4, async (i) => {
      await new Promise((r) => setTimeout(r, (4 - i) * 3));
      return i;
    }, new AbortController().signal);
    const got: number[] = [];
    for (let i = 0; i < 4; i++) got.push(await pool.next());
    expect(got).toEqual([0, 1, 2, 3]);
  });
});

describe('fetchRange', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A response whose body arrives in chunks, recording whether the reader cancelled it. */
  function chunked(status: number, chunks: Uint8Array[], headers: Record<string, string> = {}) {
    const state = { cancelled: false, pulled: 0 };
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < chunks.length) {
          state.pulled++;
          c.enqueue(chunks[i++]!);
        } else c.close();
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { res: new Response(body, { status, headers }), state };
  }
  const bytes = (n: number, from = 0) => Uint8Array.from({ length: n }, (_, k) => (from + k) & 0xff);

  it('returns a 206 body as is and sends the Range header', async () => {
    const fetch = vi.fn(async () => new Response(bytes(100, 836), { status: 206 }));
    vi.stubGlobal('fetch', fetch);
    const got = await fetchRange('https://cdn.example/v.mp4', { offset: 836, length: 100 }, new AbortController().signal);
    expect(got).toEqual(bytes(100, 836));
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({ Range: 'bytes=836-935' });
  });

  it('refuses a 200 whose Content-Length is past the range without reading it', async () => {
    const { res, state } = chunked(200, [bytes(64), bytes(64)], { 'content-length': '50000000' });
    vi.stubGlobal('fetch', vi.fn(async () => res));
    await expect(fetchRange('https://cdn.example/v.mp4', { offset: 0, length: 100 }, new AbortController().signal)).rejects.toBeInstanceOf(RangeIgnoredError);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it('refuses a 200 without Content-Length once the body runs past the range', async () => {
    const { res, state } = chunked(200, [bytes(64), bytes(64), bytes(64), bytes(64)]);
    vi.stubGlobal('fetch', vi.fn(async () => res));
    await expect(fetchRange('https://cdn.example/v.mp4', { offset: 0, length: 100 }, new AbortController().signal)).rejects.toBeInstanceOf(RangeIgnoredError);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(4);
  });

  it('cuts the range out of a 200 that holds a file no longer than the range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes(80), { status: 200 })));
    expect(await fetchRange('https://cdn.example/v.mp4', { offset: 10, length: 100 }, new AbortController().signal)).toEqual(bytes(70, 10));
  });

  it('returns a 200 body that is exactly the range as is when it is a sidx, and the range does not start at 0', async () => {
    const index = bytes(100, 836);
    index.set([0, 0, 0, 100, 0x73, 0x69, 0x64, 0x78]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(index.slice(), { status: 200 })));
    expect(await fetchRange('https://cdn.example/v.mp4', { offset: 836, length: 100 }, new AbortController().signal)).toEqual(index);
    // From offset 0 the same body is the whole file and the range at once; either reading gives the same bytes.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes(100), { status: 200 })));
    expect(await fetchRange('https://cdn.example/v.mp4', { offset: 0, length: 100 }, new AbortController().signal)).toEqual(bytes(100));
  });

  it('refuses a 200 body of exactly the range length that is not a sidx: a short file, not the range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes(100, 836), { status: 200 })));
    await expect(fetchRange('https://cdn.example/v.mp4', { offset: 836, length: 100 }, new AbortController().signal)).rejects.toBeInstanceOf(RangeIgnoredError);
  });

  it('refuses a 206 whose Content-Range runs past the range, without reading the rest of the file', async () => {
    const { res, state } = chunked(206, [bytes(64), bytes(64), bytes(64)], { 'content-range': 'bytes 836-50000000/50000001' });
    vi.stubGlobal('fetch', vi.fn(async () => res));
    await expect(fetchRange('https://cdn.example/v.mp4', { offset: 836, length: 100 }, new AbortController().signal)).rejects.toBeInstanceOf(RangeIgnoredError);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it('refuses a 206 that starts elsewhere, and accepts one whose Content-Range is the range', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes(100), { status: 206, headers: { 'content-range': 'bytes 0-99/5000' } })));
    await expect(fetchRange('https://cdn.example/v.mp4', { offset: 836, length: 100 }, new AbortController().signal)).rejects.toBeInstanceOf(RangeIgnoredError);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes(100, 836), { status: 206, headers: { 'content-range': 'bytes 836-935/5000' } })));
    expect(await fetchRange('https://cdn.example/v.mp4', { offset: 836, length: 100 }, new AbortController().signal)).toEqual(bytes(100, 836));
  });

  it('refuses a 206 without Content-Range once its body runs past the range', async () => {
    const { res, state } = chunked(206, [bytes(64), bytes(64), bytes(64), bytes(64)]);
    vi.stubGlobal('fetch', vi.fn(async () => res));
    await expect(fetchRange('https://cdn.example/v.mp4', { offset: 836, length: 100 }, new AbortController().signal)).rejects.toBeInstanceOf(RangeIgnoredError);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(4);
  });

  it('throws HttpError on a 404 without retrying', async () => {
    const fetch = vi.fn(async () => new Response('gone', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchRange('https://cdn.example/v.mp4', { offset: 0, length: 10 }, new AbortController().signal)).rejects.toBeInstanceOf(HttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
