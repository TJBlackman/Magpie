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

export function guessExtension(kind: string, container: string | undefined, mime: string, url: string): string {
  if (kind === 'file') {
    const m = /\.(mp4|m4v|webm|mov|mkv|m4a|mp3|ogg|ogv|flv)(\?|#|$)/i.exec(url);
    if (m) return m[1]!.toLowerCase();
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('ogg')) return 'ogv';
    if (mime.startsWith('audio/')) return 'm4a';
    return 'mp4';
  }
  return 'mp4';
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
