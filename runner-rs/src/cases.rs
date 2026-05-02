use bee::Client;
use bee::api::{FileUploadOptions, RedundantUploadOptions, UploadOptions};
use bee::file::CollectionEntry;
use bee::manifest::MantarayNode;
use bee::swarm::{
    BatchId, FileChunker, Identifier, PrivateKey, Reference, Topic, calculate_chunk_address,
    keccak256, make_content_addressed_chunk,
};
use bytes::Bytes;
use futures_util::stream::StreamExt;
use rand::RngCore;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::fixtures::Fixtures;
use crate::runner::time_it;
use crate::spec::{ParamEntry, int_param, is_warmup};

/// Outcome of running a case: list of iter ms (empty = skip), total bytes
/// processed per iter (0 = N/A), notes string, and an error.
pub struct CaseOutcome {
    pub ms: Vec<f64>,
    pub bytes_per_iter: i64,
    pub notes: String,
}

impl CaseOutcome {
    pub fn skip(reason: impl Into<String>) -> Self {
        Self { ms: vec![], bytes_per_iter: 0, notes: format!("SKIP: {}", reason.into()) }
    }
    pub fn ok(ms: Vec<f64>, bytes_per_iter: i64) -> Self {
        Self { ms, bytes_per_iter, notes: String::new() }
    }
    pub fn ok_with(ms: Vec<f64>, bytes_per_iter: i64, notes: impl Into<String>) -> Self {
        Self { ms, bytes_per_iter, notes: notes.into() }
    }
}

fn default_iters(p: &ParamEntry) -> usize {
    p.get("iters_override").and_then(|v| v.as_u64()).map(|v| v as usize).unwrap_or(5)
}

// ---------- cpu.keccak.chunk-hash ----------
pub async fn case_keccak_chunk_hash(p: &ParamEntry) -> CaseOutcome {
    let count = int_param(p, "count", 10000) as usize;
    let chunk_bytes = int_param(p, "chunk_bytes", 4096) as usize;
    let mut buf = vec![0u8; 8 + chunk_bytes];
    buf[..8].copy_from_slice(&(chunk_bytes as u64).to_le_bytes());
    rand::thread_rng().fill_bytes(&mut buf[8..]);

    let count = if is_warmup(p) { (count / 100).max(100) } else { count };
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let (ms, _) = time_it(|| {
            for _ in 0..count {
                let _ = calculate_chunk_address(&buf);
            }
        });
        out.push(ms);
    }
    let total = (count as i64) * (chunk_bytes as i64);
    CaseOutcome::ok_with(out, total, format!("count={count} chunk_bytes={chunk_bytes}"))
}

// ---------- cpu.identity.create ----------
//
// Generate N fresh secp256k1 identities: random 32 bytes → PrivateKey →
// derive public key → derive 20-byte Ethereum address. The expensive part
// is the public-key derivation (point multiplication on the curve). Same
// crypto-backend story as cpu.ecdsa.sign-1000: bee-go uses asm-optimized
// secp256k1, bee-rs uses pure-Rust k256, bee-js uses pure-JS bigint.
pub async fn case_identity_create(p: &ParamEntry) -> CaseOutcome {
    let count = int_param(p, "count", 1000) as usize;
    let count = if is_warmup(p) { (count / 100).max(100) } else { count };
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let (ms, _) = time_it(|| {
            let mut b = [0u8; 32];
            for _ in 0..count {
                rand::thread_rng().fill_bytes(&mut b);
                if let Ok(k) = PrivateKey::new(&b) {
                    let _ = k.public_key().map(|p| p.address());
                }
            }
        });
        out.push(ms);
    }
    CaseOutcome::ok_with(out, 0, format!("count={count}"))
}

