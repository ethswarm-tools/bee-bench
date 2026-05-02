#!/usr/bin/env bash
# Generate random fixtures for the benchmark suite.
# Bytes don't need to be deterministic — content-addressing means each fresh
# fixture set produces different references; the bench salts per-iter anyway.
# Sizes match bench-spec.json sizes_mb + large_size_mb.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fixtures"
mkdir -p "$DIR"

gen() {
  local mb="$1"
  local out="$DIR/${mb}mb.bin"
  if [[ -f "$out" && $(stat -c%s "$out") -eq $((mb * 1024 * 1024)) ]]; then
    echo "ok ${mb}mb (cached)"
    return
  fi
  echo "gen ${mb}mb -> $out"
  dd if=/dev/urandom of="$out" bs=1M count="$mb" status=none
}

for mb in 1 10 100; do
  gen "$mb"
done

if [[ "${BENCH_LARGE:-0}" == "1" ]]; then
  gen 1024
else
  echo "skip 1024mb (set BENCH_LARGE=1 to generate)"
fi

ls -lh "$DIR"
