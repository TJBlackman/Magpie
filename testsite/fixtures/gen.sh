#!/usr/bin/env bash
# Generates the media fixture matrix into testsite/public/media using ffmpeg.
# Source clip: testsrc2 with the frame number burned in, a 1 kHz beep each
# second, 20 s, keyframe every 2 s so segment boundaries are clean.
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

echo "== reference hashes (decoded frames) for the e2e checker"
mkdir -p ref
for name in 720 480 360; do
  ffmpeg -hide_banner -loglevel error -i "src/$name.mp4" -map 0:v -f framemd5 - | grep -v '^#' > "ref/$name.framemd5"
done

echo "done -> $out"
find "$out" -type f | wc -l