// ---------- cpu.keccak.parallel ----------
//
// Distribute count BMT chunk hashes across W = available_parallelism()
// worker threads. Each worker generates + hashes its own slice (no shared
// state). Time = wall clock to all workers complete. Reveals real CPU
// scaling: bee-go and bee-rs scale near-linearly with cores; bee-js with
// Node Worker threads also scales but is rate-limited by per-worker
// pure-JS keccak speed.
pub async fn case_keccak_parallel(p: &ParamEntry) -> CaseOutcome {
    let count = int_param(p, "count", 10000) as usize;
    let chunk_bytes = int_param(p, "chunk_bytes", 4096) as usize;
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);

    let count = if is_warmup(p) { (count / 100).max(100) } else { count };
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    let per_worker = count.div_ceil(workers);

    for _ in 0..iters {
        let (ms, _) = time_it(|| {
            let mut handles = Vec::with_capacity(workers);
            for w in 0..workers {
                let start = w * per_worker;
                if start >= count { break; }
                let end = (start + per_worker).min(count);
                let n = end - start;
                handles.push(std::thread::spawn(move || {
                    let mut buf = vec![0u8; 8 + chunk_bytes];
                    buf[..8].copy_from_slice(&(chunk_bytes as u64).to_le_bytes());
                    rand::thread_rng().fill_bytes(&mut buf[8..]);
                    for _ in 0..n {
                        let _ = calculate_chunk_address(&buf);
                    }
                }));
            }
            for h in handles { let _ = h.join(); }
        });
        out.push(ms);
    }
    let total = (count as i64) * (chunk_bytes as i64);
    CaseOutcome::ok_with(out, total, format!("count={count} workers={workers}"))
}

// ---------- cpu.keccak.bulk ----------
pub async fn case_keccak_bulk(p: &ParamEntry, fix: &Fixtures) -> CaseOutcome {
    let size_mb = int_param(p, "size_mb", 100) as usize;
    let buf = match fix.get(size_mb) {
        Some(b) => b,
        None => return CaseOutcome::skip(format!("fixture {size_mb}mb.bin missing")),
    };
    if is_warmup(p) {
        let _ = keccak256(buf);
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let (ms, _) = time_it(|| keccak256(buf));
        out.push(ms);
    }
    CaseOutcome::ok(out, buf.len() as i64)
}

// ---------- cpu.bmt.file-root ----------
pub async fn case_bmt_file_root(p: &ParamEntry, fix: &Fixtures) -> CaseOutcome {
    let size_mb = int_param(p, "size_mb", 0) as usize;
    if size_mb == 0 { return CaseOutcome::skip("missing size_mb"); }
    let buf = match fix.get(size_mb) {
        Some(b) => b,
        None => return CaseOutcome::skip(format!("fixture {size_mb}mb.bin missing")),
    };
    let run_one = || {
        let mut c = FileChunker::new();
        c.write(buf).map_err(|e| e.to_string())?;
        c.finalize().map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    };
    if is_warmup(p) {
        let _ = run_one();
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let (ms, res) = time_it(run_one);
        if let Err(e) = res {
            return CaseOutcome::skip(e);
        }
        out.push(ms);
    }
    CaseOutcome::ok(out, buf.len() as i64)
}

// ---------- cpu.bmt.encrypted-file-root ----------
pub async fn case_bmt_encrypted_file_root(_p: &ParamEntry) -> CaseOutcome {
    CaseOutcome::skip("no offline encryption-aware chunker API in bee-rs")
}

// ---------- cpu.ecdsa.sign-1000 ----------
pub async fn case_ecdsa_sign(p: &ParamEntry) -> CaseOutcome {
    let count = int_param(p, "count", 1000) as usize;
    let pk = PrivateKey::from_hex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
        .expect("valid hex");
    let mut digest = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut digest);
    let count = if is_warmup(p) { (count / 10).max(50) } else { count };
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let (ms, _) = time_it(|| {
            for _ in 0..count {
                let _ = pk.sign(&digest);
            }
        });
        out.push(ms);
    }
    CaseOutcome::ok_with(out, 0, format!("count={count}"))
}

// ---------- cpu.manifest.hash-50files ----------
pub async fn case_manifest_hash50(p: &ParamEntry) -> CaseOutcome {
    let files = int_param(p, "files", 50) as usize;
    let file_bytes = int_param(p, "file_bytes", 1024) as usize;
    let entries: Vec<CollectionEntry> = (0..files).map(|i| {
        let mut data = vec![0u8; file_bytes];
        rand::thread_rng().fill_bytes(&mut data);
        CollectionEntry::new(format!("file-{i:04}.bin"), data)
    }).collect();
    let run_one = || {
        bee::file::hash_collection_entries(&entries).map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    };
    if is_warmup(p) {
        let _ = run_one();
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let (ms, res) = time_it(run_one);
        if let Err(e) = res {
            return CaseOutcome::skip(e);
        }
        out.push(ms);
    }
    CaseOutcome::ok_with(
        out,
        (files * file_bytes) as i64,
        format!("files={files} bytes_each={file_bytes}"),
    )
}

