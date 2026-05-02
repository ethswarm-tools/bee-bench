# bee-bench report

Generated: 2026-05-02T17:31:48.484Z

**See also:** [results landing page](INDEX.md) · [findings (qualitative)](../FINDINGS.md) · [README (how to run)](../README.md)

> ## ⚠ MB/s numbers are NOT Swarm-network throughput
>
> Every byte/sec figure in this report is **client ↔ local Bee node** over loopback HTTP, NOT real Swarm-network throughput:
>
> - **Uploads** measure how fast the client pushes data into the local Bee node's store under deferred-upload mode. The chunks are still being pushed to the Swarm network in the background after the call returns.
> - **Downloads** of references uploaded earlier in the same run hit the local Bee cache. Numbers like "253 MB/s" are local-store reads, not network fetches.
>
> For real Swarm-network numbers, fetch from a Bee that doesn't have the chunks (different node, or after cache eviction) and re-run uploads with `deferred: false`. See [FINDINGS § measurement scope](../FINDINGS.md#-measurement-scope-caveat-read-first).

## Runners

| Runner | Client | Bee node | Started | CPU |
|---|---|---|---|---|
| bee-go | bee-go (replace ../../bee-go) | 2.7.2-rc1-83612d37 | 2026-05-02T10:19:43Z | Intel(R) Core(TM) Ultra 9 275HX |
| bee-rs | bee-rs 0.1.0 (path) | 2.7.2-rc1-83612d37 | 2026-05-02T11:51:55.620519232+00:00 | Intel(R) Core(TM) Ultra 9 275HX |
| bee-js | bee-js (file:../../bee-js) | 2.7.2-rc1-83612d37 | 2026-05-02T12:51:01.392Z | Intel(R) Core(TM) Ultra 9 275HX |

## Scoreboard

Geometric mean of *median-time ratio to fastest runner per row*. 1.00x = fastest. Higher = slower. The "wins" column counts rows where the runner had the lowest median. "Rows" is the number of (case, param) rows the runner contributed a valid sample for — context for how broad each geomean is.

| Runner | Wins | Rows | Overall | CPU (no network) | Calibration | Feeds | Network upload | Network upload (streaming from disk) | Network download | Pin / observability | Bee chunk-pipeline (Sepolia-bottlenecked) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| bee-go | 10 | 34 | 1.32x | 1.15x | 6.04x | 1.00x | 1.16x | — | 1.01x | 2.35x | 1.83x |
| bee-rs | 24 | 34 | 1.11x | 1.26x | 1.00x | 1.11x | 1.00x | — | 1.20x | 1.00x | 1.00x |
| bee-js | 0 | 34 | 4.48x | 30.9x | 14.5x | 1.23x | 1.13x | — | 2.39x | 2.58x | 1.42x |

## CPU (no network)

> Pure client work — no Bee involvement.

### `cpu.keccak.chunk-hash`

> Hash N 4096-byte payloads via the client's BMT chunk-address path. Per-call overhead dominates.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| chunk_bytes=4096, count=10000 | 597.2ms (1.20x)<br>65.4 MB/s · 60µs/call<br>±9% · cv 5.2% · rss 234MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,9.2 30.0,13.0 44.5,8.1 59.0,11.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **497.0ms** (best)<br>78.6 MB/s · 50µs/call<br>±0% · cv 0.3% · rss 118MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,6.8 30.0,6.4 44.5,13.0 59.0,8.5" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 6.32s (12.7x)<br>6.2 MB/s · 632µs/call<br>±2% · cv 0.8% · rss 222MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,6.0 30.0,1.3 44.5,2.1 59.0,1.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="13" height="8" fill="#00ADD8"/><rect x="0" y="10" width="11" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

### `cpu.keccak.bulk`

> Hash one large buffer in a single keccak call. Throughput, not per-call overhead.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| size_mb=100 | 285.0ms (1.13x)<br>350.9 MB/s<br>±1% · cv 0.5% · rss 234MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,9.8 30.0,10.6 44.5,2.7 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **252.7ms** (best)<br>395.6 MB/s<br>±0% · cv 0.3% · rss 118MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,9.7 15.5,7.3 30.0,13.0 44.5,3.1 59.0,1.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 3.00s (11.9x)<br>33.4 MB/s<br>±5% · cv 3.8% · rss 1426MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,10.9 44.5,6.8 59.0,5.2" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="13" height="8" fill="#00ADD8"/><rect x="0" y="10" width="12" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

### `cpu.bmt.file-root`

