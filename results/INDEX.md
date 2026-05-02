# bee-bench — results landing page

Cross-client benchmark of three Swarm Bee API clients: **bee-go**, **bee-rs**, **bee-js**.

> ## ⚠ MB/s numbers are NOT Swarm-network throughput
>
> Every byte/sec figure produced by this bench is **client ↔ local Bee node** over loopback HTTP, NOT real Swarm-network throughput.
> - **Uploads** measure how fast the client pushes data into the local Bee node's store under deferred-upload mode (`Swarm-Deferred-Upload: true`, the Bee server-side default). The chunks are still being pushed to the Swarm network in the background after the call returns.
> - **Downloads** of references uploaded earlier in the same run hit the local Bee cache. Numbers like "253 MB/s" are local-store reads, not network fetches.
>
> See [FINDINGS § measurement scope](../FINDINGS.md#-measurement-scope-caveat-read-first) for how to re-run with `deferred: false` for real-network numbers.

## Where to look

| Doc | What's inside |
|---|---|
| **[Latest report (markdown)](report.md)** | Auto-generated per-case tables, scoreboard, sparklines, latency-vs-size linear fits. The numerical truth. |
| **[Latest report (HTML)](report.html)** | Same data, interactive Chart.js bars/lines. Open in a browser. |
| **[FINDINGS](../FINDINGS.md)** | Hand-written qualitative observations (F1–F21) — what the numbers actually mean, where the gaps come from, what to investigate. |
| **[README](../README.md)** | How to run the bench, env vars, layout. |
| **[bench-spec.json](../bench-spec.json)** | Source of truth for cases, sizes, iter counts. |
| **[aggregate.json](aggregate.json)** | Machine-readable form of `report.md`. Diff two snapshots with `scripts/compare.mjs`. |

## Quick highlights

From the latest run (see [report.md § Scoreboard](report.md#scoreboard) for the full table):

| Runner | Wins | Overall ratio | CPU | HTTP-stack (Calibration + Pin) |
|---|---|---|---|---|
| **bee-rs** | **24** | **1.11x** | 1.26x | **1.00x** |
| bee-go | 10 | 1.32x | **1.15x** | 6.04x (Calibration), 2.35x (Pin) |
| bee-js | 0 | 4.48x | 30.9x | 14.5x (Calibration), 2.58x (Pin) |

- bee-rs leads on every group except CPU (where bee-go's secp256k1 asm wins by a small margin)
- bee-js is **947x slower** than bee-go on ECDSA verify ([F15](../FINDINGS.md#f15-ecdsa-verify-is-even-worse-than-sign-in-bee-js--947x-vs-219x))
- bee-go is unexpectedly **2.93x slower** on stream-dir uploads ([F19](../FINDINGS.md#f19-bee-go-is-unexpectedly-slow-on-stream-dir-upload-293x))
- HTTP-stack pattern: reqwest pools connections better than Go's `http.DefaultClient` and far better than axios's keepAlive=false default ([F18](../FINDINGS.md#f18-pin-endpoint-round-trips-bee-rs--24x-faster-than-bee-go-and-bee-js))

## Findings index

Direct links to each finding in `../FINDINGS.md`:

**Crypto / CPU:**
- [F2 — ECDSA backends are not equivalent](../FINDINGS.md#f2-ecdsa-backends-are-not-equivalent)
- [F3 — eth-envelope ECDSA scheme is identical across clients](../FINDINGS.md#f3-all-three-implement-the-same-eth-envelope-ecdsa-scheme)
- [F6 — bee-js keccak chunker plateau](../FINDINGS.md#f6-bee-js-keccak-chunker-plateaus)
- [F8 — bee-rs fastest on CPU except ECDSA](../FINDINGS.md#f8-bee-rs-is-consistently-fastest-on-cpu-work-except-ecdsa)
- [F15 — ECDSA verify in bee-js is 947x slower](../FINDINGS.md#f15-ecdsa-verify-in-bee-js-is-947x-slower-worse-than-the-sign-gap-of-219x)
- [F16 — Mantaray lookup is essentially tied between bee-go and bee-rs](../FINDINGS.md#f16-mantaray-lookup-is-essentially-tied-between-bee-go-and-bee-rs)
- [F17 — cpu.identity.create is another secp256k1 backend revealer](../FINDINGS.md#f17-cpuidentitycreate-is-another-secp256k1-backend-revealer)

**HTTP / network:**
- [F10 — Bee node dominates upload wall clock](../FINDINGS.md#f10-bee-node-not-the-client-dominates-upload-wall-clock) ⚠ not Swarm-network speed
- [F11 — Download is bandwidth-bound, ranking flips](../FINDINGS.md#f11-download-is-bandwidth-bound-ranking-flips) ⚠ local-cache hit
- [F12 — /chunks endpoint is the wallclock killer on Sepolia](../FINDINGS.md#f12-chunks-endpoint-is-the-wallclock-killer-on-sepolia)
- [F18 — Pin endpoint round-trips are 2.4x faster on bee-rs](../FINDINGS.md#f18-pin-endpoint-round-trips-are-24x-faster-on-bee-rs)
- [F20 — Tag bookkeeping is cheap on all three](../FINDINGS.md#f20-tag-bookkeeping-is-cheap-on-all-three)
- [F21 — Updated scoreboard summary](../FINDINGS.md#f21-updated-scoreboard-bee-rs-wins-decisively-overall)

**Client-API gaps:**
- [F1 — bee-rs has no streaming raw-bytes upload](../FINDINGS.md#f1-bee-rs-has-no-streaming-raw-bytes-upload)
- [F7 — bee-js holds significantly more memory during chunking](../FINDINGS.md#f7-bee-js-holds-significantly-more-memory-during-chunking)
- [F9 — encryption-aware offline chunking missing in all three](../FINDINGS.md#f9-encryption-aware-offline-chunking-is-missing-in-all-three-clients)
- [F13 / F13b — SOC writes: bee-go ~70% slower than bee-rs](../FINDINGS.md#f13b-soc-writes-update-on-the-2026-05-02-unified-sweep)
- [F14 — feed read fails 404 in same iter](../FINDINGS.md#f14-feed-read-fails-with-404-in-same-iter-as-the-write)
- [F19 — bee-go is unexpectedly slow on stream-dir upload](../FINDINGS.md#f19-bee-go-is-unexpectedly-slow-on-stream-dir-upload)

## Snapshots

Snapshots of earlier runs are preserved locally by `./scripts/preserve-run.sh <label>` into `results/<label>/`. They contain their own `aggregate.json` / `report.md` / `report.html` plus the raw per-runner JSONs. They are **not pushed to the remote** — the per-runner JSONs are large and the canonical view here is the latest aggregate. To see a snapshot, regenerate it locally with `./scripts/run-all.sh` + `node scripts/aggregate.mjs`.

## Comparing two snapshots

Once you have two `aggregate.json` files locally:

```bash
node scripts/compare.mjs \
  results/<old-snapshot>/aggregate.json \
  results/<new-snapshot>/aggregate.json \
  --out results/compare.md
```

Compare report shows per-runner geomean shift and per-row deltas, flagging anything `> ±20%` with `⚠`.
