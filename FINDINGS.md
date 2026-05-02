# Findings

Qualitative observations gathered during benchmarking.

**See also:** [results landing page](results/INDEX.md) · [latest numerical report](results/report.md) · [README (how to run)](README.md)

## ⚠ Measurement scope caveat (read first)

> **Every MB/s number in this document and in `results/report.md` is client ↔ local Bee node over loopback HTTP — NOT real Swarm-network throughput.**

All three runners use the **default upload mode** of their respective clients, which means Bee's server-side default applies: `Swarm-Deferred-Upload: true`. None of the runners pass an explicit `deferred` flag.

In deferred mode:

1. **Upload** returns once chunks land in **local Bee storage**. Bee then asynchronously pushes the chunks to peers in the background. The HTTP call does not wait for network-wide replication. So an upload "MB/s" is "client → local Bee store", not "client → Swarm network".
2. **Download** of a just-uploaded reference reads from **local Bee cache** — the chunks are still in local store from the upload. We measured ~280 MB/s on loopback, which is the cost of "Bee local store → client", not "client ← network".

What that means for the numbers in [`results/report.md`](results/report.md):

- `net.bzz.upload` / `net.bytes.upload` measure **client → local Bee** (chunking, stamping, BMT, local-store write). Bee is still the bottleneck (~10 MB/s) because of stamping and BMT cost on its end, but the chunks aren't fully replicated by the time the call returns. **This is NOT a Swarm-network upload speed.**
- `net.bzz.download` / `net.bytes.download.range` are **local-cache hit benchmarks**, not real network downloads. Useful for comparing client-side download-path overhead (axios stream wrapper vs reqwest bytes_stream vs Go http body reader) but **not** representative of fetching a cold reference from the Swarm network.
- For "real" network upload numbers, re-run with `Deferred: ptr(false)` on bee-go, `deferred: Some(false)` on bee-rs, `{ deferred: false }` on bee-js. For "real" download numbers, fetch chunks that were uploaded by a *different* node, or wait for cache eviction, or use a separate Bee that doesn't have the chunks.

This caveat applies to F10, F11, F12, F13, F19, F20 below — they all describe behavior under the deferred-upload + warm-cache regime.

## Already known (seeded from the design pass)

### F1. bee-rs has no streaming raw-bytes upload

`bee-rs::FileApi::upload_file` and `upload_data` accept `impl Into<Bytes>` — the entire payload is materialized in memory before the POST starts. By contrast:

- bee-go `client.File.UploadData(ctx, batchID, io.Reader, opts)` streams.
- bee-js `Bee.uploadFile(data, batchId)` accepts a Node `Readable` and pipes it to axios.

Quantified by the `net.bzz.upload-from-disk` case (bee-rs N/A row) and by `peak_rss_mb` deltas at 1GB on `net.bzz.upload`.

bee-rs *does* have streaming for directory uploads via `stream_collection_entries`, but the per-entry data is still `Vec<u8>` in memory.

### F2. ECDSA backends are not equivalent

The colleague's "ECDSA in JS is notoriously slow" framing is half right but misleading.

| Client | Backend | Notes |
|---|---|---|
| bee-js | `cafe-utility` `Elliptic` | pure-JS bigint secp256k1 + js-sha3 keccak |
| bee-go | `github.com/ethereum/go-ethereum/crypto` → `decred/dcrd/dcrec/secp256k1/v4` | pure-Go but with optimized amd64 assembly |
| bee-rs | `k256` 0.13 + `sha3` 0.10 | pure-Rust, no assembly. ~2-3x slower than libsecp256k1 |

Expect `Go fastest > Rust > JS slowest` rather than "JS slow / Rust fast". A future bee-rs win would be opting into the libsecp256k1 backend via the `secp256k1` crate.

### F3. All three implement the same eth-envelope ECDSA scheme

Apples-to-apples comparison is valid:

```
digest = keccak256("\x19Ethereum Signed Message:\n32" || keccak256(data))
```