> Compute Mantaray/BMT root for a buffer; no upload. The colleague's chunking-perf hypothesis.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| size_mb=1 | 19.9ms (1.47x)<br>50.2 MB/s<br>±5% · cv 2.9% · rss 234MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,1.8 30.0,12.3 44.5,11.7 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **13.5ms** (best)<br>73.9 MB/s<br>±17% · cv 10.3% · rss 118MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,1.5 30.0,10.2 44.5,11.8 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 177.9ms (13.1x)<br>5.6 MB/s<br>±2% · cv 1.4% · rss 1427MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,7.0 15.5,5.9 30.0,13.0 44.5,9.2 59.0,1.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="16" height="8" fill="#00ADD8"/><rect x="0" y="10" width="11" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |
| size_mb=10 | 154.7ms (1.20x)<br>64.7 MB/s<br>±23% · cv 9.9% · rss 235MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,12.2 15.5,13.0 30.0,1.0 44.5,10.3 59.0,12.6" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **129.4ms** (best)<br>77.3 MB/s<br>±1% · cv 0.3% · rss 118MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,8.1 15.5,13.0 30.0,3.6 44.5,1.0 59.0,9.2" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 1.66s (12.8x)<br>6.0 MB/s<br>±6% · cv 2.8% · rss 1426MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,12.6 30.0,13.0 44.5,11.9 59.0,12.1" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="13" height="8" fill="#00ADD8"/><rect x="0" y="10" width="11" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |
| size_mb=100 | 1.54s (1.19x)<br>65.0 MB/s<br>±4% · cv 1.7% · rss 235MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,12.7 15.5,6.2 30.0,12.9 44.5,13.0 59.0,1.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **1.29s** (best)<br>77.2 MB/s<br>±0% · cv 0.0% · rss 118MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,9.3 30.0,13.0 44.5,4.4 59.0,6.4" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 17.08s (13.2x)<br>5.9 MB/s<br>±3% · cv 1.5% · rss 1426MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,9.7 15.5,13.0 30.0,12.7 44.5,7.7 59.0,1.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="13" height="8" fill="#00ADD8"/><rect x="0" y="10" width="11" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

**Latency-vs-size linear fit** (`time_ms ≈ fixed_overhead + bytes / throughput`):

| Runner | fixed overhead | peak throughput | points |
|---|---|---|---|
| bee-go | 3.0ms | 65.2 MB/s | 3 |
| bee-rs | 292µs | 77.3 MB/s | 3 |
| bee-js | 0µs | 5.8 MB/s | 3 |

### `cpu.bmt.encrypted-file-root`

> Same as cpu.bmt.file-root but with encryption. BMT input differs per chunk because of the per-chunk key prefix.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| size_mb=1 | *skip:* no offline encryption-aware chunker API in bee-go | *skip:* no offline encryption-aware chunker API in bee-rs | *skip:* no offline encryption-aware chunker API in bee-js |  |
| size_mb=10 | *skip:* no offline encryption-aware chunker API in bee-go | *skip:* no offline encryption-aware chunker API in bee-rs | *skip:* no offline encryption-aware chunker API in bee-js |  |
| size_mb=100 | *skip:* no offline encryption-aware chunker API in bee-go | *skip:* no offline encryption-aware chunker API in bee-rs | *skip:* no offline encryption-aware chunker API in bee-js |  |

### `cpu.ecdsa.sign-1000`

> Sign 1000 32-byte digests with the eth-envelope scheme (all three clients identical). Tests the colleague's ECDSA-in-JS hypothesis.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| count=1000 | **72.8ms** (best)<br>73µs/sign<br>⚠ ±57% · cv 22.7% · rss 235MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,13.0 44.5,12.9 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | 117.8ms (1.62x)<br>118µs/sign<br>±0% · cv 0.2% · rss 118MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,10.5 30.0,11.7 44.5,13.0 59.0,12.9" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 16.18s (222x)<br>16.2ms/sign<br>±3% · cv 1.5% · rss 238MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,9.2 15.5,1.0 30.0,12.6 44.5,11.8 59.0,13.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="2" height="8" fill="#22c55e"/><rect x="0" y="10" width="2" height="8" fill="#DEA584"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

### `cpu.ecdsa.verify-1000`