// ---------- net.stamps.list ----------
pub async fn case_stamps_list(p: &ParamEntry, client: &Client) -> CaseOutcome {
    if is_warmup(p) {
        let _ = client.postage().get_postage_batches().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = client.postage().get_postage_batches().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok(out, 0)
}

// ---------- net.stamps.concurrent ----------
//
// Fire N parallel GET /stamps. Bee returns instantly; the spread across
// runners is pure HTTP-client overhead — connection pool size, keepalive
// defaults, async dispatch cost. We measure total burst time
// (start → all N complete) per iter.
pub async fn case_stamps_concurrent(p: &ParamEntry, client: &Client) -> CaseOutcome {
    let count = int_param(p, "count", 200) as usize;
    let burst = || async {
        let postage = client.postage();
        let mut futs = Vec::with_capacity(count);
        for _ in 0..count {
            futs.push(postage.get_postage_batches());
        }
        let results = futures_util::future::join_all(futs).await;
        for r in results {
            r?;
        }
        Ok::<(), bee::Error>(())
    };
    if is_warmup(p) {
        let _ = burst().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = burst().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok_with(out, 0, format!("count={count}"))
}

// ---------- net.bytes.head ----------
//
// Pre-upload a small payload via /bytes once, then time N HEAD calls.
// HEAD returns Content-Length and other metadata without the body —
// minimal Bee work, isolates HTTP-stack cost (DNS not relevant on
// localhost; pool/keepalive/header parse is what we measure).
pub async fn case_bytes_head(
    p: &ParamEntry,
    client: &Client,
    batch: &BatchId,
    fix: &Fixtures,
) -> CaseOutcome {
    let count = int_param(p, "count", 100) as usize;
    let buf = match fix.get(1) {
        Some(b) => b,
        None => return CaseOutcome::skip("fixture 1mb.bin missing"),
    };
    let mut salted = vec![0u8; 8 + buf.len()];
    salted[8..].copy_from_slice(buf);
    rand::thread_rng().fill_bytes(&mut salted[..8]);
    let pre_body = Bytes::from(salted);
    let up = match client.file().upload_data(batch, pre_body, None).await {
        Ok(r) => r,
        Err(e) => return CaseOutcome::skip(format!("pre-upload: {e}")),
    };
    let base = std::env::var("BEE_URL").unwrap_or_else(|_| "http://localhost:1633".into());
    let url = format!("{}/bytes/{}", base.trim_end_matches('/'), up.reference);
    let http = reqwest::Client::new();
    let burst = || async {
        for _ in 0..count {
            let resp = http.head(&url).send().await?;
            let _ = resp.bytes().await?;
        }
        Ok::<(), reqwest::Error>(())
    };
    if is_warmup(p) {
        let _ = burst().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = burst().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok_with(out, 0, format!("count={count}"))
}

// ---------- net.bytes.download.range ----------
//
// Pre-upload a 100MB payload via /bytes once, then time GET /bytes/<ref>
// with `Range: bytes=START-END` for a 1MB slice. Tests whether the client
// HTTP stack streams partial responses cleanly. On Sepolia + warm cache
// this is mostly a "does Bee respect Range correctly + is the client's
// HTTP path tight" measurement.
pub async fn case_bytes_download_range(
    p: &ParamEntry,
    client: &Client,
    batch: &BatchId,
    fix: &Fixtures,
) -> CaseOutcome {
    let slice_mb = int_param(p, "slice_mb", 1) as usize;
    let buf = match fix.get(100) {
        Some(b) => b,
        None => return CaseOutcome::skip("fixture 100mb.bin missing"),
    };
    let mut salted = vec![0u8; 8 + buf.len()];
    salted[8..].copy_from_slice(buf);
    rand::thread_rng().fill_bytes(&mut salted[..8]);
    let pre_body = Bytes::from(salted);
    let up = match client.file().upload_data(batch, pre_body, None).await {
        Ok(r) => r,
        Err(e) => return CaseOutcome::skip(format!("pre-upload: {e}")),
    };
    let base = std::env::var("BEE_URL").unwrap_or_else(|_| "http://localhost:1633".into());
    let url = format!("{}/bytes/{}", base.trim_end_matches('/'), up.reference);
    let http = reqwest::Client::new();
    let slice_bytes = slice_mb * 1024 * 1024;
    let range = format!("bytes=0-{}", slice_bytes - 1);
    let drain = || async {
        let resp = http.get(&url).header("Range", &range).send().await?;
        let mut s = resp.bytes_stream();
        let mut total: u64 = 0;
        while let Some(chunk) = s.next().await {
            let c = chunk?;
            total += c.len() as u64;
        }
        Ok::<u64, reqwest::Error>(total)
    };
    if is_warmup(p) {
        let _ = drain().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = drain().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok_with(out, slice_bytes as i64, format!("slice_mb={slice_mb}"))
}

// ---------- net.bzz.upload (POST /bzz, with manifest) ----------
pub async fn case_bzz_upload(
    p: &ParamEntry,
    client: &Client,
    batch: &BatchId,
    fix: &Fixtures,
) -> CaseOutcome {
    run_upload_file(p, client, batch, fix, None).await
}

// ---------- net.bzz.upload.encrypted ----------
pub async fn case_bzz_upload_encrypted(
    p: &ParamEntry,
    client: &Client,
    batch: &BatchId,
    fix: &Fixtures,
) -> CaseOutcome {
    let opts = FileUploadOptions {
        base: UploadOptions { encrypt: Some(true), ..Default::default() },
        ..Default::default()
    };
    run_upload_file(p, client, batch, fix, Some(opts)).await
}

async fn run_upload_file(
    p: &ParamEntry,
    client: &Client,
    batch: &BatchId,
    fix: &Fixtures,
    opts: Option<FileUploadOptions>,
) -> CaseOutcome {
    let size_mb = int_param(p, "size_mb", 0) as usize;
    if size_mb == 0 { return CaseOutcome::skip("missing size_mb"); }
    let buf = match fix.get(size_mb) {
        Some(b) => b,
        None => return CaseOutcome::skip(format!("fixture {size_mb}mb.bin missing")),
    };
    let mut salted = vec![0u8; 8 + buf.len()];
    salted[8..].copy_from_slice(buf);

    if is_warmup(p) {
        rand::thread_rng().fill_bytes(&mut salted[..8]);
        let body = Bytes::from(salted.clone());
        let _ = client.file()
            .upload_file(batch, body, "bench.bin", "application/octet-stream", opts.as_ref())
            .await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        rand::thread_rng().fill_bytes(&mut salted[..8]);
        let body = Bytes::from(salted.clone());
        let start = Instant::now();
        let res = client.file()
            .upload_file(batch, body, "bench.bin", "application/octet-stream", opts.as_ref())
            .await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok(out, salted.len() as i64)
}

// ---------- net.bytes.upload (POST /bytes, raw) ----------
pub async fn case_bytes_upload(
    p: &ParamEntry,
    client: &Client,
    batch: &BatchId,
    fix: &Fixtures,
) -> CaseOutcome {
    let size_mb = int_param(p, "size_mb", 0) as usize;
    if size_mb == 0 { return CaseOutcome::skip("missing size_mb"); }
    let buf = match fix.get(size_mb) {
        Some(b) => b,
        None => return CaseOutcome::skip(format!("fixture {size_mb}mb.bin missing")),
    };
    let mut salted = vec![0u8; 8 + buf.len()];
    salted[8..].copy_from_slice(buf);

    if is_warmup(p) {
        rand::thread_rng().fill_bytes(&mut salted[..8]);
        let body = Bytes::from(salted.clone());
        let _ = client.file().upload_data(batch, body, None).await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        rand::thread_rng().fill_bytes(&mut salted[..8]);
        let body = Bytes::from(salted.clone());
        let start = Instant::now();
        let res = client.file().upload_data(batch, body, None).await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok(out, salted.len() as i64)
}

// ---------- net.bzz.download ----------
//
// Pre-upload the fixture once via /bzz, then time GET /bzz/<ref> reads.
// Stream the body via response.bytes_stream() and drain to a counting sink —
// never buffer the full response.
pub async fn case_bzz_download(
    p: &ParamEntry,
    client: &Client,
    batch: &BatchId,
    fix: &Fixtures,
) -> CaseOutcome {
    let size_mb = int_param(p, "size_mb", 0) as usize;
    if size_mb == 0 { return CaseOutcome::skip("missing size_mb"); }
    let buf = match fix.get(size_mb) {
        Some(b) => b,
        None => return CaseOutcome::skip(format!("fixture {size_mb}mb.bin missing")),
    };
    let mut salted = vec![0u8; 8 + buf.len()];
    salted[8..].copy_from_slice(buf);
    rand::thread_rng().fill_bytes(&mut salted[..8]);
    let pre_body = Bytes::from(salted.clone());
    let up = match client.file()
        .upload_file(batch, pre_body, "bench.bin", "application/octet-stream", None)
        .await
    {
        Ok(r) => r,
        Err(e) => return CaseOutcome::skip(format!("pre-upload: {e}")),
    };

    let drain = || async {
        let resp = client.file().download_file_response(&up.reference, None).await?;
        let mut s = resp.bytes_stream();
        let mut total: u64 = 0;
        while let Some(chunk) = s.next().await {
            let c = chunk.map_err(|e| bee::Error::argument(format!("stream: {e}")))?;
            total += c.len() as u64;
        }
        Ok::<u64, bee::Error>(total)
    };

    if is_warmup(p) {
        let _ = drain().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = drain().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok(out, salted.len() as i64)
}

// ---------- net.chunks.upload ----------
//
// Build N pre-computed CACs locally, then time uploading them via /chunks.
pub async fn case_chunks_upload(p: &ParamEntry, client: &Client, batch: &BatchId) -> CaseOutcome {
    let mut count = int_param(p, "count", 1000) as usize;
    if is_warmup(p) {
        count = (count / 10).max(50);
    }
    let mut nonce = [0u8; 8];
    let mut chunks: Vec<Vec<u8>> = Vec::with_capacity(count);
    for i in 0..count {
        let mut payload = vec![0u8; 256];
        rand::thread_rng().fill_bytes(&mut nonce);
        payload[..8].copy_from_slice(&(i as u64).to_be_bytes());
        payload[8..16].copy_from_slice(&nonce);
        let c = match make_content_addressed_chunk(&payload) {
            Ok(c) => c,
            Err(e) => return CaseOutcome::skip(e.to_string()),
        };
        chunks.push(c.data());
    }
    let upload_all = || async {
        for wire in &chunks {
            let body = Bytes::copy_from_slice(wire);
            client.file().upload_chunk(batch, body, None).await?;
        }
        Ok::<(), bee::Error>(())
    };
    if is_warmup(p) {
        let _ = upload_all().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = upload_all().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok_with(out, (count * 256) as i64, format!("count={count}"))
}

// ---------- net.stream-dir.upload ----------
pub async fn case_stream_dir_upload(p: &ParamEntry, client: &Client, batch: &BatchId) -> CaseOutcome {
    let files = int_param(p, "files", 50) as usize;
    let file_bytes = int_param(p, "file_bytes", 8192) as usize;

    let build = |salt: u64| {
        (0..files)
            .map(|i| {
                let mut data = vec![0u8; file_bytes];
                data[..8].copy_from_slice(&salt.to_be_bytes());
                data[8..16].copy_from_slice(&(i as u64).to_be_bytes());
                rand::thread_rng().fill_bytes(&mut data[16..]);
                CollectionEntry::new(format!("file-{i:04}.bin"), data)
            })
            .collect::<Vec<_>>()
    };

    let upload_one = || async {
        let mut salt = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut salt);
        let salt_u64 = u64::from_be_bytes(salt);
        let entries = build(salt_u64);
        client.file()
            .stream_collection_entries(batch, &entries, None, None)
            .await
    };

    if is_warmup(p) {
        let _ = upload_one().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = upload_one().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok_with(
        out,
        (files * file_bytes) as i64,
        format!("files={files} bytes_each={file_bytes}"),
    )
}

// ---------- net.soc.upload ----------
pub async fn case_soc_upload(p: &ParamEntry, client: &Client, batch: &BatchId) -> CaseOutcome {
    let mut count = int_param(p, "count", 100) as usize;
    if is_warmup(p) {
        count = (count / 10).max(10);
    }
    let signer = match PrivateKey::from_hex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff") {
        Ok(k) => k,
        Err(e) => return CaseOutcome::skip(e.to_string()),
    };
    let writer = match client.file().make_soc_writer(signer) {
        Ok(w) => w,
        Err(e) => return CaseOutcome::skip(e.to_string()),
    };

    let mut nonce = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut nonce);
    let mut ids: Vec<Identifier> = Vec::with_capacity(count);
    for i in 0..count {
        let mut raw = [0u8; 32];
        raw[..8].copy_from_slice(&nonce);
        raw[8..16].copy_from_slice(&(i as u64).to_be_bytes());
        ids.push(Identifier::new(&raw).expect("32-byte identifier"));
    }
    let mut payload = vec![0u8; 256];
    rand::thread_rng().fill_bytes(&mut payload);

    let upload_all = || async {
        for id in &ids {
            writer.upload(batch, id, &payload, None).await?;
        }
        Ok::<(), bee::Error>(())
    };
    if is_warmup(p) {
        let _ = upload_all().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = upload_all().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok_with(out, (count * 256) as i64, format!("count={count}"))
}

// Retry the feed read for up to max_secs. On Sepolia with deferred uploads,
// /feeds can take 30-60s to find the just-written SOC because Bee's
// exponential search probes many indices. The timing INCLUDES retries —
// that's the honest wall-clock cost of "write+read a feed update".
async fn feed_read_with_retry(
    reader: &bee::file::FeedReader,
    max_secs: u64,
) -> Result<(), bee::Error> {
    let start = Instant::now();
    loop {
        match reader.download().await {
            Ok(_) => return Ok(()),
            Err(e) => {
                if start.elapsed().as_secs() >= max_secs {
                    return Err(e);
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

// ---------- net.feed.write-read.fresh ----------
pub async fn case_feed_fresh(p: &ParamEntry, client: &Client, batch: &BatchId) -> CaseOutcome {
    let one = || async {
        let mut tbytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut tbytes);
        let topic = Topic::new(&tbytes).expect("32-byte topic");
        let mut kbytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut kbytes);
        let signer = PrivateKey::new(&kbytes)?;
        let owner = signer.public_key()?.address();
        let writer = client.file().make_feed_writer(signer, topic.clone())?;
        writer.upload_payload(batch, b"bench-feed-update").await?;
        let reader = client.file().make_feed_reader(owner, topic);
        feed_read_with_retry(&reader, 120).await?;
        Ok::<(), bee::Error>(())
    };
    if is_warmup(p) {
        let _ = one().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = one().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok(out, 0)
}

// ---------- net.feed.write-read.warm ----------
pub async fn case_feed_warm(p: &ParamEntry, client: &Client, batch: &BatchId) -> CaseOutcome {
    let reads = int_param(p, "reads", 5) as usize;
    let mut tbytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut tbytes);
    let topic = Topic::new(&tbytes).expect("32-byte topic");
    let mut kbytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut kbytes);
    let signer = match PrivateKey::new(&kbytes) {
        Ok(k) => k,
        Err(e) => return CaseOutcome::skip(e.to_string()),
    };
    let owner = match signer.public_key() {
        Ok(p) => p.address(),
        Err(e) => return CaseOutcome::skip(e.to_string()),
    };
    let writer = match client.file().make_feed_writer(signer, topic.clone()) {
        Ok(w) => w,
        Err(e) => return CaseOutcome::skip(e.to_string()),
    };
    if let Err(e) = writer.upload_payload(batch, b"warm-init").await {
        return CaseOutcome::skip(e.to_string());
    }
    let reader = client.file().make_feed_reader(owner, topic);
    if let Err(e) = feed_read_with_retry(&reader, 120).await {
        return CaseOutcome::skip(format!("warm seed read: {e}"));
    }

    let many = || async {
        for _ in 0..reads {
            reader.download().await?;
        }
        Ok::<(), bee::Error>(())
    };
    if is_warmup(p) {
        let _ = many().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = many().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok_with(out, 0, format!("reads={reads}"))
}

// ---------- cpu.ecdsa.verify-1000 ----------
//
// Sign 1000 random digests once at setup, then per-iter recover the public
// key from each (digest, signature) pair. Verify under the eth-envelope is
// what feed reads do; the bee-js bigint pure-JS recover is the suspected
// pessimal case here.
pub async fn case_ecdsa_verify(p: &ParamEntry) -> CaseOutcome {
    let count = int_param(p, "count", 1000) as usize;
    let pk = PrivateKey::from_hex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
        .expect("valid hex");
    let mut digests = Vec::with_capacity(count);
    let mut sigs = Vec::with_capacity(count);
    for _ in 0..count {
        let mut d = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut d);
        let s = match pk.sign(&d) {
            Ok(s) => s,
            Err(e) => return CaseOutcome::skip(e.to_string()),
        };
        digests.push(d);
        sigs.push(s);
    }
    let count = if is_warmup(p) { (count / 10).max(50) } else { count };
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let (ms, _) = time_it(|| {
            for j in 0..count {
                let _ = sigs[j].recover_public_key(&digests[j]);
            }
        });
        out.push(ms);
    }
    CaseOutcome::ok_with(out, 0, format!("count={count}"))
}

// ---------- cpu.manifest.lookup-large ----------
//
// Build a Mantaray with N entries (outside timing), then time M random
// Find lookups per iter (mix of hits and misses).
pub async fn case_manifest_lookup_large(p: &ParamEntry) -> CaseOutcome {
    let entries = int_param(p, "entries", 5000) as usize;
    let lookups = int_param(p, "lookups", 1000) as usize;
    let mut dummy_ref_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut dummy_ref_bytes);
    let dummy_ref = match Reference::new(&dummy_ref_bytes) {
        Ok(r) => r,
        Err(e) => return CaseOutcome::skip(e.to_string()),
    };
    let mut root = MantarayNode::new();
    let paths: Vec<Vec<u8>> = (0..entries)
        .map(|i| format!("dir-{:03}/file-{:05}.bin", i % 32, i).into_bytes())
        .collect();
    for p in &paths {
        root.add_fork(p, Some(&dummy_ref), None);
    }
    let mut queries: Vec<Vec<u8>> = Vec::with_capacity(lookups);
    let mut buf = [0u8; 16];
    for i in 0..lookups {
        if i % 5 == 0 {
            rand::thread_rng().fill_bytes(&mut buf);
            queries.push(format!("nope-{:x}.bin", u64::from_le_bytes(buf[..8].try_into().unwrap())).into_bytes());
        } else {
            rand::thread_rng().fill_bytes(&mut buf[..2]);
            let idx = ((buf[0] as usize) << 8 | buf[1] as usize) % entries;
            queries.push(paths[idx].clone());
        }
    }
    if is_warmup(p) {
        for q in &queries {
            let _ = root.find(q);
        }
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let (ms, _) = time_it(|| {
            for q in &queries {
                let _ = root.find(q);
            }
        });
        out.push(ms);
    }
    CaseOutcome::ok_with(out, 0, format!("entries={entries} lookups={lookups}"))
}

// ---------- net.pin.add-list ----------
//
// Pre-upload N tiny content-addressed chunks once. Per iter: pin all N →
// list /pins → unpin all N. Per-call HTTP overhead, different endpoint
// shape than /stamps.
pub async fn case_pin_add_list(p: &ParamEntry, client: &Client, batch: &BatchId) -> CaseOutcome {
    let count = int_param(p, "count", 25) as usize;
    let mut refs: Vec<Reference> = Vec::with_capacity(count);
    for i in 0..count {
        let mut payload = vec![0u8; 64];
        let salt = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64)
            .wrapping_add(i as u64);
        payload[..8].copy_from_slice(&salt.to_be_bytes());
        rand::thread_rng().fill_bytes(&mut payload[8..]);
        let chunk = match make_content_addressed_chunk(&payload) {
            Ok(c) => c,
            Err(e) => return CaseOutcome::skip(e.to_string()),
        };
        let wire = chunk.data();
        if let Err(e) = client.file().upload_chunk(batch, Bytes::from(wire), None).await {
            return CaseOutcome::skip(format!("pre-upload chunk {i}: {e}"));
        }
        refs.push(chunk.address.clone());
    }
    let api = client.api();
    let run_one = || async {
        for r in &refs {
            api.pin(r).await?;
        }
        api.list_pins().await?;
        for r in &refs {
            api.unpin(r).await?;
        }
        Ok::<(), bee::Error>(())
    };
    if is_warmup(p) {
        let _ = run_one().await;
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        let start = Instant::now();
        let res = run_one().await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok_with(out, 0, format!("count={count}"))
}

// ---------- net.tags.upload-with-tag ----------
//
// POST /tags → upload via /bytes with Swarm-Tag header → GET /tags/<id>.
// Each iter creates a fresh tag. Compares against net.bytes.upload at the
// same size to surface tag-bookkeeping cost.
pub async fn case_tags_upload_with_tag(
    p: &ParamEntry,
    client: &Client,
    batch: &BatchId,
    fix: &Fixtures,
) -> CaseOutcome {
    let size_mb = int_param(p, "size_mb", 1) as usize;
    let buf = match fix.get(size_mb) {
        Some(b) => b,
        None => return CaseOutcome::skip(format!("fixture {size_mb}mb.bin missing")),
    };
    let mut salted = vec![0u8; 8 + buf.len()];
    salted[8..].copy_from_slice(buf);
    let api = client.api();
    let file = client.file();
    let total_bytes = salted.len() as i64;
    if is_warmup(p) {
        rand::thread_rng().fill_bytes(&mut salted[..8]);
        let body = Bytes::from(salted.clone());
        if let Ok(tag) = api.create_tag().await {
            let opts = RedundantUploadOptions {
                base: UploadOptions { tag: tag.uid, ..Default::default() },
                redundancy_level: None,
            };
            let _ = file.upload_data(batch, body, Some(&opts)).await;
            let _ = api.get_tag(tag.uid).await;
        }
        return CaseOutcome::ok(vec![], 0);
    }
    let iters = default_iters(p);
    let mut out = Vec::with_capacity(iters);
    for _ in 0..iters {
        rand::thread_rng().fill_bytes(&mut salted[..8]);
        let body = Bytes::from(salted.clone());
        let start = Instant::now();
        let res: Result<(), bee::Error> = async {
            let tag = api.create_tag().await?;
            let opts = RedundantUploadOptions {
                base: UploadOptions { tag: tag.uid, ..Default::default() },
                redundancy_level: None,
            };
            file.upload_data(batch, body, Some(&opts)).await?;
            api.get_tag(tag.uid).await?;
            Ok(())
        }
        .await;
        let ms = start.elapsed().as_micros() as f64 / 1000.0;
        if let Err(e) = res {
            return CaseOutcome::skip(e.to_string());
        }
        out.push(ms);
    }
    CaseOutcome::ok_with(out, total_bytes, format!("size_mb={size_mb}"))
}

// ---------- net.bzz.upload-from-disk (N/A for bee-rs) ----------
//
// bee-rs has no AsyncRead-based upload path: upload_file takes
// `impl Into<Bytes>` and buffers the entire payload. The case is excluded
// via runner_subset in bench-spec.json; this stub returns SKIP so the
// dispatch table stays uniform if someone removes the runner_subset.
#[allow(dead_code)]
pub async fn case_bzz_upload_from_disk(_p: &ParamEntry) -> CaseOutcome {
    CaseOutcome::skip("bee-rs has no streaming raw-bytes upload (upload_file buffers fully)")
}

// silence the unused PathBuf import while large case stays guarded
#[allow(dead_code)]
fn _silence_pathbuf() -> PathBuf { PathBuf::new() }

