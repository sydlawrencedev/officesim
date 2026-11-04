#!/usr/bin/env bash
# Checks the levels the audio capture works out: that silence is silence, that a note moves the
# right bands, and that a beat lands and eases away.
#
#   scripts/test-audio.sh
set -euo pipefail

cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

swiftc -O -o "$out/audio-test" src-tauri/sources/audio-capture-test.swift
"$out/audio-test"