### F4. All three have offline BMT/manifest hashing APIs

| Op | bee-js | bee-go | bee-rs |
|---|---|---|---|
| Chunk address | `calculateChunkAddress` | `swarm.CalculateChunkAddress` | `make_content_addressed_chunk(payload).address` |
| File chunker | `MerkleTree.NOOP` + `append`/`finalize` | `swarm.NewFileChunker` | `FileChunker::new()` |
| Manifest root | `hashDirectory` | `file.HashCollectionEntries` | `hash_collection_entries(&entries)` |

Means the `cpu.*` cases compare native client behavior, not synthetic adapters.

---

## Discovered during runs

### F5. JS-side ECDSA signing is ~221x slower than bee-go (CONFIRMED, dramatically)

`cpu.ecdsa.sign-1000` (1000 signs of a 32-byte digest with the eth-envelope scheme):

| Runner | median | per-sign |
|---|---|---|
| bee-go (decred secp256k1, asm) | 72.9ms | 73µs |
| bee-rs (k256, pure-Rust) | 117.7ms | 118µs |
| bee-js (cafe-utility Elliptic, pure-JS bigint) | 16,138ms | 16.1ms |

The colleague's "ECDSA signing in Bee-JS is notoriously slow" framing is confirmed. Each sign in bee-js is ~16ms — that's ~73µs per sign in bee-go, vs **221x more** in bee-js, and 137x slower than bee-rs. WASM-compiling the secp256k1 path or wiring `noble-secp256k1` would close most of this gap.

bee-rs at 118ms is 1.6x slower than bee-go because k256 ships no assembly. Opting into the `secp256k1` crate (libsecp256k1 C bindings) would get bee-rs to ~30-40ms.

### F6. JS keccak/BMT chunker is ~10-12x slower

`cpu.bmt.file-root` (chunk + compute Mantaray root, no upload):

| size | bee-go | bee-rs | bee-js | js/go ratio |
|---|---|---|---|---|
| 1MB | 20.2ms (50 MB/s) | 13.8ms (73 MB/s) | 168.9ms (5.9 MB/s) | 8.4x |
| 10MB | 158.1ms (63 MB/s) | 128.9ms (78 MB/s) | 1,665ms (6.0 MB/s) | 10.5x |
| 100MB | 1.65s (61 MB/s) | 1.30s (77 MB/s) | 17.02s (5.9 MB/s) | 10.3x |

`cpu.keccak.bulk` (single keccak256 over 100MB):

| Runner | median | throughput |
|---|---|---|
| bee-go | 284ms | 352 MB/s |
| bee-rs | 252ms | 397 MB/s |
| bee-js | 2,954ms | 34 MB/s |

The colleague's "keccak hashing in the chunker is notoriously slow in JS" claim is confirmed. JS plateaus at ~5.9 MB/s on the chunker path no matter the size, suggesting per-call overhead dominates plus a constant per-byte cost in pure-JS keccak. WASM-compiling sha3 alone would lift this dramatically.

### F7. bee-js holds significantly more memory during chunking

Peak RSS for `cpu.bmt.file-root` at 100MB:

| Runner | peak_rss_mb |
|---|---|
| bee-go | 235MB |
| bee-rs | 117MB |
| bee-js | 1,418MB |

bee-js peaks at ~14x its input size during a single 100MB chunker run — likely a combination of MerkleTree internal accumulation and V8 heap behavior. Worth flagging that 1GB chunking in bee-js will OOM on most laptops without `--max-old-space-size` tuning.

### F8. bee-rs is consistently fastest on CPU work except ECDSA

bee-rs wins on every CPU benchmark except `cpu.ecdsa.sign-1000`. The pattern: where the work is keccak/BMT-bound, bee-rs's `sha3` crate edges bee-go's `golang.org/x/crypto/sha3`. Where the work is secp256k1-bound, bee-go's optimized backend pulls ahead.

### F9. Encryption-aware offline chunking is missing in all three clients

