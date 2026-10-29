/** Characters no path component may hold on Windows, plus `~`, which Chromium's download path check refuses too. */
const ILLEGAL = new Set('<>:"/\\|?*~');
/** Names Windows reserves, alone or before an extension; Chromium checks them on every OS. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(\.|$)|^(desktop\.ini|thumbs\.db)$/i;

/**
 * True for a code point the browser's download path check rejects anywhere:
 * control and format characters (a zero width joiner inside an emoji, a soft
 * hyphen, a bidi mark), Unicode noncharacters, and lone surrogates.
 */
function illegalCodePoint(cp: number): boolean {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp >= 0xd800 && cp <= 0xdfff) return true;
  if ((cp & 0xfffe) === 0xfffe || (cp >= 0xfdd0 && cp <= 0xfdef)) return true;
  return /\p{Cf}/u.test(String.fromCodePoint(cp));
}

/**
 * One path component the downloads API accepts on every platform: reserved
 * characters become spaces, invisible characters go, whitespace collapses,
 * no dots or spaces at either end, no reserved Windows name, at most `max`
 * code points (cut between characters, never inside a surrogate pair).
 */
export function cleanSegment(name: string, fallback: string, max = 120): string {
  let out = '';
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    if (ILLEGAL.has(ch)) out += ' ';
    else if (!illegalCodePoint(cp)) out += ch;
  }
  const trim = (s: string) => s.replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
  out = trim(Array.from(trim(out)).slice(0, max).join(''));
  if (RESERVED.test(out)) out = `_${out}`;
  return out || fallback;
}

export function sanitizeFilename(name: string, fallback = 'video'): string {
  return cleanSegment(name, fallback);
}

/** A container of 'audio' marks a stream without video (an audio only MPD), which is saved as .m4a. */
export function guessExtension(kind: string, container: string | undefined, mime: string, url: string): string {
  if (kind === 'file') {
    const m = /\.(mp4|m4v|webm|mov|mkv|m4a|mp3|ogg|ogv|flv|jpe?g|png|webp|gif)(\?|#|$)/i.exec(url);
    if (m) return m[1]!.toLowerCase();
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('ogg')) return 'ogv';
    if (mime.startsWith('audio/')) return 'm4a';
    if (mime.startsWith('image/')) return mime.slice(6).replace('jpeg', 'jpg');
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
