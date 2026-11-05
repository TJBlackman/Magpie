import { memo, type ReactNode } from 'react';
import type { ArchiveEntry } from '../core/archive';
import { api, openPage } from './api';
import { fmtClock, fmtDateTime, fmtDay, isWebUrl, kindOfUrl, shortUrl } from './format';
import { Empty, IconButton, MediaRow, MediaTile } from './components';
import { IconFolder, IconHistory, IconSearch, IconX } from './icons';

/** The title with the part that matches the search marked. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-shine/25 px-px text-white">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

/**
 * One finished download: its frame with the length on it, the day, and a
 * link to the page it came from. The folder button shows the file on disk;
 * X forgets it, so the media shows as new again. Memoized: entries only
 * change on an archive event, while the popup re-renders with every progress event.
 */
export const HistoryRow = memo(function HistoryRow({ entry, thumbs, query, onMissing }: { entry: ArchiveEntry; thumbs: boolean; query: string; onMissing: () => void }) {
  const page = entry.page;
  const kind = entry.kind ?? kindOfUrl(entry.src);
  const title = entry.title || entry.file;
  const folder = !!entry.files;
  return (
    <MediaRow
      attrs={{ 'data-testid': 'archive-entry', 'data-job-id': entry.id, 'data-file': entry.file }}
      tile={<MediaTile kind={kind} thumb={thumbs ? entry.thumb : undefined} corner={entry.secs ? fmtClock(entry.secs) : entry.files ? `${entry.files} files` : undefined} />}
      title={highlight(title, query)}
      titleTip={entry.file}
      titleTestId="archive-title"
      meta={
        <>
          <span className="shrink-0" title={`Saved ${fmtDateTime(entry.at)}`}>
            {fmtDay(entry.at)}
          </span>
          {page && <span className="shrink-0 text-dim">·</span>}
          {page && isWebUrl(page) ? (
            <a
              href={page}
              target="_blank"
              rel="noreferrer"
              title={`Open ${page} in a new tab`}
              className="min-w-0 truncate rounded-sm text-dim underline-offset-2 transition-colors hover:text-shine hover:underline"
              onClick={(e) => {
                e.preventDefault();
                openPage(page);
              }}
            >
              {shortUrl(page)}
            </a>
          ) : page ? (
            <span className="min-w-0 truncate text-dim" title={page}>
              {shortUrl(page)}
            </span>
          ) : null}
        </>
      }
      action={
        <>
          <IconButton label={folder ? 'Show the folder' : 'Show in folder'} onClick={() => void api.showFile(entry.file, folder).then((r) => r.ok && !r.value && onMissing())}>
            <IconFolder size={16} />
          </IconButton>
          <span className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <IconButton label="Remove from history. The video shows as new again." onClick={() => void api.removeArchive(entry.id)}>
              <IconX size={16} />
            </IconButton>
          </span>
        </>
      }
    />
  );
});

/** History entries, or a line saying there are none. */
export const HistoryList = memo(function HistoryList({ entries, total, query, thumbs, onMissing }: { entries: ArchiveEntry[]; total: number; query: string; thumbs: boolean; onMissing: () => void }) {
  if (!total) {
    return (
      <Empty icon={<IconHistory size={22} />} title="Nothing downloaded yet">
        Finished downloads are listed here and marked on the page, so you never grab the same video twice.
      </Empty>
    );
  }
  if (!entries.length)
    return (
      <Empty icon={<IconSearch size={22} />} title="No matches">
        {`Nothing in history matches "${query.trim()}".`}
      </Empty>
    );
  return (
    <div className="flex flex-col gap-2" data-testid="archive">
      {entries.map((e) => (
        <HistoryRow key={e.id} entry={e} thumbs={thumbs} query={query} onMissing={onMissing} />
      ))}
    </div>
  );
});
