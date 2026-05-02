# bee-bench

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Cross-client benchmark suite for the three Swarm Bee API clients living as siblings:

- `bee-js/` — `@ethersphere/bee-js` v12.1.0
- `bee-go/` — `github.com/ethswarm-tools/bee-go` v1.1.0
- `bee-rs/` — `bee-rs` v1.1.0

All three runners hit the same local Bee node, run the same case set defined in `bench-spec.json`, and emit JSON results that the aggregator turns into a markdown report and an interactive HTML chart page.

**Where to read the results:**
- **[Live HTML report](https://ethswarm-tools.github.io/bee-bench/results/report.html)** — interactive Chart.js view, served from GitHub Pages (no clone needed)
- [`results/INDEX.md`](results/INDEX.md) — landing page, links into everything else
- [`results/report.md`](results/report.md) — auto-generated numerical report
- [`results/report.html`](results/report.html) — same data, interactive (raw source)
- [`results/report.csv`](results/report.csv) — flat per-row CSV (one row per case × param × runner) for spreadsheet / pandas analysis
- [`FINDINGS.md`](FINDINGS.md) — qualitative observations (F1–F21)

> ## ⚠ MB/s numbers are NOT Swarm-network throughput
>
> Every byte/sec figure produced by this bench is **client ↔ local Bee node** over loopback HTTP, NOT real Swarm-network throughput. Uploads are buffered to local Bee under deferred-upload mode (chunks pushed to peers asynchronously after the call returns); downloads of just-uploaded references hit the local Bee cache. See [FINDINGS § measurement scope](FINDINGS.md#-measurement-scope-caveat-read-first) for how to re-run with `deferred: false` for real-network numbers.

## Prereqs

- Bee node reachable at `BEE_URL` (default `http://localhost:1633`).
- A usable postage batch — find one with `curl -s $BEE_URL/stamps | jq '.stamps[] | select(.usable == true) | .batchID'`.
- Go 1.25+, Rust (stable), Node 18+.

## Quick start

```bash
# 1. fixtures (1MB / 10MB / 100MB; add 1GB with BENCH_LARGE=1)
./scripts/gen-fixtures.sh

# 2. point at a usable batch
export BEE_BATCH_ID=<hex>
export BEE_URL=http://localhost:1633

# 3. run all three (sequential; rotating order)
./scripts/run-all.sh

# Optional: snapshot before another run
./scripts/preserve-run.sh <label>          # → results/_<label>/

# 4. aggregate (run-all.sh calls this at the end automatically)
node scripts/aggregate.mjs
open results/report.html                    # or read results/report.md
```

### Docker

Self-contained image that builds all three runners against the upstream client repos — no host toolchain required.

```bash
# CPU-only (no Bee node needed; net.* cases skip cleanly)
docker build -t bee-bench .
docker run --rm -v "$PWD/out:/workspace/bee-bench/results" bee-bench

# Full suite, against a Bee node on the host
docker run --rm --network=host \
  -e BEE_URL=http://localhost:1633 \
  -e BEE_BATCH_ID=<hex> \
  -v "$PWD/out:/workspace/bee-bench/results" \
  bee-bench
```

Pin upstream versions with `--build-arg`:

```bash
docker build \
  --build-arg BEE_GO_REF=v1.1.0 \
  --build-arg BEE_RS_REF=v1.1.0 \
  --build-arg BEE_JS_REF=v12.1.0 \
  -t bee-bench .
```

A `.devcontainer/devcontainer.json` is also included, so VS Code Remote / GitHub Codespaces will spin up a ready-to-go environment with the toolchain and editor extensions pre-configured.

### CI

Two workflows in `.github/workflows/`:

- **`validate.yml`** runs on every PR + main: JSON / script-syntax / shellcheck / hadolint, plus an end-to-end aggregate-pipeline test against a synthetic 3-runner fixture. Fast (~1 min).
- **`bench-cpu.yml`** runs on every PR + main + manual dispatch: checks out `bee-go` / `bee-rs` / `bee-js` as siblings, builds all three runners, runs the CPU subset (all `cpu.*` cases; `net.*` cases skip without `BEE_BATCH_ID`), uploads `report.md` / `report.html` / `report.csv` / `aggregate.json` plus the per-runner JSONs as a 14-day artifact. Slower (~5–10 min cold; ~3 min warm with cargo / npm / go-mod cache).

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `BEE_URL` | `http://localhost:1633` | Bee node base URL |
| `BEE_BATCH_ID` | (required) | hex of usable postage batch |
| `BENCH_LARGE` | `0` | Set to `1` to enable 1GB cases |
| `BENCH_ITERS` | `5` | Override iteration count |
| `BENCH_RUNNER_ORDER` | rotates daily | Override, e.g. `go,rs,js` |

## Layout

```
bench-spec.json          cases, sizes, iters, runner_subset
fixtures/                generated random bins (gitignored)
results/                 per-runner JSON output (gitignored)
  _<label>/              snapshots from preserve-run.sh
  _baseline_*/           preserved canonical runs
  _archive/              superseded partial runs
runner-go/               cmd-style Go runner; replace ../bee-go
runner-rs/               cargo bin; path = "../bee-rs"
runner-js/               Node runner; file:../bee-js
  keccak-worker.mjs      Worker thread for cpu.keccak.parallel
scripts/
  gen-fixtures.sh        random binaries for sizes_mb + 1GB
  run-all.sh             rotates runner order, runs all, aggregates
  aggregate.mjs          results/*.json → report.md + report.html
  export-csv.mjs         aggregate.json → flat report.csv
  validate-spec.mjs      check each runner's latest JSON covers the spec
  compare.mjs            diff two aggregate.json files
  preserve-run.sh        snapshot results/ to results/_<label>/
FINDINGS.md              qualitative observations
```

## Cases

See `bench-spec.json` for the authoritative list. Each runner reads it at startup and dispatches by `id`. Cases are grouped by domain in the report:

- **CPU** — `cpu.keccak.*`, `cpu.bmt.*`, `cpu.ecdsa.sign-1000`, `cpu.identity.create`, `cpu.manifest.hash-50files`. Pure client work, no Bee involvement.
- **Calibration** — `net.stamps.list`, `net.stamps.concurrent`. Control + HTTP-stack overhead.
- **Feeds** — `net.feed.write-read.fresh`, `.warm`. Bee `/feeds` endpoint cost (Sepolia-bound, slow).
- **Network upload** — `net.bzz.upload`, `.upload.encrypted`, `net.bytes.upload`. POST paths.
- **Network upload (streaming from disk)** — `net.bzz.upload-from-disk`. **bee-rs N/A** (no AsyncRead path; documented in FINDINGS).
- **Network download** — `net.bzz.download`, `net.bytes.head`, `net.bytes.download.range`. ⚠ Local-cache hit when the bench just uploaded; not a real-network metric.
- **Bee chunk-pipeline** — `net.chunks.upload`, `net.stream-dir.upload`, `net.soc.upload`. ⚠ Sepolia-bottlenecked, not a client comparison.

### Adding a new case

A case is the same code shape across three runners + one entry in `bench-spec.json`. Concretely:

1. **`bench-spec.json`** — append an object to `cases`:
   ```json
   {
     "id": "net.bytes.upload",
     "kind": "net",
     "params_from": "sizes_mb",
     "doc": "POST /bytes for each size_mb. Server-side default deferred upload."
   }
   ```
   `kind` is `cpu` or `net`. Use `params: [...]` for an explicit list, or `params_from: "sizes_mb"` / `"sizes_mb_plus_large"` to inherit the global size sweep. The `doc` string is rendered under the case heading in the report — keep it one line, name the endpoint or the operation.

2. **`runner-go/cases.go`** — add a function `func runMyCase(ctx ..., param Param) (CaseResult, error)`, register it in `cases.go:Dispatch` by `id`. Use the existing helpers (`measureIters`, `withRSS`, `randomBytes`).

3. **`runner-rs/src/cases.rs`** — same shape: add an async `pub async fn run_my_case(...) -> Result<CaseResult>` and dispatch by id.

4. **`runner-js/runner.mjs`** — add a case in the dispatch switch; the helpers are inline at the top of the file.

5. **Run all three.** Each runner reads `bench-spec.json`, hashes it, and embeds the hash in the result JSON so downstream consumers can detect spec drift between runners.

If a runner can't implement the case (e.g. `net.bzz.upload-from-disk` on bee-rs which lacks an AsyncRead path), return `CaseResult{ skipped: true, skip_reason: "..." }`. The aggregator renders skipped cells as `*skip:* <reason>` and excludes them from the runner's geomean.

The compare script (`scripts/compare.mjs`) cross-checks two `aggregate.json` files for missing cases — useful when adding a case to confirm all runners actually emit it.

### Default-mode caveat

All cases use Bee's server-side default `Swarm-Deferred-Upload: true`. Upload returns when chunks land in **local Bee**, not when network-replicated. Downloads of just-uploaded refs hit local cache. To re-run with `deferred: false` on each client and compare, see `compare.mjs` below.

## Reading the report

`results/report.md` (or `report.html`) is structured:

1. **Runners** table — versions and host info per runner.
2. **Scoreboard** — geometric mean of `median_ms / fastest_in_row` per runner. `1.00x` = fastest, higher = slower. Wins column = rows where the runner had the lowest median. Per-group columns (CPU, Network upload, etc.) help separate where each client wins/loses.
3. **Per-domain sections** — each case gets its own table. Each cell shows:
   - Line 1: median (or **best**) + ratio to fastest, e.g. `**516.6ms** (best)` or `590.7ms (1.14x)`
   - Line 2: throughput · per-unit metric, e.g. `66.1 MB/s · 59µs/call`
   - Line 3: variance (`±X%`, `cv X%`, `p95` when n ≥ 10), peak RSS, and CPU/wall ratio (`cpu Xms (Y.YYx)`). The CPU/wall ratio distinguishes:
     - `~ 1.00x` → single-thread CPU-bound (e.g. keccak hashing)
     - `< 1.00x` → wait-bound, mostly blocked on I/O (e.g. `/chunks` upload waiting on Bee sync)
     - `> 1.00x` → multi-threaded; ~N for N cores active (e.g. `cpu.keccak.parallel`)
     `⚠` flag prepended on `±X%` when variance > 50% (flaky measurement).
   - Line 4: per-iter sparkline — reveals JIT warmup, GC pauses, network jitter
4. **Latency-vs-size linear fit** — for cases with multiple sizes (`cpu.bmt.file-root`, `net.bzz.upload`, etc.), a regression `time ≈ fixed_overhead + bytes / throughput` showing per-runner per-call overhead and peak throughput.
5. **Inline SVG bars** in each row — visual ranking, fastest is green.

## Comparing runs

```bash
# Snapshot a run
./scripts/preserve-run.sh deferred_true

# ...do another run with different parameters...
./scripts/preserve-run.sh deferred_false

# Diff
node scripts/compare.mjs \
  results/_deferred_true/aggregate.json \
  results/_deferred_false/aggregate.json \
  --out results/compare.md
```

The compare report shows a per-runner geomean shift (e.g. `↓ 12.3% faster`), and per-row delta columns flagging anything `> ±20%` with `⚠`.

## Discipline

- Sequential everywhere. One runner at a time, one case at a time, one iteration at a time. Concurrent cases (`net.stamps.concurrent`, `cpu.keccak.parallel`) deliberately fan out to test concurrency, but only one such case is in flight at a time.
- Fixtures pre-loaded into RAM before timing; salt prefix per iter so each upload produces a unique reference (no Bee dedup warm-cache effect).
- Body drains for downloads — never buffer the full response.
- Peak RSS sampled in-process at 100ms intervals.

## Findings

Qualitative observations live in `FINDINGS.md`. Highlights:

- bee-js ECDSA is **221x slower** than bee-go on `cpu.ecdsa.sign-1000` (16ms vs 73µs per sign). bee-rs is 1.6x slower than bee-go because k256 ships no asm.
- bee-js BMT chunker plateaus at ~5.9 MB/s regardless of size — pure-JS keccak floor. bee-go ~60 MB/s, bee-rs ~77 MB/s.
- bee-js holds ~14x its input as RSS during chunking (1.4GB at 100MB BMT) — V8 + MerkleTree heap behavior.
- bee-rs has no streaming raw-bytes upload (`upload_file` / `upload_data` buffer fully). `net.bzz.upload-from-disk` is the data point.
- Sepolia `/chunks` and `/feeds` endpoints are **dominated by network sync** (~600ms/chunk, 30-60s for fresh feed lookup). Those rows are flagged as Bee-bottlenecked, not client comparisons.
