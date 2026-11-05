import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ArchiveEntry } from '../core/archive';
import { api, openPage } from './api';
import { fmtBytes, fmtClock, fmtDateTime, fmtDay, hostOf, isWebUrl, kindOfUrl, qualityOfFile } from './format';
import { Button, Empty, IconButton, MediaRow, MediaTile } from './components';
import { IconExternal, IconFolder, IconHistory, IconMinusCircle, IconMore, IconSearch } from './icons';

/**
 * A row's extra actions behind one small button, shown while the row is
 * hovered or holds keyboard focus. The list opens above the button when the
 * row sits low in the panel. Escape or a click elsewhere closes it.
 */
function RowMenu({ items }: { items: { label: string; hint?: string; icon: ReactNode; run: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    // Opened from the keyboard, focus goes to the first item.
    if (box.current?.contains(document.activeElement) && document.activeElement?.matches(':focus-visible')) box.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <span
      ref={box}
      className={`absolute top-1/2 right-2.5 -translate-y-1/2 items-center rounded-lg bg-[#18202b] ${open ? 'z-40 flex' : 'z-10 hidden group-focus-within:flex group-hover:flex'}`}
      onKeyDown={(e) => {
        if (!open) return;
        const list = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const at = list.indexOf(document.activeElement as HTMLElement);
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
        }
      }}
    >
      <IconButton
        label="More"
        active={open}
        framed={!open}
        className={open ? 'size-9' : 'size-9 !text-fg2'}
        ref={trigger}
        onClick={() => {
          const r = box.current?.getBoundingClientRect();
          setUp(!!r && r.top > window.innerHeight / 2);
          setOpen((o) => !o);
        }}
      >
        <IconMore size={20} />
      </IconButton>
      {open && (
        <span role="menu" className={`rise-in absolute right-0 z-30 flex w-max min-w-44 flex-col rounded-xl bg-panel3 p-1 shadow-[0_12px_32px_rgba(0,0,0,.55)] ring-1 ring-edge3 ring-inset ${up ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          {items.map((it, i) => (
            <button
              key={it.label}
              data-danger={it.danger || undefined}
              type="button"
              role="menuitem"
              title={it.hint ? `${it.label}. ${it.hint}` : it.label}
              onClick={() => {
                setOpen(false);
                it.run();
              }}
              className={`flex h-9 items-center gap-2.5 rounded-lg px-3 text-left text-[12.5px] whitespace-nowrap transition-colors hover:bg-btn-hover focus-visible:bg-btn-hover focus-visible:outline-offset-[-2px] ${it.danger ? 'text-live-soft' : 'text-text'} ${it.danger && i > 0 ? 'relative mt-[5px] before:absolute before:inset-x-1 before:-top-[3px] before:h-px before:bg-edge2' : ''}`}
            >
              <span className={it.danger ? 'text-live-soft' : 'text-mute'}>{it.icon}</span>
              {it.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** The title with the part that matches the search marked. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-[#1d5f6e] px-px font-semibold text-text">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

/**
 * One finished download: its frame with the length on it, the day, the
 * quality and size. Clicking the row shows the file on disk; More opens its
 * page or forgets it, so the media shows as new again. Memoized: entries only
 * change on an archive event, while the popup re-renders with every progress event.
 */
export const HistoryRow = memo(function HistoryRow({ entry, thumbs, query, onMissing }: { entry: ArchiveEntry; thumbs: boolean; query: string; onMissing: () => void }) {
  const page = entry.page;
  const kind = entry.kind ?? kindOfUrl(entry.src);
  const title = entry.title || entry.file;
  const folder = !!entry.files;
  // "2160p · 1.4 GB": the quality from the file name Magpie gave it, and the size it saved.
  const facts = [qualityOfFile(entry.file), entry.bytes ? fmtBytes(entry.bytes) : ''].filter(Boolean).join(' · ');
  const show = () => void api.showFile(entry.file, folder).then((r) => r.ok && !r.value && onMissing());
  return (
    <MediaRow
      attrs={{ 'data-testid': 'archive-entry', 'data-job-id': entry.id, 'data-file': entry.file }}
      tile={<MediaTile kind={kind} thumb={thumbs ? entry.thumb : undefined} corner={entry.secs ? fmtClock(entry.secs) : entry.files ? `${entry.files} files` : undefined} />}
      title={highlight(title, query)}
      titleTip={entry.file}
      titleTestId="archive-title"
      meta={
        <span className="min-w-0 flex-1 truncate" title={`Saved ${fmtDateTime(entry.at)}${page ? ` from ${page}` : ''}`}>
          {fmtDay(entry.at)}
          {facts && (
            <>
              {' · '}
              <span className="tabular-nums">{facts}</span>
            </>
          )}
        </span>
      }
      onOpen={show}
      openTip={folder ? 'Show the folder' : 'Show in folder'}
      action={
        <span className="flex size-9 shrink-0 items-center justify-center text-mute" aria-hidden="true">
          <IconFolder size={16} />
        </span>
      }
      overlay={
        <RowMenu
          items={[
            { label: folder ? 'Show the folder' : 'Show in folder', hint: 'Where the file was saved', icon: <IconFolder size={15} />, run: show },
            ...(page && isWebUrl(page) ? [{ label: 'Open page', hint: 'The page this video came from', icon: <IconExternal size={15} />, run: () => openPage(page) }] : []),
            { label: 'Remove from history', hint: 'The file stays on disk', icon: <IconMinusCircle size={15} />, run: () => void api.removeArchive(entry.id), danger: true },
          ]}
        />
      }
    />
  );
});

/** History entries, or a line saying there are none. */
export const HistoryList = memo(function HistoryList({ entries, total, query, thumbs, onMissing, onBrowse, browseLabel }: { entries: ArchiveEntry[]; total: number; query: string; thumbs: boolean; onMissing: () => void; onBrowse?: () => void; browseLabel: string }) {
  if (!total) {
    return (
      <Empty icon={<IconHistory size={22} />} title="Nothing downloaded yet" action={onBrowse ? <Button tone="accent" size="md" onClick={onBrowse}>{browseLabel}</Button> : undefined}>
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
