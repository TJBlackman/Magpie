import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './paths';

const PID_FILE = join(root, 'e2e', '.server.pid');

export default async function globalTeardown() {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, 'utf8'));
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
  unlinkSync(PID_FILE);
}
