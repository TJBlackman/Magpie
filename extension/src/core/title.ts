/** Title signals read from the page the video plays on. */
export interface PageMeta {
  /** `name` of JSON-LD VideoObject, Movie, Episode or Clip entries. */
  jsonLd: string[];
  og: string;
  twitter: string;
  metaTitle: string;
  doc: string;
  h1: string;
  /** og:site_name or application-name, used to strip "| Site" suffixes. */
  site: string;
}

/**
 * Runs inside the page via scripting.executeScript / tabs.executeScript, so it
 * must stay self contained: no imports, no references to module scope.
 */
export function collectPageMeta(): PageMeta {
  const meta = (sel: string) => (document.querySelector(sel)?.getAttribute('content') ?? '').trim();
  const VIDEO_TYPES = ['VideoObject', 'Movie', 'Episode', 'TVEpisode', 'Clip', 'MusicVideoObject'];
  const jsonLd: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const types = ([] as unknown[]).concat(o['@type'] ?? []).map(String);
    if (types.some((t) => VIDEO_TYPES.includes(t)) && typeof o.name === 'string' && o.name.trim()) jsonLd.push(o.name.trim());
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v, depth + 1);
  };
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      visit(JSON.parse(s.textContent ?? ''), 0);
    } catch {
      /* bad JSON on the page */
    }
  }
  return {
    jsonLd,
    og: meta('meta[property="og:title"]') || meta('meta[name="og:title"]'),
    twitter: meta('meta[name="twitter:title"]') || meta('meta[property="twitter:title"]'),
    metaTitle: meta('meta[name="title"]'),
    doc: (document.title ?? '').trim(),
    h1: (document.querySelector('h1')?.textContent ?? '').trim(),
    site: meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]'),
  };
}

const SEPARATORS = / (?:\||-|–|—|::|·|•|\/) /;

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Pieces of the site's identity a title suffix might repeat. */
function siteNames(site: string, pageUrl: string): string[] {
  const names = new Set<string>();
  if (site) names.add(squash(site));
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, '');
    names.add(squash(host));
    const labels = host.split('.');
    // "video.example.co.uk" -> "example"; "example.com" -> "example"
    const main = labels.length > 2 && labels[labels.length - 2]!.length <= 3 ? labels[labels.length - 3] : labels[labels.length - 2];
    if (main) names.add(squash(main));
  } catch {
    /* no URL */
  }
  names.delete('');
  return [...names];
}

function isSite(part: string, names: string[]): boolean {
  const p = squash(part);
  return p.length > 0 && names.some((n) => p === n || (n.length >= 4 && p.includes(n) && p.length <= n.length + 8));
}

/** Drop "(3) " unread counters and "| Site Name" style affixes. */
export function cleanTitle(raw: string, site: string, pageUrl: string): string {
  let t = raw.replace(/\s+/g, ' ').trim().replace(/^\(\d+\+?\)\s+/, '');
  const names = siteNames(site, pageUrl);
  for (let i = 0; i < 2; i++) {
    const parts = t.split(SEPARATORS);
    if (parts.length < 2) break;
    if (isSite(parts[parts.length - 1]!, names)) parts.pop();
    else if (isSite(parts[0]!, names)) parts.shift();
    else break;
    t = parts.join(' - ').trim();
  }
  // A bare site name ("YouTube" before the video loads) says nothing about the video.
  return isSite(t, names) ? '' : t;
}

/** Best human title for a download from the page's metadata. */
export function pickTitle(m: PageMeta, pageUrl: string): string {
  for (const raw of [...m.jsonLd, m.og, m.twitter, m.metaTitle, m.doc, m.h1]) {
    const t = cleanTitle(raw ?? '', m.site, pageUrl);
    if (t) return t;
  }
  return '';
}
