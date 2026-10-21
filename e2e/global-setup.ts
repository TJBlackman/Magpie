import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, serverExe, testsiteDir } from './paths';

const PID_FILE = join(root, 'e2e', '.server.pid');

async function waitFor(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} did not come up`);
}

export default async function globalSetup() {
  if (!existsSync(serverExe)) throw new Error(`build the test server first: ${serverExe}`);
  if (!existsSync(join(testsiteDir, 'public', 'media', 'src', '720.mp4'))) {
    throw new Error('fixtures missing; run: wsl -u trevor -- bash testsite/fixtures/gen.sh');
  }
  const child = spawn(serverExe, ['-root', testsiteDir, '-addr', '127.0.0.1:8787'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, MAGPIE_QUIET: '' },
    detached: false,
  });
  writeFileSync(PID_FILE, String(child.pid));
  await waitFor('http://127.0.0.1:8787/', 10_000);
}
