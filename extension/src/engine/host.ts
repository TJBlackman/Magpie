import { browser } from 'wxt/browser';
import { Engine } from './engine';
import type { Platform } from './platform';
import { err, ok, type EngineRequest, type Envelope, type Job, type Result } from '../core/types';

/**
 * Wire an Engine to runtime messaging. Both hosts (Firefox background page,
 * Chrome offscreen document) call this; only the Platform differs.
 */
export function hostEngine(platform: Platform): Engine {
  const engine = new Engine(platform);

  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    const msg = raw as Envelope;
    if (!msg || msg.magpie !== 'engine') return;
    handle(engine, msg.req)
      .then(sendResponse)
      .catch((e) => sendResponse(err(String(e))));
    return true;
  });

  return engine;
}

export async function handle(engine: Engine, req: EngineRequest): Promise<Result<unknown>> {
  switch (req.type) {
    case 'inspect':
      return engine.inspect(req.candidate);
    case 'start':
      engine.configure(req.settings);
      return engine.start(req.candidate, req.variantId);
    case 'configure':
      engine.configure(req.settings);
      return ok(null);
    case 'cancel':
      engine.cancel(req.jobId);
      return ok(null);
    case 'removeJob':
      engine.remove(req.jobId);
      return ok(null);
    case 'jobs':
      return ok(engine.list());
  }
}

/** Broadcast job changes to UI pages. Nobody listening is fine. */
export function broadcastJobs(jobs: Job[]): void {
  const env: Envelope = { magpie: 'ui', event: { type: 'jobs', jobs } };
  browser.runtime.sendMessage(env).catch(() => {});
}
