// runner-js — bee-js benchmark runner.
//
// Reads ../bench-spec.json, runs each case sequentially, samples in-process
// peak RSS at 100ms intervals, emits results to ../results/js-<ts>.json.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { Worker } from 'node:worker_threads';

import { Bee, MantarayNode, MerkleTree, PrivateKey, Reference, Topic, Identifier } from '@ethersphere/bee-js';
// bee-js's package.json `exports` blocks subpath imports, so we reach into
// the dist via a filesystem-relative path. The runner lives at a fixed
// position next to ../../bee-js so this is unambiguous. We benchmark the same
// internal entry points bee-go and bee-rs do — anything else would not be
// apples-to-apples.
import { calculateChunkAddress } from '../../bee-js/dist/mjs/chunk/bmt.js';
import { hashDirectory } from '../../bee-js/dist/mjs/utils/chunk-stream.js';

const RUNNER_NAME = 'js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = findRepoRoot();
const SPEC_PATH = join(REPO_ROOT, 'bench-spec.json');
const FIX_DIR = join(REPO_ROOT, 'fixtures');
const RESULTS_DIR = join(REPO_ROOT, 'results');

main().catch(e => {
  console.error('runner-js: fatal', e);
  process.exit(1);
});

async function main() {
  const specRaw = readFileSync(SPEC_PATH);
  const specHash = 'sha256:' + createHash('sha256').update(specRaw).digest('hex');
  const spec = JSON.parse(specRaw);

  const beeUrl = process.env.BEE_URL || 'http://localhost:1633';
  const batchHex = process.env.BEE_BATCH_ID || '';
  const hasBatch = !!batchHex;
  if (!hasBatch) console.error('warn: BEE_BATCH_ID not set — net.* cases will be skipped');
  const largeEnabled = process.env.BENCH_LARGE === '1';

  const bee = new Bee(beeUrl);
  let beeVersion = 'unknown';
  try {
    const v = await bee.getVersions();
    beeVersion = v.beeVersion;
  } catch {}

  // Load fixtures into memory.
  const fixtures = loadFixtures(FIX_DIR, spec.sizes_mb, largeEnabled ? spec.large_size_mb : null);

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const outPath = join(RESULTS_DIR, `${RUNNER_NAME}-${stamp}.json`);

  const results = [];

  for (let i = 0; i < spec.cases.length; i++) {
    const c = spec.cases[i];
    const tag = `[${i + 1}/${spec.cases.length}]`;
    if (Array.isArray(c.runner_subset) && c.runner_subset.length && !c.runner_subset.includes(RUNNER_NAME)) {
      console.error(`${tag} skip ${c.id} (runner_subset excludes ${RUNNER_NAME})`);
      continue;
    }
    if (c.kind === 'net' && !hasBatch) {
      console.error(`${tag} skip ${c.id} (no BEE_BATCH_ID)`);
      results.push(skipResult(c.id, 'BEE_BATCH_ID not set'));
      continue;
    }
    const params = resolveParams(spec, c);
    for (const p of params) {
      if (isLargeParam(p) && !largeEnabled) continue;
      const label = paramLabel(p);
      console.error(`${tag} ${c.id} ${label} ...`);

      const warmupN = c.kind === 'cpu' ? (spec.warmup_cpu ?? 2) : (spec.warmup_net ?? 1);
      for (let w = 0; w < warmupN; w++) {
        const wp = { ...p, warmup: true };
        try { await runOne(c.id, wp, { bee, batchHex, fixtures, beeUrl }); } catch {}
      }

      const sampler = startRSSSampler(spec.rss_sample_interval_ms ?? 100);
      const cpuStart = process.cpuUsage();
      let outcome;
      try {
        outcome = await runOne(c.id, p, { bee, batchHex, fixtures, beeUrl });
      } catch (e) {
        outcome = { ms: [], bytesPerIter: 0, notes: 'SKIP: ' + (e?.message || String(e)) };
      }
      const cpuDelta = process.cpuUsage(cpuStart);
      const peak = sampler.stop();
      const r = finalize(c, p, outcome, peak, cpuDelta);
      logSummary(c.id, label, r);
      results.push(r);
    }
    if (spec.cooldown_between_cases_sec) await sleep(spec.cooldown_between_cases_sec * 1000);
  }

  const out = {
    runner: RUNNER_NAME,
    client_version: `bee-js ${readBeeJsVersion(REPO_ROOT)} (file:../../bee-js)`,
    bee_version: beeVersion,
    bench_spec_hash: specHash,
    started_at: startedAt,
    host: hostInfo(),
    bee_url: beeUrl,
    batch_id: batchHex,
    iters: spec.iters,
    results,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.error(`\nwrote ${outPath}`);
}

// ---------- case dispatch ----------

async function runOne(id, p, ctx) {
  switch (id) {
    case 'cpu.keccak.chunk-hash':       return caseKeccakChunkHash(p);
    case 'cpu.keccak.parallel':         return caseKeccakParallel(p);
    case 'cpu.identity.create':         return caseIdentityCreate(p);
    case 'net.bytes.head':               return caseBytesHead(p, ctx.bee, ctx.batchHex, ctx.beeUrl, ctx.fixtures);
    case 'net.bytes.download.range':     return caseBytesDownloadRange(p, ctx.bee, ctx.batchHex, ctx.beeUrl, ctx.fixtures);
    case 'cpu.keccak.bulk':             return caseKeccakBulk(p, ctx.fixtures);
    case 'cpu.bmt.file-root':           return caseBmtFileRoot(p, ctx.fixtures);
    case 'cpu.bmt.encrypted-file-root': return skip('no offline encryption-aware chunker API in bee-js');
    case 'cpu.ecdsa.sign-1000':         return caseEcdsaSign(p);
    case 'cpu.ecdsa.verify-1000':       return caseEcdsaVerify(p);
    case 'cpu.manifest.hash-50files':   return caseManifestHash50(p);
    case 'cpu.manifest.lookup-large':   return caseManifestLookupLarge(p);
    case 'net.stamps.list':             return caseStampsList(p, ctx.bee);
    case 'net.stamps.concurrent':       return caseStampsConcurrent(p, ctx.bee);
    case 'net.bzz.upload':              return caseBzzUpload(p, ctx.bee, ctx.batchHex, ctx.fixtures);
    case 'net.bzz.upload.encrypted':    return caseBzzUploadEncrypted(p, ctx.bee, ctx.batchHex, ctx.fixtures);
    case 'net.bzz.upload-from-disk':    return caseBzzUploadFromDisk(p, ctx.bee, ctx.batchHex);
    case 'net.bytes.upload':            return caseBytesUpload(p, ctx.bee, ctx.batchHex, ctx.fixtures);
    case 'net.bzz.download':            return caseBzzDownload(p, ctx.bee, ctx.batchHex, ctx.fixtures);
    case 'net.chunks.upload':           return caseChunksUpload(p, ctx.bee, ctx.batchHex);
    case 'net.stream-dir.upload':       return caseStreamDirUpload(p, ctx.bee, ctx.batchHex);
    case 'net.soc.upload':              return caseSocUpload(p, ctx.bee, ctx.batchHex);
    case 'net.pin.add-list':            return casePinAddList(p, ctx.bee, ctx.batchHex);
    case 'net.tags.upload-with-tag':    return caseTagsUploadWithTag(p, ctx.bee, ctx.batchHex, ctx.fixtures);
    case 'net.feed.write-read.fresh':   return caseFeedFresh(p, ctx.bee, ctx.batchHex);
    case 'net.feed.write-read.warm':    return caseFeedWarm(p, ctx.bee, ctx.batchHex);
    default:                            return skip('not implemented yet');
  }
}

// ---------- cpu.keccak.chunk-hash ----------
async function caseKeccakChunkHash(p) {
  let count = intParam(p, 'count', 10000);
  const chunkBytes = intParam(p, 'chunk_bytes', 4096);
  const buf = new Uint8Array(8 + chunkBytes);
  // span = chunkBytes (LE)
  new DataView(buf.buffer).setBigUint64(0, BigInt(chunkBytes), true);
  for (let j = 8; j < buf.length; j++) buf[j] = (Math.random() * 256) | 0;

  if (p.warmup) count = Math.max(Math.floor(count / 100), 100);
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    for (let j = 0; j < count; j++) calculateChunkAddress(buf);
    out.push(performance.now() - start);
  }
  return ok(out, count * chunkBytes, `count=${count} chunk_bytes=${chunkBytes}`);
}