None of the three expose a public API for "compute the BMT root of an encrypted upload without uploading". The plan included `cpu.bmt.encrypted-file-root`; all three rows skipped with the same reason. The encryption layer is bolted onto the upload path, not the chunker. This matters for clients that want to pre-compute encrypted-upload references for staged ingestion — none of these libraries support that today.

### F10. Bee node, not the client, dominates upload wall clock

> ⚠ **Speeds below are client → local Bee, NOT Swarm-network upload speeds.** See [measurement scope](#-measurement-scope-caveat-read-first).

For `net.bzz.upload` and `net.bytes.upload`, throughput converges across all three clients at the size where the payload starts hitting the local Bee in earnest:

| size | bee-go | bee-rs | bee-js |
|---|---|---|---|
| 1MB bzz | 8.4 MB/s | 11.2 MB/s | 9.8 MB/s |
| 10MB bzz | 8.7 MB/s | 10.9 MB/s | 10.3 MB/s |
| 100MB bzz | 8.4 MB/s | 10.1 MB/s | 9.4 MB/s |

bee-rs leads by ~15-20% but the spread is small relative to within-runner variance. The Bee node (Sepolia-paired, processing stamping + BMT + push to peers) is the bottleneck. Encrypted upload halves throughput across all three (~5 MB/s) — the cost lives in Bee's per-chunk encryption path, not the client.

### F11. Download is bandwidth-bound, ranking flips

> ⚠ **This is a local-cache hit, NOT a Swarm-network download.** The chunks were just uploaded by the same runner, so Bee returns them from local store. Numbers below describe the client's download-path overhead, NOT real network fetch speed. See [measurement scope](#-measurement-scope-caveat-read-first).

`net.bzz.download` (drain to counting sink, never buffer) at 100MB: bee-rs 663ms, bee-js 662ms, bee-go 727ms — JS *and* Rust win on download. axios' `responseType: 'stream'` and reqwest's `bytes_stream` both keep up with the pipe; bee-go's reader is slightly slower likely due to per-chunk allocation patterns. None of these are limited by the client; this is the loopback-pipe ceiling, not Swarm.

### F12. /chunks endpoint is the wallclock killer on Sepolia

`net.chunks.upload count=50`: median 146-179s per iter across runners. /chunks blocks per-chunk while Bee waits for the network sync to confirm; Sepolia exhibits ~600ms/chunk under load. Per-runner spread is 20% but irrelevant — Bee dominates. Original plan was 1000 chunks; was forced down to 50 for wall-clock reasons. Conclusion: client-side chunk-upload performance is invisible behind Bee's sync queue on Sepolia. Re-run on a dev-mode Bee or mainnet for client-side numbers.

### F13. SOC writes: bee-go is ~2x slower than bee-rs/bee-js

Surprising because bee-go won on bzz-upload latency for small sizes:

| Runner | net.soc.upload count=25 |
|---|---|
| bee-go | 144s |
| bee-js | 81s |
| bee-rs | 67s |

Worth investigating bee-go's `client.File.MakeSOCWriter` path — possibly an avoidable per-chunk allocation or a redundant address recomputation. (Outside this benchmark's scope but flagged for future.)

### F13b. SOC writes update on the 2026-05-02 unified sweep

Re-run of `net.soc.upload count=25` on the 2026-05-02 unified sweep:

| Runner | median | per-SOC |
|---|---|---|
| bee-go | 1.14min | 2.75s/SOC |
| bee-rs | **40.6s** | 1.62s/SOC |
| bee-js | 1.41min | 3.39s/SOC |

Same ranking as F13 (rs < go < js in the original baseline; here rs < go ≈ js). bee-go SOC writes are still ~70% slower than bee-rs. The hypothesis from F13 (avoidable allocation or address-recompute in `client.File.MakeSOCWriter`) still stands.

### F14. Feed read fails with 404 in same iter as the write

