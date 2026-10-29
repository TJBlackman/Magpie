#!/usr/bin/env bash
# Generates the media fixture matrix into testsite/public/media using ffmpeg.
# Source clip: testsrc2 with the frame number burned in, a 1 kHz beep each
# second, 20 s, keyframe every 2 s so segment boundaries are clean.
# Matrix (one directory each):
#   progressive       plain MP4
#   hls-ts            HLS, MPEG-TS segments, muxed audio
#   hls-fmp4          HLS master, 3 fMP4 renditions with muxed audio
#   hls-live-fmp4     the 720p fMP4 rendition with fragment times 2 hours in
#   hls-altaudio      HLS master, fMP4 video plus a separate fMP4 audio rendition
#   hls-altaudio-ts   HLS master, TS video plus a separate TS audio rendition
#   hls-aes           HLS TS, AES-128
#   hls-byterange     HLS TS, single file with EXT-X-BYTERANGE
#   dash              DASH, SegmentTemplate $Number$, 720p + 360p video, one audio
#   dash-timeline     DASH, SegmentTemplate with SegmentTimeline and $Time$
#   dash-single       DASH, one file per representation, SegmentBase with indexRange
#   ref               decoded frame hashes per rendition, encoded audio packet hashes
# Run from WSL: bash testsite/fixtures/gen.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../public/media"
rm -rf "$out"
mkdir -p "$out"
cd "$out"

DUR=${DUR:-20}
FPS=30
GOP=$((FPS * 2))
X264="-c:v libx264 -preset veryfast -pix_fmt yuv420p -g $GOP -keyint_min $GOP -sc_threshold 0 -bf 0"
AAC="-c:a aac -b:a 96k"

echo "== source renditions"
mkdir -p src
for r in 720:1280x720:2000k 480:854x480:1000k 360:640x360:500k; do
  IFS=: read -r name size rate <<<"$r"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "testsrc2=size=$size:rate=$FPS:duration=$DUR" \
    -f lavfi -i "sine=frequency=1000:beep_factor=4:sample_rate=48000:duration=$DUR" \
    -vf "drawtext=text='%{n} ${name}p':fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6:x=20:y=20" \
    $X264 -b:v "$rate" $AAC -movflags +faststart -shortest "src/$name.mp4"
done

echo "== 1 progressive"
mkdir -p progressive
cp src/720.mp4 progressive/clip.mp4

echo "== 2 hls-ts"
mkdir -p hls-ts
ffmpeg -hide_banner -loglevel error -y -i src/720.mp4 -c copy -f hls \
  -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_segment_filename hls-ts/seg%03d.ts hls-ts/index.m3u8

echo "== 3 hls-fmp4 (3 renditions, master playlist)"
mkdir -p hls-fmp4
ffmpeg -hide_banner -loglevel error -y -i src/720.mp4 -i src/480.mp4 -i src/360.mp4 \
  -map 0:v -map 0:a -map 1:v -map 1:a -map 2:v -map 2:a -c copy -f hls \
  -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 -hls_flags independent_segments \
  -var_stream_map "v:0,a:0,name:720p v:1,a:1,name:480p v:2,a:2,name:360p" \
  -master_pl_name master.m3u8 \
  -hls_segment_filename "hls-fmp4/%v/seg%03d.m4s" -hls_fmp4_init_filename init.mp4 \
  "hls-fmp4/%v/index.m3u8"

echo "== 3b hls-live-fmp4 (the 720p rendition with fragment times 2 hours in, like a long running live stream)"
rm -rf hls-live-fmp4
cp -r hls-fmp4/720p hls-live-fmp4
python3 "$here/shift_tfdt.py" hls-live-fmp4 7200

echo "== 4 hls-altaudio (video and audio in separate renditions)"
mkdir -p hls-altaudio
ffmpeg -hide_banner -loglevel error -y -i src/720.mp4 \
  -map 0:v -map 0:a -c copy -f hls \
  -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 -hls_flags independent_segments \
  -var_stream_map "a:0,agroup:aud,default:yes,name:audio v:0,agroup:aud,name:video" \
  -master_pl_name master.m3u8 \
  -hls_segment_filename "hls-altaudio/%v/seg%03d.m4s" -hls_fmp4_init_filename init.mp4 \
  "hls-altaudio/%v/index.m3u8"

