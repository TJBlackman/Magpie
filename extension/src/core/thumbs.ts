/**
 * Thumbnails are a few kilobytes each and never change once a row has one, so
 * they travel once per row (in a list answer or a `thumbs` answer), never with
 * the progress events that fire several times a second.
 */

/** The row without its thumbnail. The input is not changed. */
export function withoutThumb<T extends { thumb?: string }>(row: T): T {
  if (row.thumb === undefined) return row;
  const copy = { ...row };
  delete copy.thumb;
  return copy;
}

/** What the background answers a `thumbs` request with: data URLs by row id, only for rows that have one. */
export interface ThumbMap {
  jobs: Record<string, string>;
  archive: Record<string, string>;
}

/** Thumbnails of the rows whose ids are wanted. */
export function pickThumbs(rows: { id: string; thumb?: string }[], ids: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!ids?.length) return out;
  const want = new Set(ids);
  for (const r of rows) if (r.thumb && want.has(r.id)) out[r.id] = r.thumb;
  return out;
}