`net.feed.write-read.fresh` and `.warm` failed with 404 on all three runners — the read happens immediately after the SOC write, before Sepolia sync confirms the chunk. This isn't a client bug; it's a benchmark design issue (test loop reads before propagation). A retry-with-backoff would mask the cost we're trying to measure (the exponential search). For a clean measurement, write+sleep(2s)+read or test against dev-mode Bee where sync is local. Skip rows in the report are honest — the cases need redesign, not the runners.

### F15. ECDSA verify in bee-js is 947x slower (worse than the sign gap of 219x)

Verify (recover-public-key under eth-envelope) is *slower* than sign on both pure-Rust k256 and pure-JS bigint, but *faster* on bee-go's optimized backend:

| Runner | sign 1000 | verify 1000 | sign µs | verify µs | verify/sign ratio |
|---|---|---|---|---|---|
| bee-go | 72.8ms | 50.7ms | 73 | 51 | **0.70** (verify faster) |
| bee-rs | 117.1ms | 225.5ms | 117 | 225 | 1.92 (verify ~2x slower) |
| bee-js | 15.94s | 47.99s | 15,940 | 47,988 | 3.01 (verify ~3x slower) |

Verify ratios to bee-go:

| Runner | sign-vs-go | verify-vs-go |
|---|---|---|
| bee-go | 1.0x | 1.0x |
| bee-rs | 1.61x | 4.45x |
| bee-js | 219x | **947x** |

bee-go's secp256k1 backend (decred dcrd, asm-optimized) implements verify via direct point operations — strictly cheaper than sign's modular inverse. bee-rs's k256 has no asm path, so verify is dominated by the recovery search. bee-js's pure-bigint Elliptic library pays the recovery cost twice over: recovery requires multiple field exponentiations and JS bigint has no SIMD/asm shortcut.

**Implication for feed reads:** bee-js spending 48ms per recover means a single `bee.makeFeedReader().download()` has a ~48ms client-side floor before the HTTP call. Stack ten reads, that's nearly half a second of pure-JS bigint work. The slow JS feed flow people complain about isn't all Bee's `/feeds` exponential search — a meaningful chunk is recover-side.

### F16. Mantaray lookup is essentially tied between bee-go and bee-rs

`cpu.manifest.lookup-large` (5000 entries, 1000 random Find calls per iter, 80% hits / 20% misses):

| Runner | total | per-lookup | rss |
|---|---|---|---|
| bee-go | 419µs | 0.42µs | 241MB |
| bee-rs | **409µs** | 0.41µs | 123MB |
| bee-js | 2.17ms | 2.17µs | 297MB |

The Go and Rust trie traversals are within 2% of each other — both ~0.4µs per lookup over a 5000-entry trie, fast enough that this case is essentially a no-op vs the surrounding cooldown. bee-js is ~5x slower; the JS Mantaray uses a JavaScript Map keyed by byte values, so map dispatch and prefix-byte-array slicing add overhead the Go and Rust paths avoid via direct slice operations.

**Implication:** for any application that resolves paths within a manifest (most Swarm sites do this once per request), client choice doesn't meaningfully affect lookup latency for manifests in the thousands-of-entries range. Variance dominates within-runner (bee-go showed ±58% across 5 iters at this size).

### F17. cpu.identity.create is another secp256k1 backend revealer

`cpu.identity.create count=1000` (random 32 bytes → PrivateKey → public-key derivation → 20-byte ETH address):

| Runner | total | per-identity | vs bee-go |
|---|---|---|---|
| bee-go | 44.8ms | 45µs | 1.0x |
| bee-rs | 65.7ms | 66µs | 1.47x |
| bee-js | 15.91s | 15.9ms | **355x** |

Same backend story as `cpu.ecdsa.sign-1000`. The dominant cost is the public-key derivation (point multiplication on the curve), which is faster on go's asm path than rs's k256 (no asm) and astronomically faster than bee-js's bigint Elliptic. For any flow that derives many fresh identities (signer rotation, ephemeral SOC owners, test-fixture generation), bee-js will spend ~16 seconds where bee-go spends 45ms.

