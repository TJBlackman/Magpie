export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 48 ? '…' + u.pathname.slice(-46) : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url;
  }
}

/** "cdn.example.com · master.m3u8": where a stream comes from, short enough for one line. */
export function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return last ? `${u.hostname} · ${last}` : u.hostname;
  } catch {
    return url;
  }
}

/** 0..1 when progress is measurable, null when it is not (unknown size). */
export function jobProgress(job: {
  state: string;
  kind: string;
  bytes: number;
  bytesTotal?: number;
  segmentsDone: number;
  segmentsTotal: number;
}): number | null {
  if (job.state === 'done') return 1;
  if (job.state === 'queued') return 0;
  if (job.kind === 'file') {
    if (job.bytesTotal) return Math.min(1, job.bytes / job.bytesTotal);
    return job.state === 'saving' ? 1 : null;
  }
  if (job.state === 'muxing' || job.state === 'saving') return 1;
  return job.segmentsTotal ? job.segmentsDone / job.segmentsTotal : null;
}

export function fmtRate(bytesPerSec: number): string {
  return `${fmtBytes(Math.round(bytesPerSec))}/s`;
}

export function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s left`;
  return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

export function kindLabel(kind: string): string {
  return { hls: 'HLS', dash: 'DASH', file: 'FILE' }[kind] ?? kind.toUpperCase();
}
