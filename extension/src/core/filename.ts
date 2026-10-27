const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

export function sanitizeFilename(name: string, fallback = 'video'): string {
  const cleaned = name
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/** A container of 'audio' marks a stream without video (an audio only MPD), which is saved as .m4a. */
export function guessExtension(kind: string, container: string | undefined, mime: string, url: string): string {
  if (kind === 'file') {
    const m = /\.(mp4|m4v|webm|mov|mkv|m4a|mp3|ogg|ogv|flv)(\?|#|$)/i.exec(url);
    if (m) return m[1]!.toLowerCase();
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('ogg')) return 'ogv';
    if (mime.startsWith('audio/')) return 'm4a';
    return 'mp4';
  }
  return container === 'audio' ? 'm4a' : 'mp4';
}

export function buildFilename(title: string, kind: string, container: string | undefined, mime: string, url: string, variantLabel?: string): string {
  const base = sanitizeFilename(title || hostOf(url));
  const ext = guessExtension(kind, container, mime, url);
  const q = variantLabel && /\d+x\d+/.test(variantLabel) ? ` [${/\d+x(\d+)/.exec(variantLabel)![1]}p]` : '';
  return `${base}${q}.${ext}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'video';
  }
}

/** "Cam 2026-10-21 15.04.mp4" becomes "Cam 2026-10-21 15.04 part 2.mp4". */
export function withPart(filename: string, part: number): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)} part ${part}${filename.slice(dot)}` : `${filename} part ${part}`;
}

/** "Cam.mp4" becomes "Cam 2026-10-21 15.04.mp4", so recordings of one live stream do not collide. */
export function withTimestamp(filename: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? `${filename.slice(0, dot)} ${stamp}${filename.slice(dot)}` : `${filename} ${stamp}`;
}