// ---------- cpu.keccak.parallel ----------
//
// Distribute count BMT chunk hashes across W = availableParallelism() Node
// Worker threads. Each worker generates + hashes its own slice locally
// (no postMessage of payloads). Time = wall clock to all workers complete.
// Worker pool is reused across iters so per-iter spawn cost doesn't dominate.
async function caseKeccakParallel(p) {
  let count = intParam(p, 'count', 10000);
  const chunkBytes = intParam(p, 'chunk_bytes', 4096);
  const workers = (typeof os.availableParallelism === 'function') ? os.availableParallelism() : os.cpus().length;

  if (p.warmup) count = Math.max(Math.floor(count / 100), 100);
  const iters = defaultIters(p);

  const perWorker = Math.ceil(count / workers);
  const workerURL = new URL('./keccak-worker.mjs', import.meta.url);

  const pool = [];
  for (let w = 0; w < workers; w++) pool.push(new Worker(workerURL));

  try {
    const burst = () => {
      const promises = [];
      for (let w = 0; w < workers; w++) {
        const start = w * perWorker;
        if (start >= count) break;
        const end = Math.min(start + perWorker, count);
        const n = end - start;
        const worker = pool[w];
        promises.push(new Promise((resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error', reject);
          worker.postMessage({ chunkBytes, count: n });
        }));
      }
      return Promise.all(promises);
    };

    // warmup the pool itself (V8 / module load) once
    await burst();

    const out = [];
    for (let i = 0; i < iters; i++) {
      const start = performance.now();
      await burst();
      out.push(performance.now() - start);
    }
    return okWith(out, count * chunkBytes, `count=${count} workers=${workers}`);
  } finally {
    await Promise.all(pool.map(w => w.terminate()));
  }
}