> Verify 1000 (digest, signature) pairs (recover public key under eth-envelope). Verify dominates feed reads. Pure-JS bigint ECDSA recover is the suspected pessimal case — likely worse than the 221x sign-side gap.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| count=1000 | **50.7ms** (best)<br>51µs/verify<br>±2% · cv 1.0% · rss 236MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,12.5 30.0,11.1 44.5,13.0 59.0,11.5" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | 224.8ms (4.44x)<br>225µs/verify<br>±0% · cv 0.0% · rss 118MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,8.5 30.0,2.8 44.5,3.7 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 48.13s (950x)<br>48.1ms/verify<br>±1% · cv 0.6% · rss 246MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,6.9 30.0,2.9 44.5,1.0 59.0,1.1" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="2" height="8" fill="#22c55e"/><rect x="0" y="10" width="2" height="8" fill="#DEA584"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

### `cpu.identity.create`

> Generate 1000 fresh secp256k1 identities (random 32 bytes → PrivateKey → public key → 20-byte ETH address). Same crypto-backend story as ECDSA but for keygen — point multiplication dominates.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| count=1000 | **44.7ms** (best)<br>45µs/identity<br>±15% · cv 6.5% · rss 236MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,12.6 44.5,12.9 59.0,11.8" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | 66.1ms (1.48x)<br>66µs/identity<br>±0% · cv 0.3% · rss 118MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,4.3 30.0,9.6 44.5,12.9 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 16.18s (362x)<br>16.2ms/identity<br>±1% · cv 0.6% · rss 246MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,11.9 30.0,10.9 44.5,1.0 59.0,10.5" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="2" height="8" fill="#22c55e"/><rect x="0" y="10" width="2" height="8" fill="#DEA584"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

### `cpu.keccak.parallel`

> Distribute 10000 BMT chunk hashes across NumCPU workers. Each worker generates + hashes its own slice. Reveals real CPU scaling: bee-go (goroutines) and bee-rs (std::thread) near-linear; bee-js uses Node Worker threads.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| chunk_bytes=4096, count=10000 | 51.6ms (1.11x)<br>757.4 MB/s · 5µs/call<br>±18% · cv 10.9% · rss 242MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,5.6 30.0,8.5 44.5,13.0 59.0,4.8" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **46.6ms** (best)<br>838.6 MB/s · 5µs/call<br>±28% · cv 16.6% · rss 119MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,2.8 30.0,9.5 44.5,13.0 59.0,11.5" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 553.8ms (11.9x)<br>70.5 MB/s · 55µs/call<br>±3% · cv 1.9% · rss 922MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,8.6 15.5,1.0 30.0,13.0 44.5,6.2 59.0,5.7" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="13" height="8" fill="#00ADD8"/><rect x="0" y="10" width="12" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

### `cpu.manifest.hash-50files`

> Offline manifest root for 50 small files (no upload).

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| file_bytes=1024, files=50 | **7.7ms** (best)<br>6.3 MB/s · 155µs/file<br>±0% · cv 0.2% · rss 242MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,2.5 30.0,8.5 44.5,13.0 59.0,5.1" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | 9.3ms (1.20x)<br>5.3 MB/s · 185µs/file<br>±5% · cv 2.7% · rss 118MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,3.4 15.5,1.0 30.0,1.2 44.5,5.3 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 81.6ms (10.5x)<br>0.6 MB/s · 1.6ms/file<br>±5% · cv 3.1% · rss 253MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,12.3 15.5,1.0 30.0,7.1 44.5,8.3 59.0,13.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="13" height="8" fill="#22c55e"/><rect x="0" y="10" width="16" height="8" fill="#DEA584"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

### `cpu.manifest.lookup-large`

> Build a Mantaray with 5000 path entries (outside timing), then time 1000 random Find/lookup calls. Trie-traversal hot path; each client implements Mantaray independently so divergence reveals lookup-cost differences.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| entries=5000, lookups=1000 | 442µs (1.48x)<br>0µs/lookup<br>±16% · cv 6.7% · rss 242MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,9.5 44.5,12.7 59.0,12.3" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **299µs** (best)<br>0µs/lookup<br>±20% · cv 9.5% · rss 123MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,10.9 30.0,11.1 44.5,13.0 59.0,10.9" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 2.2ms (7.51x)<br>2µs/lookup<br>⚠ ±146% · cv 48.2% · rss 277MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,9.7 15.5,1.0 30.0,12.5 44.5,12.9 59.0,13.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="28" height="8" fill="#00ADD8"/><rect x="0" y="10" width="19" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

## Calibration

> Control + concurrent overhead. /stamps.list = sequential calibration. /stamps.concurrent = N parallel calls, exposes HTTP-stack differences (connection pool, keepalive default).

