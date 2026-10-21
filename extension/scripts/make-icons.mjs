// Generates simple PNG icons without any dependency: a dark rounded square
// with a cyan "shiny" dot. Writes public/icon/{16,32,48,128}.png.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icon');
mkdirSync(outDir, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function pixel(x, y, s) {
  const r = s * 0.22;
  const cx = x + 0.5, cy = y + 0.5;
  const inRounded = (() => {
    const dx = Math.max(r - cx, 0, cx - (s - r));
    const dy = Math.max(r - cy, 0, cy - (s - r));
    return dx * dx + dy * dy <= r * r;
  })();
  if (!inRounded) return [0, 0, 0, 0];
  const dotX = s * 0.62, dotY = s * 0.38, dotR = s * 0.17;
  const d = Math.hypot(cx - dotX, cy - dotY);
  if (d <= dotR) return [34, 211, 238, 255];
  const beakOk = cy > s * 0.55 && cx > s * 0.25 && cx < s * 0.75 && Math.abs(cx - s * 0.5) < (cy - s * 0.55) * 0.9;
  if (beakOk) return [226, 232, 240, 255];
  return [24, 24, 27, 255];
}
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `${size}.png`), png(size, pixel));
}
console.log('icons written to', outDir);
