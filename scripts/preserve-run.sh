#!/usr/bin/env bash
# Snapshot the current results/ contents into results/_<label>/ so subsequent
# runs don't overwrite them.
#
# Usage:
#   ./scripts/preserve-run.sh <label>
#
# Creates results/_<label>/ containing the latest go-/rs-/js-*.json plus the
# current aggregate.json + report.md + report.html. Skips _archive and other
# _-prefixed snapshots.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <label>" >&2
  exit 1
fi

LABEL="$1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/results"
DST="$SRC/_$LABEL"

if [[ ! -d "$SRC" ]]; then
  echo "no results/ directory at $SRC" >&2
  exit 1
fi

if [[ -e "$DST" ]]; then
  echo "destination already exists: $DST" >&2
  exit 1
fi

mkdir -p "$DST"

# Copy the latest result file per runner (by mtime) plus the aggregate/report trio.
for prefix in go rs js; do
  latest=$(ls -t "$SRC"/${prefix}-*.json 2>/dev/null | head -n 1 || true)
  if [[ -n "$latest" ]]; then
    cp "$latest" "$DST/"
    echo "preserved $(basename "$latest")"
  fi
done
for f in aggregate.json report.md report.html; do
  if [[ -f "$SRC/$f" ]]; then
    cp "$SRC/$f" "$DST/"
    echo "preserved $f"
  fi
done

echo
echo "snapshot saved to $DST"