### `net.stamps.list`

> GET /stamps. Calibration / control case. If runners diverge wildly here, the rig is mis-set. Run early before Bee's sync queue builds up.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| — | 929µs (2.89x)<br>±25% · cv 18.5% · rss 243MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,10.1 30.0,6.5 44.5,13.0 59.0,4.9" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **322µs** (best)<br>±23% · cv 13.4% · rss 123MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,10.4 30.0,7.4 44.5,13.0 59.0,8.7" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 2.6ms (7.98x)<br>±23% · cv 12.8% · rss 273MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,2.0 15.5,1.0 30.0,7.4 44.5,3.8 59.0,13.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="51" height="8" fill="#00ADD8"/><rect x="0" y="10" width="18" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

### `net.stamps.concurrent`

> Fire 200 parallel GET /stamps. Bee returns instantly; spread exposes pure HTTP-client overhead — connection pool size, keepalive default (axios's default-off vs reqwest/Go's default-on), async dispatch.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| count=200 | 49.6ms (12.6x)<br>248µs/call<br>±17% · cv 9.0% · rss 247MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,8.6 15.5,2.9 30.0,1.6 44.5,1.0 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **3.9ms** (best)<br>20µs/call<br>±33% · cv 16.3% · rss 129MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,10.1 30.0,13.0 44.5,12.1 59.0,10.5" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 102.9ms (26.2x)<br>515µs/call<br>±18% · cv 9.3% · rss 279MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,2.3 15.5,1.0 30.0,13.0 44.5,3.2 59.0,6.5" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="67" height="8" fill="#00ADD8"/><rect x="0" y="10" width="5" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

## Feeds

> `fresh` measures Bee /feeds exponential search (Sepolia-bound). `warm` is the cached-lookup cost.

### `net.feed.write-read.fresh`

> Write feed update at next index, then read latest with retry-with-backoff (Bee /feeds endpoint can take 30-60s on Sepolia). Run BEFORE heavy upload cases — when Bee's sync queue is busy, /feeds returns 404.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| — | **1.0min** (best)<br>±1% · cv 0.6% · rss 247MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,3.9 15.5,1.0 30.0,13.0 44.5,2.7 59.0,10.1" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | 1.3min (1.24x)<br>±38% · cv 25.0% · rss 127MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,6.9 30.0,1.0 44.5,13.0 59.0,5.3" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 1.6min (1.52x)<br>⚠ ±85% · cv 52.1% · rss 224MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,3.3 15.5,4.3 30.0,1.0 44.5,13.0 59.0,6.8" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="92" height="8" fill="#22c55e"/><rect x="0" y="10" width="114" height="8" fill="#DEA584"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

### `net.feed.write-read.warm`

> After fresh read, time N subsequent reads against the same feed (Bee cache warm).

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| reads=5 | 5.02s (1.00x)<br>1.00s/read<br>±0% · cv 0.0% · rss 160MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,11.9 15.5,12.8 30.0,1.0 44.5,1.4 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **5.01s** (best)<br>1.00s/read<br>±0% · cv 0.0% · rss 127MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,5.8 30.0,3.0 44.5,5.3 59.0,1.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 5.02s (1.00x)<br>1.00s/read<br>±0% · cv 0.0% · rss 225MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,12.3 44.5,8.6 59.0,3.1" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="140" height="8" fill="#00ADD8"/><rect x="0" y="10" width="140" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

## Network upload

> POST /bzz, /bytes, /bzz with encrypt=true, /bytes-with-tag. Bee chunking + stamping is the bottleneck (~10 MB/s).

### `net.bzz.upload`

