import type { ArchiveEntry } from '../core/archive';
import type { Candidate, Job } from '../core/types';

/**
 * What the engine needs from the browser that differs per host context.
 * Firefox: implemented directly in the background page.
 * Chrome: implemented in the offscreen document by messaging the service worker.
 */
export interface Platform {
  /** Make segment fetches to `host` carry the page's Referer and Origin. */
  setHeaderRule(host: string, referer: string, origin: string): Promise<void>;
  /** Hand a finished file to the browser's download manager. */
  saveBlob(blobUrl: string, filename: string, jobId: string): Promise<number | undefined>;
  /**
   * Resolves once the download manager is done with a download (complete or
   * interrupted). Only the Firefox host has it, the one place files live in memory.
   */
  whenSaved?(downloadId: number): Promise<void>;
  /** Push job list changes to whoever is listening (popup, manager, background). */
  jobsChanged(jobs: Job[]): void;
  /** Record a finished download. False when the archive is off; the job then stays in the list as done. */
  archive(entry: ArchiveEntry): Promise<boolean>;
  /**
   * The newest URL the page has fetched for the stream `candidate` came from:
   * another one when the player renewed its token or the page was reloaded.
   * A live recording whose playlist stops answering follows it there.
   */
  freshUrl?(candidate: Candidate): Promise<string | undefined>;
}
