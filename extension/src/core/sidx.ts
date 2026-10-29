/**
 * Segment index (sidx, ISO 14496-12 8.16.3) parser for DASH SegmentBase
 * Representations: one MP4 file per Representation, with a sidx that lists the
 * byte range and duration of every fragment. The engine fetches the MPD's
 * indexRange and turns it into byte range segments with `segmentsFromSidx`.
 */
import { toPlaylist, type DashRepresentation } from './dash';
import type { HlsSegment, MediaPlaylist } from './hls';

export interface Sidx {
  timescale: number;
  earliestPresentationTime: number;
  /** File offsets and sizes in bytes; durations in `timescale` units. */
  entries: { offset: number; size: number; duration: number }[];
}

/**
 * Parses the first sidx box in `bytes`, which start at `sidxFileOffset` in the
 * file (the start of the MPD's indexRange). The first fragment starts at the
 * end of the sidx box plus first_offset. Supports version 0 and 1 and media
 * references only; a reference to another sidx (reference_type 1) throws.
 */
export function parseSidx(bytes: Uint8Array, sidxFileOffset: number): Sidx {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > bytes.length) break;
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = bytes.length - pos;
    }
    if (size < header) throw new Error('The segment index holds a malformed box.');
    if (type === 'sidx') return readSidx(view, pos, header, size, sidxFileOffset);
    pos += size;
  }
  throw new Error('The index range holds no sidx box.');
}

function readSidx(view: DataView, start: number, header: number, size: number, fileOffset: number): Sidx {
  const end = start + size;
  if (end > view.byteLength) throw new Error('The sidx box is cut off; the index range is shorter than the box.');
  let p = start + header;
  const version = view.getUint8(p);
  p += 4; // version and flags
  p += 4; // reference_ID
  const timescale = view.getUint32(p);
  p += 4;
  let earliestPresentationTime: number;
  let firstOffset: number;
  if (version === 0) {
    earliestPresentationTime = view.getUint32(p);
    firstOffset = view.getUint32(p + 4);
    p += 8;
  } else {
    earliestPresentationTime = Number(view.getBigUint64(p));
    firstOffset = Number(view.getBigUint64(p + 8));
    p += 16;
  }
  p += 2; // reserved
  const count = view.getUint16(p);
  p += 2;
  if (p + count * 12 > end) throw new Error('The sidx box lists more references than it holds.');
  if (!timescale) throw new Error('The sidx box has a timescale of 0.');

  const entries: Sidx['entries'] = [];
  let offset = fileOffset + end + firstOffset;
  for (let i = 0; i < count; i++, p += 12) {
    const word = view.getUint32(p);
    if (word >>> 31) throw new Error('The segment index points to another index (a hierarchical sidx), which Magpie does not support.');
    const refSize = word & 0x7fffffff;
    entries.push({ offset, size: refSize, duration: view.getUint32(p + 4) });
    offset += refSize;
  }
  return { timescale, earliestPresentationTime, entries };
}

/**
 * Byte range segments for a SegmentBase Representation, against its one file.
 * `sidxBytes` are the bytes of `rep.segmentBase.indexRange` and `sidxOffset`
 * their offset in the file. The init is Initialization@range, or everything
 * before the sidx when the MPD leaves it out (ftyp and moov come first in an
 * on demand file). Pure: the caller stores the result in `rep.media`.
 */
export function segmentsFromSidx(rep: DashRepresentation, sidxBytes: Uint8Array, sidxOffset: number): MediaPlaylist {
  const sb = rep.segmentBase;
  if (!sb) throw new Error(`Representation ${rep.id} has no SegmentBase.`);
  const sidx = parseSidx(sidxBytes, sidxOffset);
  const initRange = sb.initRange ?? (sidxOffset > 0 ? { offset: 0, length: sidxOffset } : undefined);
  if (!initRange) throw new Error('The MPD gives no Initialization range and the index starts the file, so the init segment cannot be found.');
  const map = { uri: sb.url, byteRange: initRange };
  let t = sidx.earliestPresentationTime / sidx.timescale - sb.presentationTimeOffset;
  const segments: HlsSegment[] = sidx.entries.map((e, i) => {
    const duration = e.duration / sidx.timescale;
    const seg: HlsSegment = {
      index: i,
      sequence: i + 1,
      uri: sb.url,
      duration,
      title: '',
      start: t,
      byteRange: { offset: e.offset, length: e.size },
      key: { method: 'NONE' },
      map,
      discontinuity: false,
    };
    t += duration;
    return seg;
  });
  return toPlaylist(segments, true);
}
