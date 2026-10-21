#!/usr/bin/env python3
"""Make an fMP4 HLS rendition look like a stream that has been live for a while.

Adds SECONDS to every tfdt (the fragment start times) in DIR/seg*.m4s, using
each track's timescale from DIR/init*.mp4, and turns sidx boxes into free boxes
the way live packagers leave them out. The init segment stays as is.

    python3 shift_tfdt.py DIR SECONDS
"""
import glob
import os
import struct
import sys


def boxes(data, start, end):
    pos = start
    while pos + 8 <= end:
        size, kind = struct.unpack_from('>I4s', data, pos)
        header = 8
        if size == 1:
            size = struct.unpack_from('>Q', data, pos + 8)[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            return
        yield kind.decode('latin1'), pos, pos + header, pos + size
        pos += size


def timescales(init):
    out = {}
    for kind, _, body, end in boxes(init, 0, len(init)):
        if kind != 'moov':
            continue
        for kind, _, tbody, tend in boxes(init, body, end):
            if kind != 'trak':
                continue
            track = scale = None
            for kind, _, b, e in boxes(init, tbody, tend):
                if kind == 'tkhd':
                    track = struct.unpack_from('>I', init, b + (20 if init[b] == 1 else 12))[0]
                if kind == 'mdia':
                    for kind, _, mb, _ in boxes(init, b, e):
                        if kind == 'mdhd':
                            scale = struct.unpack_from('>I', init, mb + (20 if init[mb] == 1 else 12))[0]
            out[track] = scale
    return out


def main(folder, seconds):
    init = open(glob.glob(os.path.join(folder, 'init*.mp4'))[0], 'rb').read()
    scales = timescales(init)
    for path in sorted(glob.glob(os.path.join(folder, 'seg*.m4s'))):
        data = bytearray(open(path, 'rb').read())
        for kind, pos, body, end in list(boxes(data, 0, len(data))):
            if kind == 'sidx':
                data[pos + 4:pos + 8] = b'free'
            if kind != 'moof':
                continue
            for kind, _, tbody, tend in boxes(data, body, end):
                if kind != 'traf':
                    continue
                track = None
                for kind, _, b, _ in boxes(data, tbody, tend):
                    if kind == 'tfhd':
                        track = struct.unpack_from('>I', data, b + 4)[0]
                    if kind == 'tfdt':
                        shift = int(seconds * scales[track])
                        if data[b] == 1:
                            struct.pack_into('>Q', data, b + 4, struct.unpack_from('>Q', data, b + 4)[0] + shift)
                        else:
                            struct.pack_into('>I', data, b + 4, struct.unpack_from('>I', data, b + 4)[0] + shift)
        open(path, 'wb').write(data)


if __name__ == '__main__':
    main(sys.argv[1], float(sys.argv[2]))
