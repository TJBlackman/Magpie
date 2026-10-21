import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const extensionDir = join(root, 'extension', 'dist', 'chrome-mv3');
export const testsiteDir = join(root, 'testsite');
export const serverExe = join(testsiteDir, 'server', process.platform === 'win32' ? 'magpie-testsite.exe' : 'magpie-testsite');
export const downloadsDir = join(root, 'e2e', 'downloads');
export const refDir = join(testsiteDir, 'public', 'media', 'ref');