echo "== 4b hls-altaudio-ts (TS video and a separate TS audio rendition)"
# ffmpeg 4.4 writes MPEG-TS for the audio rendition too, not packed ADTS:
# audio/seg000.ts starts with the 0x47 sync byte and probes as mpegts with one
# aac stream. Audio gets 6 segments (the last 0.021 s), video 5.
mkdir -p hls-altaudio-ts
ffmpeg -hide_banner -loglevel error -y -i src/720.mp4 \
  -map 0:v -map 0:a -c copy -f hls \
  -hls_time 4 -hls_playlist_type vod -hls_segment_type mpegts -hls_flags independent_segments \
  -var_stream_map "a:0,agroup:aud,default:yes,name:audio v:0,agroup:aud,name:video" \
  -master_pl_name master.m3u8 \
  -hls_segment_filename "hls-altaudio-ts/%v/seg%03d.ts" \
  "hls-altaudio-ts/%v/index.m3u8"

echo "== 5 hls-aes (AES-128)"
mkdir -p hls-aes
openssl rand 16 > hls-aes/enc.key
printf '%s\n%s\n%s\n' "/media/hls-aes/enc.key" "$out/hls-aes/enc.key" "$(openssl rand -hex 16)" > hls-aes/enc.keyinfo
ffmpeg -hide_banner -loglevel error -y -i src/720.mp4 -c copy -f hls \
  -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_key_info_file hls-aes/enc.keyinfo \
  -hls_segment_filename hls-aes/seg%03d.ts hls-aes/index.m3u8
rm hls-aes/enc.keyinfo

echo "== 6 hls-byterange (single file, EXT-X-BYTERANGE)"
mkdir -p hls-byterange
ffmpeg -hide_banner -loglevel error -y -i src/720.mp4 -c copy -f hls \
  -hls_time 4 -hls_playlist_type vod -hls_flags single_file+independent_segments \
  -hls_segment_filename hls-byterange/all.ts hls-byterange/index.m3u8

echo "== 7 dash"
mkdir -p dash
ffmpeg -hide_banner -loglevel error -y -i src/720.mp4 -i src/360.mp4 \
  -map 0:v -map 1:v -map 0:a -c copy -f dash \
  -seg_duration 4 -use_template 1 -use_timeline 0 -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -init_seg_name 'init-$RepresentationID$.m4s' -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' \
  dash/manifest.mpd

echo "== 7b dash-timeline (SegmentTimeline, \$Time\$ segment names)"
mkdir -p dash-timeline
ffmpeg -hide_banner -loglevel error -y -i src/720.mp4 -i src/360.mp4 \
  -map 0:v -map 1:v -map 0:a -c copy -f dash \
  -seg_duration 4 -use_template 1 -use_timeline 1 -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -init_seg_name 'init-$RepresentationID$.m4s' -media_seg_name 'chunk-$RepresentationID$-$Time$.m4s' \
  dash-timeline/manifest.mpd
# ffmpeg 4.4 names the first audio chunk after its start pts, which the AAC
# priming frame makes negative (chunk-2--1024.m4s), but lists it at t="0" in
# the timeline. Rename it so every URL the MPD describes exists.
for f in dash-timeline/chunk-*--*.m4s; do
  if [ -e "$f" ]; then mv "$f" "${f%%--*}-0.m4s"; fi
done

echo "== 7c dash-single (one file per representation, SegmentBase with indexRange)"
mkdir -p dash-single
ffmpeg -hide_banner -loglevel error -y -i src/720.mp4 -i src/360.mp4 \
  -map 0:v -map 1:v -map 0:a -c copy -f dash \
  -seg_duration 4 -use_template 0 -use_timeline 0 -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -single_file 1 -global_sidx 1 -single_file_name 'rep-$RepresentationID$.mp4' \
  dash-single/manifest.mpd
# ffmpeg 4.4 describes single files as a SegmentList of mediaRange entries and
# has no SegmentBase output. global_sidx gives each file the on demand layout
# (ftyp, moov, one sidx for all fragments, moof+mdat pairs), so rewrite every
# Representation to SegmentBase: Initialization covers ftyp+moov, indexRange
# the sidx.
python3 - dash-single <<'PY'
import os, re, struct, sys

d = sys.argv[1]
path = os.path.join(d, 'manifest.mpd')
mpd = open(path).read()