> POST /bzz from in-memory salted buffer. Per-iter salt prefix → unique reference → no Bee dedup.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| size_mb=1 | 98.0ms (1.06x)<br>10.2 MB/s<br>±14% · cv 8.6% · rss 153MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,11.5 15.5,8.7 30.0,5.3 44.5,1.0 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **92.1ms** (best)<br>10.9 MB/s<br>±4% · cv 3.4% · rss 128MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,7.1 15.5,1.5 30.0,1.0 44.5,13.0 59.0,8.1" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 105.1ms (1.14x)<br>9.5 MB/s<br>±3% · cv 2.7% · rss 233MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,11.4 15.5,13.0 30.0,7.1 44.5,1.0 59.0,4.2" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="131" height="8" fill="#00ADD8"/><rect x="0" y="10" width="123" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |
| size_mb=10 | 966.6ms (1.10x)<br>10.3 MB/s<br>±5% · cv 3.4% · rss 165MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,8.7 15.5,12.9 30.0,13.0 44.5,1.0 59.0,4.5" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **881.4ms** (best)<br>11.3 MB/s<br>±3% · cv 1.8% · rss 147MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,4.2 15.5,8.8 30.0,1.0 44.5,13.0 59.0,8.6" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 969.9ms (1.10x)<br>10.3 MB/s<br>±6% · cv 2.6% · rss 321MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,10.2 15.5,11.7 30.0,1.0 44.5,13.0 59.0,11.3" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="140" height="8" fill="#00ADD8"/><rect x="0" y="10" width="127" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |
| size_mb=100 | 9.89s (1.06x)<br>10.1 MB/s<br>±4% · cv 2.6% · rss 366MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.3 15.5,6.9 30.0,5.7 44.5,13.0 59.0,1.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **9.36s** (best)<br>10.7 MB/s<br>±7% · cv 3.0% · rss 327MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,11.7 44.5,12.9 59.0,12.8" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 9.84s (1.05x)<br>10.2 MB/s<br>±17% · cv 7.5% · rss 1208MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,11.2 30.0,13.0 44.5,12.3 59.0,12.3" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="140" height="8" fill="#00ADD8"/><rect x="0" y="10" width="133" height="8" fill="#22c55e"/><rect x="0" y="20" width="139" height="8" fill="#F7DF1E"/></svg> |

**Latency-vs-size linear fit** (`time_ms ≈ fixed_overhead + bytes / throughput`):

| Runner | fixed overhead | peak throughput | points |
|---|---|---|---|
| bee-go | 0µs | 10.1 MB/s | 3 |
| bee-rs | 0µs | 10.6 MB/s | 3 |
| bee-js | 0µs | 10.2 MB/s | 3 |

### `net.bzz.upload.encrypted`

> Same as net.bzz.upload but with encrypt=true. Skipped at 1GB by default.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| size_mb=1 | 291.3ms (1.18x)<br>3.4 MB/s<br>±5% · cv 2.6% · rss 366MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,7.9 44.5,9.8 59.0,9.6" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **246.3ms** (best)<br>4.1 MB/s<br>±4% · cv 2.1% · rss 128MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,6.5 15.5,1.0 30.0,4.5 44.5,1.4 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 270.3ms (1.10x)<br>3.7 MB/s<br>±2% · cv 1.4% · rss 1110MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,8.8 30.0,10.4 44.5,1.0 59.0,5.1" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="140" height="8" fill="#00ADD8"/><rect x="0" y="10" width="118" height="8" fill="#22c55e"/><rect x="0" y="20" width="130" height="8" fill="#F7DF1E"/></svg> |
| size_mb=10 | 3.22s (1.33x)<br>3.1 MB/s<br>±3% · cv 1.6% · rss 366MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,5.5 15.5,3.0 30.0,1.0 44.5,7.2 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **2.42s** (best)<br>4.1 MB/s<br>±1% · cv 0.8% · rss 147MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,9.9 30.0,5.6 44.5,1.0 59.0,8.3" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 2.84s (1.17x)<br>3.5 MB/s<br>±3% · cv 1.9% · rss 328MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,9.9 15.5,13.0 30.0,9.2 44.5,1.0 59.0,4.1" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="140" height="8" fill="#00ADD8"/><rect x="0" y="10" width="105" height="8" fill="#22c55e"/><rect x="0" y="20" width="124" height="8" fill="#F7DF1E"/></svg> |
| size_mb=100 | 33.07s (1.55x)<br>3.0 MB/s<br>±3% · cv 1.6% · rss 467MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,1.0 30.0,8.6 44.5,3.3 59.0,8.6" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **21.37s** (best)<br>4.7 MB/s<br>±12% · cv 5.7% · rss 327MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,11.7 15.5,5.1 30.0,13.0 44.5,11.7 59.0,1.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 30.18s (1.41x)<br>3.3 MB/s<br>±5% · cv 3.4% · rss 1208MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,8.9 30.0,6.2 44.5,1.0 59.0,4.8" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="140" height="8" fill="#00ADD8"/><rect x="0" y="10" width="90" height="8" fill="#22c55e"/><rect x="0" y="20" width="128" height="8" fill="#F7DF1E"/></svg> |

**Latency-vs-size linear fit** (`time_ms ≈ fixed_overhead + bytes / throughput`):

