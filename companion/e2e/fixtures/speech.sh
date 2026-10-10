#!/bin/sh
# Builds speech.wav, the fake microphone's input for the voice tests:
# 0.5 s silence, then "This pricing table is too dense.", as 48 kHz mono 16-bit PCM.
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say -o "$tmp/u.aiff" "This pricing table is too dense."
ffmpeg -loglevel error -y -f lavfi -i "anullsrc=r=48000:cl=mono" -t 0.5 -c:a pcm_s16le "$tmp/s.wav"
ffmpeg -loglevel error -y -i "$tmp/u.aiff" -ar 48000 -ac 1 -c:a pcm_s16le "$tmp/u.wav"
ffmpeg -loglevel error -y -i "$tmp/s.wav" -i "$tmp/u.wav" \
  -filter_complex "[0][1]concat=n=2:v=0:a=1[out]" -map "[out]" -ar 48000 -ac 1 -c:a pcm_s16le speech.wav