def segment_base(m):
    data = open(os.path.join(d, m.group(2)), 'rb').read()
    pos, moov, sidx = 0, None, None
    while pos + 8 <= len(data):
        size, kind = struct.unpack('>I4s', data[pos:pos + 8])
        if kind == b'moov':
            moov = pos + size - 1
        elif kind == b'sidx':
            sidx = (pos, pos + size - 1, struct.unpack('>I', data[pos + 16:pos + 20])[0])
        pos += size
    if moov is None or sidx is None:
        sys.exit(f'{m.group(2)}: no moov or no sidx')
    ind = m.group(1)
    return (f'{ind}<BaseURL>{m.group(2)}</BaseURL>\n'
            f'{ind}<SegmentBase timescale="{sidx[2]}" indexRange="{sidx[0]}-{sidx[1]}">\n'
            f'{ind}\t<Initialization range="0-{moov}" />\n'
            f'{ind}</SegmentBase>\n')

mpd, n = re.subn(r'([ \t]*)<BaseURL>([^<]+)</BaseURL>\n[ \t]*<SegmentList.*?</SegmentList>\n', segment_base, mpd, flags=re.S)
if n == 0 or 'SegmentList' in mpd:
    sys.exit('dash-single: SegmentList rewrite failed')
mpd = mpd.replace('urn:mpeg:dash:profile:isoff-live:2011', 'urn:mpeg:dash:profile:isoff-on-demand:2011')
open(path, 'w').write(mpd)
print(f'dash-single: {n} representations rewritten to SegmentBase')
PY

echo "== 8 ad (a 4 s clip the live-ads replay stitches in as an ad, TS and fMP4, stamped 60 s in like Twitch's)"
mkdir -p ad
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=$FPS:duration=4" \
  -f lavfi -i "sine=frequency=440:beep_factor=2:sample_rate=48000:duration=4" \
  -vf "drawtext=text='AD %{n}':fontsize=96:fontcolor=white:box=1:boxcolor=red@0.8:x=20:y=20" \
  $X264 -b:v 2000k $AAC -shortest ad/src.mp4
ffmpeg -hide_banner -loglevel error -y -i ad/src.mp4 -c copy -output_ts_offset 60 -f hls \
  -hls_time 4 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_segment_filename ad/ad%03d.ts ad/ts.m3u8
ffmpeg -hide_banner -loglevel error -y -i ad/src.mp4 -c copy -output_ts_offset 60 -f hls \
  -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 -hls_flags independent_segments \
  -hls_segment_filename ad/ad%03d.m4s -hls_fmp4_init_filename ad-init.mp4 ad/fmp4.m3u8

echo "== reference hashes (decoded frames) for the e2e checker"
mkdir -p ref
for name in 720 480 360; do
  ffmpeg -hide_banner -loglevel error -i "src/$name.mp4" -map 0:v -f framemd5 - | grep -v '^#' > "ref/$name.framemd5"
done

echo "== reference hashes (encoded audio packets)"
# Decoded audio cannot be compared across packagings: the AAC priming frame and
# the edit lists differ, so the e2e checker compares encoded packets instead.
# One hash per line: the sixth framemd5 field, the packet data hash. Not the
# last field: the first packet also carries skip samples side data, which
# framemd5 appends as ", S=1, size, hash".
ffmpeg -hide_banner -loglevel error -i src/720.mp4 -map 0:a -c copy -f framemd5 - | grep -v '^#' | cut -d, -f6 | tr -d ' ' > ref/audio.packets

echo "done -> $out"
find "$out" -type f | wc -l

echo "== reddit (originals a fake Reddit page links to: noisy PNGs so each is a few hundred KB, a GIF, a packaged MP4 with audio)"
mkdir -p reddit
for i in 1 2 3 4; do
  # Noise so the PNG stays large; the lut makes each file differ from the others.
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "nullsrc=size=400x400:rate=1,geq=random(1)*255:random(1)*255:random(1)*255,lutrgb=r=val*$i/4" -frames:v 1 -pix_fmt rgb24 "reddit/g$i.png"
done
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc=size=320x240:rate=5:duration=2" "reddit/anim.gif"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=0x2f6b3e:size=640x480:rate=1" -frames:v 1 "reddit/single.jpg"
cp src/720.mp4 reddit/m2-res_720p.mp4
cp src/360.mp4 reddit/m2-res_360p.mp4
