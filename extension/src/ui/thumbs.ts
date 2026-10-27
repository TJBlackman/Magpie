/**
 * Thumbnails for one kind of row (jobs or history), kept for the life of the
 * popup. List answers bring them; change events do not, so rows from an event
 * get theirs from here. A row seen without one is asked about once, by id,
 * since a job or entry either has a frame from the start or never will.
 */
export class ThumbCache {
  private have = new Map<string, string>();
  private asked = new Set<string>();

  /** The rows with thumbnails filled in. Rows that bring one teach the cache; rows that need none are returned as they are. */
  fill<T extends { id: string; thumb?: string }>(rows: T[]): T[] {
    return rows.map((r) => {
      if (r.thumb) {
        this.have.set(r.id, r.thumb);
        return r;
      }
      const thumb = this.have.get(r.id);
      return thumb ? { ...r, thumb } : r;
    });
  }

  /** Ids of rows still without a thumbnail that have not been asked about. Marks them asked. */
  missing(rows: { id: string; thumb?: string }[]): string[] {
    const ids: string[] = [];
    for (const r of rows) {
      if (r.thumb || this.have.has(r.id) || this.asked.has(r.id)) continue;
      this.asked.add(r.id);
      ids.push(r.id);
    }
    return ids;
  }

  /** Thumbnails from a `thumbs` answer. */
  learn(map: Record<string, string>): void {
    for (const [id, thumb] of Object.entries(map)) if (thumb) this.have.set(id, thumb);
  }
}
