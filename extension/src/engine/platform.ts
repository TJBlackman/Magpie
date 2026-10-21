import type { Job } from '../core/types';

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
  /** Push job list changes to whoever is listening (popup, manager, background). */
  jobsChanged(jobs: Job[]): void;
}
