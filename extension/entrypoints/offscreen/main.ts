import { browser } from 'wxt/browser';
import { broadcastJobs, hostEngine } from '../../src/engine/host';
import type { Envelope, EngineToBg, Result } from '../../src/core/types';

// Chrome only. Offscreen documents get runtime messaging and the DOM, nothing
// else, so downloads and header rules are requested from the service worker.
async function toBg<T>(req: EngineToBg): Promise<T> {
  const env: Envelope = { magpie: 'engine-to-bg', req };
  const res = (await browser.runtime.sendMessage(env)) as Result<T> | undefined;
  if (!res) throw new Error('background did not answer');
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

hostEngine({
  setHeaderRule: (host, referer, origin) => toBg<null>({ type: 'headerRule', host, referer, origin }).then(() => {}),
  saveBlob: (blobUrl, filename, jobId) => toBg<number | undefined>({ type: 'saveBlob', blobUrl, filename, jobId }),
  jobsChanged: (jobs) => {
    broadcastJobs(jobs);
    toBg({ type: 'jobsChanged', jobs }).catch(() => {});
  },
});
