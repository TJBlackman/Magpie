import { browser } from 'wxt/browser';
import {
  ARCHIVE_KEY,
  addEntry,
  indexArchive,
  isArchived,
  mergeStores,
  normalizeArchive,
  splitForStorage,
  type ArchiveEntry,
  type ArchiveIndex,
} from '../core/archive';
import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings, type Settings } from '../core/settings';
import type { Candidate } from '../core/types';

/**
 * Finished downloads, newest first. The background is the only writer: the
 * engine reports each finished job (from the Chrome offscreen document by
 * message) and the UI asks here to list, remove or clear.
 *
 * Entries live in storage.local. Private window entries go to storage.session
 * instead, which survives a Chrome service worker restart, and are forgotten
 * when the last private window closes, unless the user keeps them. A store
 * that could not be read is never written, so a failed read cannot wipe it;
 * the list then works from memory until the background restarts.
 */
export class Archive {
  private entries: ArchiveEntry[] = [];
  private index: ArchiveIndex = indexArchive([]);
  private size = DEFAULT_SETTINGS.archiveSize;
  private keepPrivate = DEFAULT_SETTINGS.archivePrivate;
  private loaded = false;
  /** Stores whose read succeeded. Only these are written. */
  private readable = { local: false, session: false };
  private chain: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;
  /** Called with the new list after every change. */
  onChange: ((entries: ArchiveEntry[]) => void) | null = null;

  constructor() {
    this.ready = this.load();
  }

  async list(): Promise<ArchiveEntry[]> {
    await this.ready;
    return this.entries;
  }

  /** True when the archive has this candidate's stream. `siblings` are the tab's other streams. False until the archive has loaded. */
  has(c: Candidate, siblings: Candidate[] = []): boolean {
    return this.loaded && isArchived(c, this.index, siblings);
  }

  /** Add a finished download. False when the archive is off. */
  add(entry: ArchiveEntry): Promise<boolean> {
    return this.queue(async () => {
      if (this.size === 0) return false;
      await this.change(addEntry(this.entries, entry, this.size));
      return true;
    });
  }

  remove(id: string): Promise<void> {
    return this.queue(async () => {
      if (this.entries.some((e) => e.id === id)) await this.change(this.entries.filter((e) => e.id !== id));
    });
  }

  clear(): Promise<void> {
    return this.queue(async () => {
      if (this.entries.length) await this.change([]);
    });
  }

  /** Drop private window entries, unless the user keeps them. Called once no private window is open. */
  forgetPrivate(): Promise<void> {
    return this.queue(async () => {
      if (!this.keepPrivate && this.entries.some((e) => e.priv)) await this.change(this.entries.filter((e) => !e.priv));
    });
  }

  /** Apply new settings. A smaller size drops the oldest entries now; the same size changes nothing. */
  configure(settings: Settings): Promise<void> {
    return this.queue(async () => {
      const resized = settings.archiveSize !== this.size;
      const moved = settings.archivePrivate !== this.keepPrivate;
      this.size = settings.archiveSize;
      this.keepPrivate = settings.archivePrivate;
      if (resized && this.entries.length > this.size) await this.change(this.entries.slice(0, this.size));
      else if (moved) await this.persist();
    });
  }

  /** Run writes one at a time, after the stored list has loaded. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.ready).then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async change(next: ArchiveEntry[]) {
    this.entries = next;
    this.index = indexArchive(next);
    await this.persist();
    this.onChange?.(next);
  }

  private get session(): chrome.storage.StorageArea | null {
    return (browser.storage as unknown as { session?: chrome.storage.StorageArea }).session ?? null;
  }

  private async persist() {
    const { local, session } = splitForStorage(this.entries, this.keepPrivate);
    if (this.readable.local) await browser.storage.local.set({ [ARCHIVE_KEY]: local }).catch(() => {});
    if (this.readable.session) await this.session?.set({ [ARCHIVE_KEY]: session }).catch(() => {});
  }

  /** Read both stores. Nothing is trimmed here: the size setting is read in the same call, but only add and configure trim. */
  private async load() {
    const read = (p: Promise<unknown> | undefined) => (p ?? Promise.reject()).then((r) => r as Record<string, unknown>, () => null);
    const local = await read(browser.storage.local.get([SETTINGS_KEY, ARCHIVE_KEY]));
    const session = await read(this.session?.get(ARCHIVE_KEY));
    this.readable = { local: local !== null, session: session !== null };
    const settings = normalizeSettings(local?.[SETTINGS_KEY]);
    this.size = settings.archiveSize;
    this.keepPrivate = settings.archivePrivate;
    this.entries = mergeStores(normalizeArchive(local?.[ARCHIVE_KEY]), normalizeArchive(session?.[ARCHIVE_KEY]));
    this.index = indexArchive(this.entries);
    this.loaded = true;
  }
}