| Runner | fixed overhead | peak throughput | points |
|---|---|---|---|
| bee-go | 0µs | 3.0 MB/s | 3 |
| bee-rs | 157.6ms | 4.7 MB/s | 3 |
| bee-js | 0µs | 3.3 MB/s | 3 |

### `net.bytes.upload`

> POST /bytes (raw, no manifest) — isolates manifest serialization cost vs net.bzz.upload.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| size_mb=1 | **95.4ms** (best)<br>10.5 MB/s<br>±7% · cv 5.6% · rss 375MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,6.6 15.5,1.0 30.0,2.5 44.5,9.9 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | 96.7ms (1.01x)<br>10.3 MB/s<br>±7% · cv 5.1% · rss 128MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,1.0 30.0,3.8 44.5,6.9 59.0,6.7" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 101.9ms (1.07x)<br>9.8 MB/s<br>±9% · cv 4.1% · rss 1108MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,12.3 30.0,12.8 44.5,5.7 59.0,1.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="131" height="8" fill="#22c55e"/><rect x="0" y="10" width="133" height="8" fill="#DEA584"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |
| size_mb=10 | 898.0ms (1.01x)<br>11.1 MB/s<br>±1% · cv 0.5% · rss 375MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,5.4 15.5,13.0 30.0,2.9 44.5,1.0 59.0,7.8" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **892.6ms** (best)<br>11.2 MB/s<br>±5% · cv 3.3% · rss 147MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,8.1 15.5,1.0 30.0,8.3 44.5,3.2 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 1.02s (1.14x)<br>9.8 MB/s<br>±2% · cv 1.2% · rss 348MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,9.3 15.5,10.6 30.0,1.0 44.5,13.0 59.0,6.7" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="124" height="8" fill="#00ADD8"/><rect x="0" y="10" width="123" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |
| size_mb=100 | 10.79s (1.08x)<br>9.3 MB/s<br>±15% · cv 7.3% · rss 467MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,4.8 30.0,11.4 44.5,12.3 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **10.00s** (best)<br>10.0 MB/s<br>±5% · cv 2.6% · rss 327MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,11.2 15.5,10.5 30.0,12.7 44.5,1.0 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 10.54s (1.05x)<br>9.5 MB/s<br>±8% · cv 4.1% · rss 1248MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,10.2 30.0,7.2 44.5,11.5 59.0,1.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="140" height="8" fill="#00ADD8"/><rect x="0" y="10" width="130" height="8" fill="#22c55e"/><rect x="0" y="20" width="137" height="8" fill="#F7DF1E"/></svg> |

**Latency-vs-size linear fit** (`time_ms ≈ fixed_overhead + bytes / throughput`):

| Runner | fixed overhead | peak throughput | points |
|---|---|---|---|
| bee-go | 0µs | 9.2 MB/s | 3 |
| bee-rs | 0µs | 9.9 MB/s | 3 |
| bee-js | 0µs | 9.5 MB/s | 3 |

### `net.tags.upload-with-tag`

> POST /tags → upload 1MB via /bytes with Swarm-Tag header → GET /tags/<id>. Tests tag observability bookkeeping cost vs raw /bytes upload.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| size_mb=1 | 125.5ms (1.35x)<br>8.0 MB/s<br>±13% · cv 7.0% · rss 154MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,10.1 15.5,9.7 30.0,13.0 44.5,4.6 59.0,1.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **92.7ms** (best)<br>10.8 MB/s<br>±10% · cv 5.5% · rss 130MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,11.3 44.5,3.8 59.0,10.2" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 98.6ms (1.06x)<br>10.1 MB/s<br>±7% · cv 4.2% · rss 261MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,5.4 15.5,13.0 30.0,1.0 44.5,2.4 59.0,4.7" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="140" height="8" fill="#00ADD8"/><rect x="0" y="10" width="103" height="8" fill="#22c55e"/><rect x="0" y="20" width="110" height="8" fill="#F7DF1E"/></svg> |

## Network download

> ⚠ Local-cache hit — chunks were just uploaded so Bee returns them from local store. Measures client-side download path overhead, NOT real network fetch.

### `net.bzz.download`

