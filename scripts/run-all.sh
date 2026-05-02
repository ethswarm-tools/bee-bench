#!/usr/bin/env bash
# Run all three benchmark runners sequentially against the same Bee node.
#
# Order is rotated each invocation so the cold-start tax doesn't always hit
# the same runner. Override with BENCH_RUNNER_ORDER="go,rs,js" etc.
#
# Each runner is invoked from its own directory with the bench-spec.json at
# the repo root. Results land in results/.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Sanity: fixtures present? -----------------------------------------------
if [[ ! -f fixtures/1mb.bin ]]; then
  echo "fixtures/ is empty — running gen-fixtures.sh"
  bash scripts/gen-fixtures.sh
fi

# --- Pick runner order --------------------------------------------------------
DEFAULT_ORDERS=("go,rs,js" "rs,js,go" "js,go,rs")
if [[ -n "${BENCH_RUNNER_ORDER:-}" ]]; then
  ORDER="$BENCH_RUNNER_ORDER"
else
  # Rotate based on day-of-year so consecutive runs in the same day stay stable
  # but a session next week picks a different starting runner.
  doy=$(date +%j)
  idx=$((10#$doy % ${#DEFAULT_ORDERS[@]}))
  ORDER="${DEFAULT_ORDERS[$idx]}"
fi
echo "runner order: $ORDER"
echo

IFS=',' read -ra RUNNERS <<< "$ORDER"

# --- Pre-build / pre-install --------------------------------------------------
need_build_go=0
[[ ! -x runner-go/bench ]] && need_build_go=1
if (( need_build_go )); then
  echo "[build] runner-go"
  ( cd runner-go && go build -o bench . )
fi

need_build_rs=0
[[ ! -x runner-rs/target/release/bench ]] && need_build_rs=1
if (( need_build_rs )); then
  echo "[build] runner-rs"
  ( cd runner-rs && cargo build --release )
fi

need_install_js=0
[[ ! -d runner-js/node_modules ]] && need_install_js=1
if (( need_install_js )); then
  echo "[install] runner-js"
  ( cd runner-js && npm install --no-audit --no-fund --silent )
fi
# Make sure bee-js is built (its dist must exist for the runner to import it)
if [[ ! -d ../bee-js/dist/mjs ]]; then
  echo "[build] bee-js dist"
  ( cd ../bee-js && npm install --no-audit --no-fund --silent && npm run build:node )
fi

# --- Run each runner ----------------------------------------------------------
for r in "${RUNNERS[@]}"; do
  echo
  echo "================================================================"
  echo "  runner: $r"
  echo "================================================================"
  case "$r" in
    go) ( cd runner-go && ./bench ) ;;
    rs) ( cd runner-rs && ./target/release/bench ) ;;
    js) ( cd runner-js && node runner.mjs ) ;;
    *)  echo "unknown runner: $r"; exit 1 ;;
  esac
done

# --- Aggregate ----------------------------------------------------------------
echo
echo "================================================================"
echo "  aggregate"
echo "================================================================"
node scripts/aggregate.mjs
node scripts/export-csv.mjs

echo
echo "Done. See results/report.md, results/report.html, results/report.csv."