// ---------- cpu.identity.create ----------
//
// Generate N fresh secp256k1 identities: random 32 bytes → PrivateKey →
// derive public key → derive Ethereum address. Same crypto-backend story
// as cpu.ecdsa.sign-1000.
async function caseIdentityCreate(p) {
  let count = intParam(p, 'count', 1000);
  if (p.warmup) count = Math.max(Math.floor(count / 100), 100);
  const iters = defaultIters(p);
  const out = [];
  const { randomFillSync } = await import('node:crypto');
  const b = new Uint8Array(32);
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    for (let j = 0; j < count; j++) {
      randomFillSync(b);
      try {
        const k = new PrivateKey(b);
        k.publicKey().address();
      } catch {}
    }
    out.push(performance.now() - start);
  }
  return okWith(out, 0, `count=${count}`);
}

// ---------- cpu.keccak.bulk ----------
async function caseKeccakBulk(p, fix) {
  const sizeMB = intParam(p, 'size_mb', 100);
  const buf = fix.get(sizeMB);
  if (!buf) return skip(`fixture ${sizeMB}mb.bin missing`);
  // bee-js doesn't expose a public keccak256 helper; use cafe-utility via MerkleTree.NOOP
  // path. Simpler approach: import cafe-utility's Binary directly. The dependency
  // is installed alongside bee-js so it resolves cleanly.
  const { Binary } = await import('cafe-utility');
  if (p.warmup) { Binary.keccak256(buf); return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    Binary.keccak256(buf);
    out.push(performance.now() - start);
  }
  return ok(out, buf.length);
}

// ---------- cpu.bmt.file-root ----------
async function caseBmtFileRoot(p, fix) {
  const sizeMB = intParam(p, 'size_mb', 0);
  if (!sizeMB) return skip('missing size_mb');
  const buf = fix.get(sizeMB);
  if (!buf) return skip(`fixture ${sizeMB}mb.bin missing`);
  const runOne = async () => {
    const tree = new MerkleTree(MerkleTree.NOOP);
    await tree.append(buf);
    const root = await tree.finalize();
    return root.hash();
  };
  if (p.warmup) { await runOne(); return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    await runOne();
    out.push(performance.now() - start);
  }
  return ok(out, buf.length);
}

// ---------- cpu.ecdsa.sign-1000 ----------
async function caseEcdsaSign(p) {
  let count = intParam(p, 'count', 1000);
  const pk = new PrivateKey('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
  const digest = new Uint8Array(32);
  for (let i = 0; i < 32; i++) digest[i] = (Math.random() * 256) | 0;
  if (p.warmup) count = Math.max(Math.floor(count / 10), 50);
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    for (let j = 0; j < count; j++) pk.sign(digest);
    out.push(performance.now() - start);
  }
  return okWith(out, 0, `count=${count}`);
}