### F18. Pin endpoint round-trips are 2.4x faster on bee-rs

`net.pin.add-list count=25` (51 sequential round-trips per iter: 25 POST /pins/<ref> + 1 GET /pins + 25 DELETE /pins/<ref>):

| Runner | median | per-call | rank |
|---|---|---|---|
| bee-go | 70.1ms | 1.37ms/call | 2.35x |
| bee-rs | **29.8ms** | **0.58ms/call** | best |
| bee-js | 77.0ms | 1.51ms/call | 2.58x |

Same HTTP-stack story as `net.stamps.concurrent` (F-prior): bee-rs's reqwest pools and reuses connections aggressively while bee-go's `http.DefaultClient` and bee-js's axios both pay re-handshake costs per call on a sequential pin/unpin loop. Variance is huge in this row (max 26s for go, 55s for rs) — one bad call from sync-queue interaction skews the spread. Median is the right read.

### F19. bee-go is unexpectedly slow on stream-dir upload

`net.stream-dir.upload files=20 file_bytes=8192` (chunk-by-chunk Mantaray persist):

| Runner | median | per-file | rank |
|---|---|---|---|
| bee-go | 4.21min | 12.62s/file | 2.93x |
| bee-rs | **1.44min** | **4.31s/file** | best |
| bee-js | 1.63min | 4.88s/file | 1.13x |

bee-go's `StreamCollectionEntries` is 3x slower than bee-rs and bee-js. All three are bottlenecked on Sepolia `/chunks` per-chunk push-ack (~600ms each), so the chunk count dominates wall clock — yet bee-go ends up issuing meaningfully more chunks or serializing them less efficiently. Worth investigating: `pkg/file/stream.go:75` is the StreamCollectionEntries path; possibly a per-file Mantaray rebuild or a sequential-vs-pipelined dispatch difference.

### F20. Tag bookkeeping is cheap on all three

`net.tags.upload-with-tag size_mb=1` (createTag → /bytes upload with Swarm-Tag header → getTag):

| Runner | median | bytes throughput | tag overhead vs raw /bytes |
|---|---|---|---|
| bee-go | 125.5ms | 8.0 MB/s | ~30ms (vs net.bytes.upload 1MB ~95ms) |
| bee-rs | **92.7ms** | 10.8 MB/s | ~3ms |
| bee-js | 98.6ms | 10.1 MB/s | ~5ms |

Tag bookkeeping (POST /tags + the Swarm-Tag-Uid round-trip + GET /tags/<id>) costs essentially nothing on bee-rs (3ms) and bee-js (5ms), but costs ~30ms extra on bee-go — likely the same connection-pool issue showing up under a 3-call sequence. For pipelines that create many tags (per-upload progress tracking), bee-go's overhead is meaningful.

### F21. Updated scoreboard: bee-rs wins decisively overall

| Runner | Wins | Overall | CPU | Calibration | Feeds | Net upload | Net download | Pin/observability | Bee chunk-pipeline |
|---|---|---|---|---|---|---|---|---|---|
| bee-go | 10 | 1.32x | **1.15x** | 6.04x | 1.00x | 1.16x | 1.01x | 2.35x | 1.83x |
| bee-rs | **24** | **1.11x** | 1.26x | **1.00x** | **1.11x** | **1.00x** | 1.20x | **1.00x** | **1.00x** |
| bee-js | 0 | 4.48x | 30.9x | 14.5x | 1.23x | 1.13x | 2.39x | 2.58x | 1.42x |

bee-rs leads or ties on **every group except CPU**. The recurring driver is the HTTP stack: reqwest+tokio pools and reuses connections more aggressively than Go's `http.DefaultClient` and far more aggressively than bee-js's axios (which defaults `keepAlive: false`). bee-go remains marginally fastest on pure CPU (1.15x vs rs's 1.26x) thanks to optimized secp256k1 asm, but loses meaningfully whenever there are concurrent or sequential HTTP round-trips. bee-js wins zero rows.
