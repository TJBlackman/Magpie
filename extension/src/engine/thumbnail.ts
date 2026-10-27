/*
 * Thumbnails: one frame of the stream, decoded by the browser from a small
 * sample of the media and scaled to a 16:9 JPEG of a few kilobytes.
 *
 * The engine fetches the sample (one segment of the lowest rendition, or the
 * first megabyte of a plain file) and this file turns it into a picture with a
 * hidden <video> and a canvas. That needs a DOM, which both engine hosts have:
 * the offscreen document on Chrome and the background page on Firefox.
 */

export const THUMB_W = 128;
export const THUMB_H = 72;
/** Bytes of a plain file to fetch: enough for the index and the first frames of most MP4s. */
export const FILE_SAMPLE = 1024 * 1024;
/** Cap on one HLS segment fetched for a frame. Lowest renditions are far smaller than this. */
export const SEGMENT_CAP = 4 * 1024 * 1024;
/** Whole capture, fetch and decode, before it gives up. */
export const THUMB_TIMEOUT = 12_000;
/** A data URL longer than this is not kept: something went wrong with the encode. */
export const THUMB_MAX_CHARS = 24_000;

/** The first `max` bytes of `url`: a Range request, with the body cancelled past the cap when the server ignores Range. */
export async function fetchPrefix(url: string, max: number, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow', headers: { Range: `bytes=0-${max - 1}` }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).subarray(0, max);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total >= max) await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(total, max));
  let pos = 0;
  for (const c of chunks) {
    const n = Math.min(c.byteLength, out.byteLength - pos);
    out.set(c.subarray(0, n), pos);
    pos += n;
    if (pos >= out.byteLength) break;
  }
  return out;
}

/**
 * Decode `parts` (an MP4, or the start of one) in a hidden <video> and return
 * one frame as a JPEG data URL, or null when nothing decodes. `seek` picks a
 * frame about a second in, past any fade from black; off for a cut file,
 * where only the first frames have all their bytes.
 */
export function frameFromMp4(parts: Uint8Array[], seek: boolean): Promise<string | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'video/mp4' }));
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    let done = false;
    let seeking = false;
    const finish = (out: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(out);
    };
    /** Draw the current frame. When nothing is decoded yet, give up only on the final try; earlier triggers just pass. */
    const draw = (final: boolean) => {
      if (done) return;
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        if (final) finish(null);
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = THUMB_W;
      canvas.height = THUMB_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return finish(null);
      // Cover: scale to fill the 16:9 slot and crop the rest, centred.
      const scale = Math.max(THUMB_W / video.videoWidth, THUMB_H / video.videoHeight);
      const w = video.videoWidth * scale;
      const h = video.videoHeight * scale;
      ctx.drawImage(video, (THUMB_W - w) / 2, (THUMB_H - h) / 2, w, h);
      try {
        const out = canvas.toDataURL('image/jpeg', 0.6);
        finish(out.length <= THUMB_MAX_CHARS ? out : null);
      } catch {
        finish(null);
      }
    };
    const timer = setTimeout(() => draw(true), 5000);
    // After a seek, 'seeked' can fire before the new frame is painted (Chrome,
    // remuxed TS), and a draw then is black. So draw when the next frame is
    // presented, or after a short wait when no new frame comes because the one
    // showing is already right (Chrome fMP4) or the callback is early (Firefox).
    const onFrame = typeof video.requestVideoFrameCallback === 'function' ? video.requestVideoFrameCallback.bind(video) : null;
    video.addEventListener('error', () => finish(null));
    video.addEventListener('loadedmetadata', () => {
      const d = video.duration;
      if (seek && Number.isFinite(d) && d > 1.5) {
        seeking = true;
        video.currentTime = Math.min(1, d / 2);
      }
    });
    video.addEventListener('seeked', () => {
      onFrame?.(() => draw(false));
      setTimeout(() => draw(true), 600);
    });
    video.addEventListener('loadeddata', () => {
      if (!seeking) draw(true);
    });
    video.src = url;
  });
}