// ---------- cpu.manifest.hash-50files ----------
async function caseManifestHash50(p) {
  const files = intParam(p, 'files', 50);
  const fileBytes = intParam(p, 'file_bytes', 1024);
  // bee-js's hashDirectory takes a path. Build a deterministic temp dir tree
  // so we can call hashDirectory the same way bee-rs/bee-go's HashCollectionEntries
  // gets invoked. This is the closest like-for-like.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const tmp = mkdtempSync(join((await import('node:os')).tmpdir(), 'bee-bench-'));
  try {
    for (let i = 0; i < files; i++) {
      const data = new Uint8Array(fileBytes);
      for (let j = 0; j < fileBytes; j++) data[j] = (Math.random() * 256) | 0;
      writeFileSync(join(tmp, `file-${String(i).padStart(4,'0')}.bin`), data);
    }
    const runOne = async () => { await hashDirectory(tmp); };
    if (p.warmup) { await runOne(); return ok([], 0); }
    const iters = defaultIters(p);
    const out = [];
    for (let i = 0; i < iters; i++) {
      const start = performance.now();
      await runOne();
      out.push(performance.now() - start);
    }
    return okWith(out, files * fileBytes, `files=${files} bytes_each=${fileBytes}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- net.stamps.list ----------
async function caseStampsList(p, bee) {
  if (p.warmup) { try { await bee.getPostageBatches(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await bee.getPostageBatches(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return ok(out, 0);
}

// ---------- net.stamps.concurrent ----------
//
// Fire N parallel GET /stamps. Bee returns instantly; spread across runners
// is pure HTTP-client overhead — connection pool, keepalive default, async
// dispatch. Per iter measures total burst time.
async function caseStampsConcurrent(p, bee) {
  const count = intParam(p, 'count', 200);
  const burst = async () => {
    const ps = [];
    for (let i = 0; i < count; i++) ps.push(bee.getPostageBatches());
    await Promise.all(ps);
  };
  if (p.warmup) { try { await burst(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await burst(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return okWith(out, 0, `count=${count}`);
}

// ---------- net.bytes.head ----------
//
// Pre-upload via /bytes once, then time N HEAD calls (no body). Uses Node's
// built-in fetch (undici). Isolates HTTP-stack cost.
async function caseBytesHead(p, bee, batchHex, beeURL, fix) {
  const count = intParam(p, 'count', 100);
  const buf = fix.get(1);
  if (!buf) return skip('fixture 1mb.bin missing');
  const salted = new Uint8Array(8 + buf.length);
  salted.set(buf, 8);
  for (let i = 0; i < 8; i++) salted[i] = (Math.random() * 256) | 0;
  let ref;
  try {
    const up = await bee.uploadData(batchHex, salted);
    ref = up.reference;
  } catch (e) { return skip('pre-upload: ' + (e?.message || String(e))); }
  const url = `${beeURL.replace(/\/+$/, '')}/bytes/${ref}`;
  const burst = async () => {
    for (let i = 0; i < count; i++) {
      const r = await fetch(url, { method: 'HEAD' });
      if (!r.ok) throw new Error(`HEAD ${url}: ${r.status}`);
    }
  };
  if (p.warmup) { try { await burst(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await burst(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return okWith(out, 0, `count=${count}`);
}

// ---------- net.bytes.download.range ----------
//
// Pre-upload 100MB via /bytes, then time GET with `Range: bytes=0-...`
// for a 1MB slice.
async function caseBytesDownloadRange(p, bee, batchHex, beeURL, fix) {
  const sliceMB = intParam(p, 'slice_mb', 1);
  const buf = fix.get(100);
  if (!buf) return skip('fixture 100mb.bin missing');
  const salted = new Uint8Array(8 + buf.length);
  salted.set(buf, 8);
  for (let i = 0; i < 8; i++) salted[i] = (Math.random() * 256) | 0;
  let ref;
  try {
    const up = await bee.uploadData(batchHex, salted);
    ref = up.reference;
  } catch (e) { return skip('pre-upload: ' + (e?.message || String(e))); }
  const url = `${beeURL.replace(/\/+$/, '')}/bytes/${ref}`;
  const sliceBytes = sliceMB * 1024 * 1024;
  const range = `bytes=0-${sliceBytes - 1}`;
  const drain = async () => {
    const r = await fetch(url, { headers: { Range: range } });
    if (!r.ok && r.status !== 206) throw new Error(`GET range ${url}: ${r.status}`);
    const reader = r.body.getReader();
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
    }
    return total;
  };
  if (p.warmup) { try { await drain(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await drain(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return okWith(out, sliceBytes, `slice_mb=${sliceMB}`);
}

// ---------- net.bzz.upload (POST /bzz with manifest) ----------
async function caseBzzUpload(p, bee, batchHex, fix) {
  return runUploadFile(p, bee, batchHex, fix, undefined);
}

// ---------- net.bzz.upload.encrypted ----------
async function caseBzzUploadEncrypted(p, bee, batchHex, fix) {
  return runUploadFile(p, bee, batchHex, fix, { encrypt: true });
}

async function runUploadFile(p, bee, batchHex, fix, opts) {
  const sizeMB = intParam(p, 'size_mb', 0);
  if (!sizeMB) return skip('missing size_mb');
  const buf = fix.get(sizeMB);
  if (!buf) return skip(`fixture ${sizeMB}mb.bin missing`);
  const salted = new Uint8Array(8 + buf.length);
  salted.set(buf, 8);
  const fillSalt = () => {
    for (let i = 0; i < 8; i++) salted[i] = (Math.random() * 256) | 0;
  };
  if (p.warmup) {
    fillSalt();
    try { await bee.uploadFile(batchHex, salted, 'bench.bin', opts); } catch {}
    return ok([], 0);
  }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    fillSalt();
    const start = performance.now();
    try { await bee.uploadFile(batchHex, salted, 'bench.bin', opts); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return ok(out, salted.length);
}

// ---------- net.bzz.upload-from-disk ----------
//
// Stream a 1GB fixture from disk via fs.createReadStream → bee.uploadFile.
// Tests genuine streaming (no in-memory buffering).
async function caseBzzUploadFromDisk(p, bee, batchHex) {
  const sizeMB = intParam(p, 'size_mb', 1024);
  const fs = await import('node:fs');
  const path = join(REPO_ROOT, 'fixtures', `${sizeMB}mb.bin`);
  try { fs.statSync(path); } catch { return skip(`fixture ${sizeMB}mb.bin missing`); }
  const runOne = async () => {
    const stream = fs.createReadStream(path);
    await bee.uploadFile(batchHex, stream, 'bench.bin');
  };
  if (p.warmup) { try { await runOne(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await runOne(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return ok(out, sizeMB * 1024 * 1024);
}

// ---------- net.bytes.upload (POST /bytes raw) ----------
async function caseBytesUpload(p, bee, batchHex, fix) {
  const sizeMB = intParam(p, 'size_mb', 0);
  if (!sizeMB) return skip('missing size_mb');
  const buf = fix.get(sizeMB);
  if (!buf) return skip(`fixture ${sizeMB}mb.bin missing`);
  const salted = new Uint8Array(8 + buf.length);
  salted.set(buf, 8);
  const fillSalt = () => {
    for (let i = 0; i < 8; i++) salted[i] = (Math.random() * 256) | 0;
  };
  if (p.warmup) {
    fillSalt();
    try { await bee.uploadData(batchHex, salted); } catch {}
    return ok([], 0);
  }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    fillSalt();
    const start = performance.now();
    try { await bee.uploadData(batchHex, salted); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return ok(out, salted.length);
}

// ---------- net.bzz.download ----------
//
// Pre-upload via /bzz, then time GET /bzz/<ref> with body drained via the
// readable stream (no full-buffer alloc).
async function caseBzzDownload(p, bee, batchHex, fix) {
  const sizeMB = intParam(p, 'size_mb', 0);
  if (!sizeMB) return skip('missing size_mb');
  const buf = fix.get(sizeMB);
  if (!buf) return skip(`fixture ${sizeMB}mb.bin missing`);
  const salted = new Uint8Array(8 + buf.length);
  salted.set(buf, 8);
  for (let i = 0; i < 8; i++) salted[i] = (Math.random() * 256) | 0;
  let ref;
  try {
    const up = await bee.uploadFile(batchHex, salted, 'bench.bin');
    ref = up.reference;
  } catch (e) { return skip('pre-upload: ' + (e?.message || String(e))); }

  const drain = async () => {
    const fd = await bee.downloadReadableFile(ref);
    let total = 0;
    for await (const chunk of fd.data) {
      total += chunk.length;
    }
    return total;
  };
  if (p.warmup) { try { await drain(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await drain(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return ok(out, salted.length);
}

// ---------- net.chunks.upload ----------
async function caseChunksUpload(p, bee, batchHex) {
  let count = intParam(p, 'count', 1000);
  if (p.warmup) count = Math.max(Math.floor(count / 10), 50);
  // Build N CACs locally via the internal makeContentAddressedChunk path.
  const { makeContentAddressedChunk } = await import('../../bee-js/dist/mjs/chunk/cac.js');
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const payload = new Uint8Array(256);
    new DataView(payload.buffer).setBigUint64(0, BigInt(i), false);
    for (let j = 8; j < 256; j++) payload[j] = (Math.random() * 256) | 0;
    const c = makeContentAddressedChunk(payload);
    // wire form = span (8) || payload
    const wire = new Uint8Array(8 + payload.length);
    wire.set(c.span, 0);
    wire.set(payload, 8);
    chunks.push(wire);
  }
  const uploadAll = async () => {
    for (const wire of chunks) {
      await bee.uploadChunk(batchHex, wire);
    }
  };
  if (p.warmup) { try { await uploadAll(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await uploadAll(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return okWith(out, count * 256, `count=${count}`);
}

// ---------- net.stream-dir.upload ----------
async function caseStreamDirUpload(p, bee, batchHex) {
  const files = intParam(p, 'files', 50);
  const fileBytes = intParam(p, 'file_bytes', 8192);
  const buildEntries = (saltN) => {
    const out = [];
    for (let i = 0; i < files; i++) {
      const data = new Uint8Array(fileBytes);
      new DataView(data.buffer).setBigUint64(0, BigInt(saltN), false);
      new DataView(data.buffer).setBigUint64(8, BigInt(i), false);
      for (let j = 16; j < fileBytes; j++) data[j] = (Math.random() * 256) | 0;
      out.push({ path: `file-${String(i).padStart(4,'0')}.bin`, data });
    }
    return out;
  };
  const uploadOne = async () => {
    const salt = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    const entries = buildEntries(salt);
    // bee.streamDirectory takes (batchId, dir | files) — dir is filesystem-only.
    // We need the in-memory variant: streamDirectory expects a path. So write
    // entries to a temp dir and stream from there (the JS variant doesn't have
    // an "entries" overload that bee-go and bee-rs offer).
    const fs = await import('node:fs');
    const osmod = await import('node:os');
    const tmp = fs.mkdtempSync(join(osmod.tmpdir(), 'bee-bench-'));
    try {
      for (const e of entries) fs.writeFileSync(join(tmp, e.path), e.data);
      await bee.streamDirectory(batchHex, tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
  if (p.warmup) { try { await uploadOne(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await uploadOne(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return okWith(out, files * fileBytes, `files=${files} bytes_each=${fileBytes}`);
}

// ---------- net.soc.upload ----------
async function caseSocUpload(p, bee, batchHex) {
  let count = intParam(p, 'count', 100);
  if (p.warmup) count = Math.max(Math.floor(count / 10), 10);
  const signer = new PrivateKey('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
  const writer = bee.makeSOCWriter(signer);

  // Pre-build identifiers
  const nonce = new Uint8Array(8);
  for (let i = 0; i < 8; i++) nonce[i] = (Math.random() * 256) | 0;
  const ids = [];
  for (let i = 0; i < count; i++) {
    const raw = new Uint8Array(32);
    raw.set(nonce, 0);
    new DataView(raw.buffer).setBigUint64(8, BigInt(i), false);
    ids.push(new Identifier(raw));
  }
  const payload = new Uint8Array(256);
  for (let i = 0; i < 256; i++) payload[i] = (Math.random() * 256) | 0;

  const uploadAll = async () => {
    for (const id of ids) {
      await writer.upload(batchHex, id, payload);
    }
  };
  if (p.warmup) { try { await uploadAll(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await uploadAll(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return okWith(out, count * payload.length, `count=${count}`);
}

// On Sepolia with deferred uploads, /feeds can take 30-60s while Bee's
// exponential search probes indices. Timing INCLUDES retries — that's
// the honest wall-clock cost.
async function feedReadWithRetry(reader, maxSecs) {
  const deadline = performance.now() + maxSecs * 1000;
  let lastErr;
  for (;;) {
    try { return await reader.download(); }
    catch (e) { lastErr = e; }
    if (performance.now() >= deadline) throw lastErr;
    await new Promise(r => setTimeout(r, 500));
  }
}

// ---------- net.feed.write-read.fresh ----------
async function caseFeedFresh(p, bee, batchHex) {
  const one = async () => {
    const tBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) tBytes[i] = (Math.random() * 256) | 0;
    const topic = new Topic(tBytes);
    const kBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) kBytes[i] = (Math.random() * 256) | 0;
    const signer = new PrivateKey(kBytes);
    const owner = signer.publicKey().address();
    const writer = bee.makeFeedWriter(topic, signer);
    await writer.uploadPayload(batchHex, new TextEncoder().encode('bench-feed-update'));
    const reader = bee.makeFeedReader(topic, owner);
    await feedReadWithRetry(reader, 120);
  };
  if (p.warmup) { try { await one(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await one(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return ok(out, 0);
}

// ---------- net.feed.write-read.warm ----------
async function caseFeedWarm(p, bee, batchHex) {
  const reads = intParam(p, 'reads', 5);
  const tBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) tBytes[i] = (Math.random() * 256) | 0;
  const topic = new Topic(tBytes);
  const kBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) kBytes[i] = (Math.random() * 256) | 0;
  const signer = new PrivateKey(kBytes);
  const owner = signer.publicKey().address();
  const writer = bee.makeFeedWriter(topic, signer);
  try { await writer.uploadPayload(batchHex, new TextEncoder().encode('warm-init')); }
  catch (e) { return skip('seed write: ' + (e?.message || String(e))); }
  const reader = bee.makeFeedReader(topic, owner);
  // Wait until the first read succeeds (Bee's /feeds endpoint can take
  // 30-60s on Sepolia for a freshly-written feed).
  try { await feedReadWithRetry(reader, 120); }
  catch (e) { return skip('warm seed read: ' + (e?.message || String(e))); }

  const many = async () => {
    for (let i = 0; i < reads; i++) {
      await reader.download();
    }
  };
  if (p.warmup) { try { await many(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await many(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return okWith(out, 0, `reads=${reads}`);
}

// ---------- cpu.ecdsa.verify-1000 ----------
//
// Sign 1000 random digests once at setup, then per-iter recover the public
// key from each (digest, signature) pair. Recover under the eth-envelope is
// what feed reads do; pure-JS bigint is the suspected pessimal case.
async function caseEcdsaVerify(p) {
  let count = intParam(p, 'count', 1000);
  const pk = new PrivateKey('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
  const digests = [];
  const sigs = [];
  for (let i = 0; i < count; i++) {
    const d = new Uint8Array(32);
    for (let j = 0; j < 32; j++) d[j] = (Math.random() * 256) | 0;
    digests.push(d);
    sigs.push(pk.sign(d));
  }
  if (p.warmup) count = Math.max(Math.floor(count / 10), 50);
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    for (let j = 0; j < count; j++) sigs[j].recoverPublicKey(digests[j]);
    out.push(performance.now() - start);
  }
  return okWith(out, 0, `count=${count}`);
}

// ---------- cpu.manifest.lookup-large ----------
//
// Build a Mantaray with N entries (outside timing), then time M random Find
// lookups per iter (mix of hits and misses). Trie traversal hot path.
async function caseManifestLookupLarge(p) {
  const entries = intParam(p, 'entries', 5000);
  const lookups = intParam(p, 'lookups', 1000);
  const dummyRefBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) dummyRefBytes[i] = (Math.random() * 256) | 0;
  const dummyRef = new Reference(dummyRefBytes);
  const root = new MantarayNode();
  const paths = [];
  for (let i = 0; i < entries; i++) {
    const path = `dir-${String(i % 32).padStart(3, '0')}/file-${String(i).padStart(5, '0')}.bin`;
    paths.push(path);
    root.addFork(path, dummyRef);
  }
  const queries = [];
  for (let i = 0; i < lookups; i++) {
    if (i % 5 === 0) {
      queries.push(`nope-${Math.floor(Math.random() * 1e16).toString(16)}.bin`);
    } else {
      queries.push(paths[Math.floor(Math.random() * entries)]);
    }
  }
  if (p.warmup) {
    for (const q of queries) root.find(q);
    return ok([], 0);
  }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    for (const q of queries) root.find(q);
    out.push(performance.now() - start);
  }
  return okWith(out, 0, `entries=${entries} lookups=${lookups}`);
}

// ---------- net.pin.add-list ----------
//
// Pre-upload N tiny payloads via /bytes (each becomes a single chunk →
// unique ref). Per iter: pin all N → list /pins → unpin all N. Per-call
// HTTP overhead on a different endpoint shape than /stamps.
async function casePinAddList(p, bee, batchHex) {
  const count = intParam(p, 'count', 25);
  const refs = [];
  for (let i = 0; i < count; i++) {
    const payload = new Uint8Array(64);
    new DataView(payload.buffer).setBigUint64(0, BigInt(Date.now()) * 1000n + BigInt(i), false);
    for (let j = 8; j < 64; j++) payload[j] = (Math.random() * 256) | 0;
    try {
      const up = await bee.uploadData(batchHex, payload);
      refs.push(up.reference);
    } catch (e) {
      return skip(`pre-upload chunk ${i}: ${e?.message || String(e)}`);
    }
  }
  const runOne = async () => {
    for (const r of refs) await bee.pin(r);
    await bee.getAllPins();
    for (const r of refs) await bee.unpin(r);
  };
  if (p.warmup) { try { await runOne(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await runOne(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return okWith(out, 0, `count=${count}`);
}

// ---------- net.tags.upload-with-tag ----------
//
// POST /tags → uploadData with { tag } option → retrieveTag. Each iter
// creates a fresh tag. Compares against net.bytes.upload at the same size
// to surface tag-bookkeeping cost.
async function caseTagsUploadWithTag(p, bee, batchHex, fix) {
  const sizeMB = intParam(p, 'size_mb', 1);
  const buf = fix.get(sizeMB);
  if (!buf) return skip(`fixture ${sizeMB}mb.bin missing`);
  const salted = new Uint8Array(8 + buf.length);
  salted.set(buf, 8);
  const runOne = async () => {
    for (let i = 0; i < 8; i++) salted[i] = (Math.random() * 256) | 0;
    const tag = await bee.createTag();
    await bee.uploadData(batchHex, salted, { tag: tag.uid });
    await bee.retrieveTag(tag.uid);
  };
  if (p.warmup) { try { await runOne(); } catch {} return ok([], 0); }
  const iters = defaultIters(p);
  const out = [];
  for (let i = 0; i < iters; i++) {
    const start = performance.now();
    try { await runOne(); }
    catch (e) { return skip(e?.message || String(e)); }
    out.push(performance.now() - start);
  }
  return okWith(out, salted.length, `size_mb=${sizeMB}`);
}

// ---------- helpers ----------

function ok(ms, bytes) { return { ms, bytesPerIter: bytes, notes: '' }; }
function okWith(ms, bytes, notes) { return { ms, bytesPerIter: bytes, notes }; }
function skip(reason) { return { ms: [], bytesPerIter: 0, notes: 'SKIP: ' + reason }; }

function intParam(p, key, dflt) {
  const v = p?.[key];
  return typeof v === 'number' ? v : dflt;
}
function defaultIters(p) {
  const env = parseInt(process.env.BENCH_ITERS, 10);
  if (Number.isFinite(env) && env > 0) return env;
  if (typeof p?.iters_override === 'number' && p.iters_override > 0) return p.iters_override;
  return 5;
}

function loadFixtures(dir, sizes, large) {
  const map = new Map();
  for (const mb of sizes) {
    try {
      const path = join(dir, `${mb}mb.bin`);
      map.set(mb, readFileSync(path));
    } catch {
      console.error(`warn: fixture ${mb}mb.bin missing`);
    }
  }
  if (large) {
    try {
      map.set(large, readFileSync(join(dir, `${large}mb.bin`)));
    } catch {
      console.error(`warn: large fixture ${large}mb.bin missing`);
    }
  }
  return { get: (mb) => map.get(mb) };
}

function isLargeParam(p) {
  if (p?.large === true) return true;
  if (typeof p?.size_mb === 'number' && p.size_mb >= 1024) return true;
  return false;
}

function paramLabel(p) {
  if (!p || Object.keys(p).length === 0) return '';
  if (p.size_mb != null) return `size_mb=${p.size_mb}`;
  if (p.count != null) return `count=${p.count}`;
  if (p.files != null) return `files=${p.files}`;
  return '';
}

function resolveParams(spec, c) {
  if (Array.isArray(c.params) && c.params.length) return c.params;
  if (c.params_from && spec.param_sets?.[c.params_from]) return spec.param_sets[c.params_from];
  return [{}];
}

function startRSSSampler(intervalMs) {
  let peak = process.memoryUsage.rss();
  const handle = setInterval(() => {
    const cur = process.memoryUsage.rss();
    if (cur > peak) peak = cur;
  }, Math.max(intervalMs, 20));
  return {
    stop() {
      clearInterval(handle);
      const cur = process.memoryUsage.rss();
      if (cur > peak) peak = cur;
      return peak / (1024 * 1024);
    },
  };
}

function finalize(caseSpec, p, outcome, peakMB, cpuDelta) {
  const r = {
    case: caseSpec.id,
    param: p,
    iters_ms: [],
    median_ms: 0,
    min_ms: 0,
    max_ms: 0,
    mean_ms: 0,
    peak_rss_mb: round(peakMB, 1),
    notes: '',
  };
  if (cpuDelta) {
    r.cpu_user_ms = round((cpuDelta.user || 0) / 1000, 2);
    r.cpu_sys_ms = round((cpuDelta.system || 0) / 1000, 2);
  }
  if (!outcome.ms.length) {
    r.skipped = true;
    if (outcome.notes?.startsWith('SKIP: ')) r.skip_reason = outcome.notes.slice(6);
    else r.skip_reason = outcome.notes || 'no iterations recorded';
    return r;
  }
  r.iters_ms = outcome.ms.map(v => round(v, 3));
  const sorted = [...outcome.ms].sort((a, b) => a - b);
  r.min_ms = round(sorted[0], 3);
  r.max_ms = round(sorted[sorted.length - 1], 3);
  r.median_ms = round(
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    3,
  );
  r.mean_ms = round(outcome.ms.reduce((a, b) => a + b, 0) / outcome.ms.length, 3);
  if (outcome.bytesPerIter > 0) {
    const mb = outcome.bytesPerIter / (1024 * 1024);
    r.throughput_mbps = round(mb / (r.median_ms / 1000), 2);
  }
  r.notes = outcome.notes || '';
  return r;
}

function skipResult(id, reason) {
  return { case: id, param: {}, iters_ms: [], median_ms: 0, min_ms: 0, max_ms: 0, mean_ms: 0, peak_rss_mb: 0, skipped: true, skip_reason: reason, notes: '' };
}

function logSummary(_id, label, r) {
  if (r.skipped) { console.error(`  → SKIP: ${r.skip_reason}`); return; }
  const tp = r.throughput_mbps != null ? ` (${r.throughput_mbps.toFixed(2)} MB/s)` : '';
  console.error(
    `  → median ${r.median_ms.toFixed(2)}ms (min ${r.min_ms.toFixed(2)}, max ${r.max_ms.toFixed(2)})${tp} rss=${r.peak_rss_mb.toFixed(1)}MB  [${label}]`,
  );
}

function hostInfo() {
  let cpu = '';
  try {
    const lines = readFileSync('/proc/cpuinfo', 'utf8').split('\n');
    const m = lines.find(l => l.startsWith('model name'));
    if (m) cpu = m.split(':')[1].trim();
  } catch {}
  const numCPU = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return { os: process.platform, arch: process.arch, cpu, num_cpu: numCPU };
}

function round(v, p) {
  const m = Math.pow(10, p);
  return Math.round(v * m) / m;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function findRepoRoot() {
  let dir = resolve(__dirname);
  for (let i = 0; i < 6; i++) {
    try { statSync(join(dir, 'bench-spec.json')); return dir; } catch {}
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('bench-spec.json not found at or above ' + __dirname);
}

// Read the version field from the sibling bee-js package.json so the
// result JSON records which client version produced the run.
function readBeeJsVersion(repoRoot) {
  try {
    const pkgPath = join(dirname(repoRoot), 'bee-js', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}
