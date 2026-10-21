#!/usr/bin/env bash
# Probe downloaded files with ffprobe (run inside WSL):
#   wsl -u trevor -- bash e2e/probe.sh
cd "$(dirname "$0")/.."
wc -l testsite/public/media/ref/*.framemd5
for f in e2e/downloads/*; do
  echo "== $f"
  ffprobe -v error -show_entries stream=codec_name,width,height -show_entries format=duration,size -of compact=p=0 "$f"
done