> GET /bzz/<ref>. Drains body to counting sink — never buffers full response. Pre-uploaded fixture references.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| size_mb=1 | **4.2ms** (best)<br>240.5 MB/s<br>±35% · cv 17.7% · rss 467MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,10.7 30.0,9.6 44.5,8.1 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | 5.5ms (1.33x)<br>181.0 MB/s<br>±19% · cv 12.1% · rss 128MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,5.1 30.0,5.2 44.5,10.7 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 10.0ms (2.39x)<br>100.5 MB/s<br>±19% · cv 8.1% · rss 1148MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,10.0 30.0,13.0 44.5,12.0 59.0,12.4" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="58" height="8" fill="#22c55e"/><rect x="0" y="10" width="78" height="8" fill="#DEA584"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |
| size_mb=10 | **26.3ms** (best)<br>380.5 MB/s<br>⚠ ±80% · cv 30.5% · rss 467MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,11.8 30.0,13.0 44.5,12.6 59.0,12.7" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | 35.2ms (1.34x)<br>284.3 MB/s<br>±15% · cv 9.1% · rss 147MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,7.7 15.5,1.0 30.0,8.4 44.5,10.8 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 74.5ms (2.84x)<br>134.1 MB/s<br>±10% · cv 5.0% · rss 294MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,12.6 30.0,4.6 44.5,1.0 59.0,11.9" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="49" height="8" fill="#22c55e"/><rect x="0" y="10" width="66" height="8" fill="#DEA584"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |
| size_mb=100 | 415.0ms (1.05x)<br>240.9 MB/s<br>±5% · cv 3.8% · rss 243MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,7.5 15.5,13.0 30.0,7.6 44.5,2.7 59.0,1.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **395.0ms** (best)<br>253.2 MB/s<br>±8% · cv 4.5% · rss 327MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,11.0 30.0,7.0 44.5,1.0 59.0,9.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 639.6ms (1.62x)<br>156.3 MB/s<br>±6% · cv 3.4% · rss 669MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,10.1 30.0,2.9 44.5,1.0 59.0,2.1" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="91" height="8" fill="#00ADD8"/><rect x="0" y="10" width="86" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

**Latency-vs-size linear fit** (`time_ms ≈ fixed_overhead + bytes / throughput`):

| Runner | fixed overhead | peak throughput | points |
|---|---|---|---|
| bee-go | 0µs | 237.0 MB/s | 3 |
| bee-rs | 0µs | 252.5 MB/s | 3 |
| bee-js | 7.3ms | 158.1 MB/s | 3 |

### `net.bytes.head`

> 100 × HEAD /bytes/<ref> against the 1MB fixture reference. Metadata-only path — isolates HTTP-stack overhead from body transfer.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| count=100 | **21.9ms** (best)<br>219µs/HEAD<br>⚠ ±56% · cv 25.6% · rss 244MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,9.0 30.0,13.0 44.5,10.6 59.0,12.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | 24.6ms (1.12x)<br>246µs/HEAD<br>±13% · cv 8.5% · rss 128MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,5.8 30.0,3.4 44.5,8.1 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 97.9ms (4.47x)<br>979µs/HEAD<br>±6% · cv 4.2% · rss 585MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,6.1 30.0,6.9 44.5,10.1 59.0,13.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="31" height="8" fill="#22c55e"/><rect x="0" y="10" width="35" height="8" fill="#DEA584"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

### `net.bytes.download.range`

> 50 × GET /bytes/<ref> with Range: bytes=0-65535 against the 1MB fixture. Tests partial-download path and HTTP Range handling.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| ranges=50, size_mb=1 | **6.9ms** (best)<br>145.7 MB/s<br>±9% · cv 6.3% · rss 444MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,8.4 30.0,11.5 44.5,13.0 59.0,2.2" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | 8.4ms (1.23x)<br>118.7 MB/s<br>±34% · cv 14.1% · rss 228MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,9.1 30.0,12.3 44.5,12.5 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 10.8ms (1.57x)<br>92.8 MB/s<br>±26% · cv 13.9% · rss 649MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,9.9 15.5,1.0 30.0,12.1 44.5,13.0 59.0,5.4" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="89" height="8" fill="#22c55e"/><rect x="0" y="10" width="109" height="8" fill="#DEA584"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

## Pin / observability

> POST/DELETE /pins/<ref> + GET /pins. Per-call HTTP overhead on a pinning-endpoint shape.

### `net.pin.add-list`

