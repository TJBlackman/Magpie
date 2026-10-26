/** Top level boxes looked at before giving up on a file that is not MP4. */
const MAX_BOXES = 1000;

interface Box {
  body: number;
  end: number;
}

/** The first `type` box between `start` and `end`, reading only box headers. */
async function findBox(blob: Blob, start: number, end: number, type: string): Promise<Box | undefined> {
  let pos = start;
  for (let i = 0; i < MAX_BOXES && pos + 8 <= end; i++) {
    const head = new DataView(await blob.slice(pos, Math.min(end, pos + 16)).arrayBuffer());
    const size32 = head.getUint32(0);
    const name = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let header = 8;
    let size = size32;
    if (size32 === 1) {
      if (head.byteLength < 16) return undefined;
      header = 16;
      size = head.getUint32(8) * 2 ** 32 + head.getUint32(12);
    } else if (size32 === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return undefined;
    if (name === type) return { body: pos + header, end: pos + size };
    pos += size;
  }
  return undefined;
}

/**
 * Length in seconds from an MP4's movie header (moov > mvhd), reading a few
 * small slices even when moov sits after gigabytes of mdat. Undefined for
 * WebM and other containers, fragmented files that leave the duration at 0 or
 * all ones, and anything malformed.
 */
export async function mp4Duration(blob: Blob): Promise<number | undefined> {
  try {
    const moov = await findBox(blob, 0, blob.size, 'moov');
    if (!moov) return undefined;
    const mvhd = await findBox(blob, moov.body, moov.end, 'mvhd');
    if (!mvhd) return undefined;
    const v = new DataView(await blob.slice(mvhd.body, Math.min(mvhd.end, mvhd.body + 32)).arrayBuffer());
    let timescale: number;
    let duration: number;
    if (v.getUint8(0) === 1) {
      timescale = v.getUint32(20);
      const hi = v.getUint32(24);
      const lo = v.getUint32(28);
      if (hi === 0xffffffff && lo === 0xffffffff) return undefined;
      duration = hi * 2 ** 32 + lo;
    } else {
      timescale = v.getUint32(12);
      duration = v.getUint32(16);
      if (duration === 0xffffffff) return undefined;
    }
    return timescale && duration ? duration / timescale : undefined;
  } catch {
    return undefined;
  }
}
