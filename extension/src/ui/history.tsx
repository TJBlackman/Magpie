import { memo } from 'react';
import type { ArchiveEntry } from '../core/archive';
import { api, openPage } from './api';
import { fmtClock, fmtDate, fmtDateTime, isWebUrl, kindOfUrl, shortUrl } from './format';
import { Empty, IconButton, KindBadge, MediaRow, MediaTile } from './components';
import { IconHistory, IconX } from './icons';

/**
 * One finished download: the same row it had on the page, with the date, length
 * and a link to the page it came from. Memoized: entries only change on an
 * archive event, while the popup re-renders with every progress event.
 */
export const HistoryRow = memo(function HistoryRow({ entry, thumbs }: { entry: ArchiveEntry; thumbs: boolean }) {
  const page = entry.page;
  const kind = entry.kind ?? kindOfUrl(entry.src);
  return (
    <MediaRow
      attrs={{ 'data-testid': 'archive-entry', 'data-job-id': entry.id, 'data-file': entry.file }}
      tile={<MediaTile kind={kind} thumb={thumbs ? entry.thumb : undefined} />}
      title={entry.title || entry.file}
      titleTip={entry.file}
      titleTestId="archive-title"
      meta={
        <>
          <KindBadge kind={kind} />
          <span className="shrink-0" title={fmtDateTime(entry.at)}>
            {fmtDate(entry.at)}
          </span>
          {entry.secs ? <span className="shrink-0">{`· ${fmtClock(entry.secs)}`}</span> : null}
          {entry.files ? <span className="shrink-0">{`· ${entry.files} files`}</span> : null}
          {page && <span className="shrink-0">·</span>}
          {page && isWebUrl(page) ? (
            <a
              href={page}
              target="_blank"
              rel="noreferrer"
              title={`Open ${page} in a new tab`}
              className="min-w-0 truncate text-shine hover:underline"
              onClick={(e) => {
                e.preventDefault();
                openPage(page);
              }}
            >
              {shortUrl(page)}
            </a>
          ) : page ? (
            <span className="min-w-0 truncate" title={page}>
              {shortUrl(page)}
            </span>
          ) : null}
        </>
      }
      action={
        <IconButton label="Remove from history. The video shows as new again." onClick={() => void api.removeArchive(entry.id)} className="size-9">
          <IconX />
        </IconButton>
      }
    />
  );
});

/** History entries, or a line saying there are none. */
export const HistoryList = memo(function HistoryList({ entries, total, query, thumbs }: { entries: ArchiveEntry[]; total: number; query: string; thumbs: boolean }) {
  if (!total) {
    return (
      <Empty icon={<IconHistory size={26} />} title="Nothing downloaded yet">
        Finished downloads are remembered here, so you never grab the same video twice.
      </Empty>
    );
  }
  if (!entries.length) return <div className="rounded-xl border border-dashed border-edge2 p-4 text-center text-mute">{`No match for "${query}".`}</div>;
  return (
    <div className="flex flex-col gap-1.5" data-testid="archive">
      {entries.map((e) => (
        <HistoryRow key={e.id} entry={e} thumbs={thumbs} />
      ))}
    </div>
  );
});