> Pin 25 pre-uploaded refs (POST /pins/<ref>) → GET /pins → unpin all 25 (DELETE /pins/<ref>). Per-call HTTP overhead on a different endpoint than /stamps.

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| count=25 | 70.1ms (2.35x)<br>2.8ms/pin<br>⚠ ±37538% · cv 220.8% · rss 152MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,13.0 44.5,13.0 59.0,13.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **29.8ms** (best)<br>1.2ms/pin<br>⚠ ±185976% · cv 223.1% · rss 129MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,13.0 44.5,13.0 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 77.0ms (2.58x)<br>3.1ms/pin<br>±8% · cv 4.3% · rss 251MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,8.7 30.0,13.0 44.5,9.4 59.0,8.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="128" height="8" fill="#00ADD8"/><rect x="0" y="10" width="54" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |

## Bee chunk-pipeline (Sepolia-bottlenecked)

> ⚠ These cases are dominated by Bee's sync queue on Sepolia (~600ms/chunk push ack). Per-unit times are NOT a client-speed comparison.

### `net.chunks.upload`

> 50 × pre-built content-addressed chunks via /chunks. Per-call overhead. (Reduced from 1000 — Sepolia /chunks endpoint syncs ~600ms/chunk after a sync queue builds up from the bzz/bytes upload phase.)

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| count=50 | 3.9min (1.24x)<br>0.0 MB/s · 4.65s/chunk<br>⚠ ±59% · cv 32.1% · rss 243MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,13.0 30.0,5.0 44.5,3.6 59.0,3.4" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **3.1min** (best)<br>0.0 MB/s · 3.75s/chunk<br>±48% · cv 25.9% · rss 129MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,9.4 15.5,13.0 30.0,4.1 44.5,10.7 59.0,1.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 3.8min (1.22x)<br>0.0 MB/s · 4.57s/chunk<br>±45% · cv 29.1% · rss 649MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,9.1 15.5,1.0 30.0,1.0 44.5,4.3 59.0,13.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="140" height="8" fill="#00ADD8"/><rect x="0" y="10" width="113" height="8" fill="#22c55e"/><rect x="0" y="20" width="138" height="8" fill="#F7DF1E"/></svg> |

### `net.stream-dir.upload`

> Streaming directory upload for 20 files. (Reduced from 50 — back-pressured /chunks pipeline on Sepolia made larger sets dominate wall clock.)

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| file_bytes=8192, files=20 | 4.2min (2.93x)<br>0.0 MB/s · 12.62s/file<br>⚠ ±67% · cv 34.0% · rss 152MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,10.2 30.0,12.8 44.5,13.0 59.0,10.0" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **1.4min** (best)<br>0.0 MB/s · 4.31s/file<br>±37% · cv 19.3% · rss 129MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,13.0 15.5,2.2 30.0,7.1 44.5,1.0 59.0,2.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 1.6min (1.13x)<br>0.0 MB/s · 4.88s/file<br>⚠ ±87% · cv 50.9% · rss 250MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,8.7 15.5,11.2 30.0,8.4 44.5,13.0 59.0,1.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="140" height="8" fill="#00ADD8"/><rect x="0" y="10" width="48" height="8" fill="#22c55e"/><rect x="0" y="20" width="54" height="8" fill="#F7DF1E"/></svg> |

### `net.soc.upload`

> Single-owner-chunk write × 25. Hot path under feeds. (Was 100 — reduced to keep wall clock reasonable on Sepolia.)

| param | bee-go | bee-rs | bee-js | chart |
|---|---|---|---|---|
| count=25 | 1.1min (1.69x)<br>0.0 MB/s · 2.75s/SOC<br>⚠ ±64% · cv 41.5% · rss 152MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,6.7 15.5,1.0 30.0,12.1 44.5,13.0 59.0,8.3" fill="none" stroke="#00ADD8" stroke-width="1"/></svg> | **40.60s** (best)<br>0.0 MB/s · 1.62s/SOC<br>⚠ ±69% · cv 31.7% · rss 129MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,1.0 15.5,11.4 30.0,2.1 44.5,12.3 59.0,13.0" fill="none" stroke="#DEA584" stroke-width="1"/></svg> | 1.4min (2.09x)<br>0.0 MB/s · 3.39s/SOC<br>⚠ ±106% · cv 55.1% · rss 250MB<br><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14" style="vertical-align:middle"><polyline points="1.0,9.3 15.5,1.0 30.0,3.3 44.5,11.6 59.0,13.0" fill="none" stroke="#F7DF1E" stroke-width="1"/></svg> | <svg xmlns="http://www.w3.org/2000/svg" width="140" height="30"><rect x="0" y="0" width="113" height="8" fill="#00ADD8"/><rect x="0" y="10" width="67" height="8" fill="#22c55e"/><rect x="0" y="20" width="140" height="8" fill="#F7DF1E"/></svg> |
