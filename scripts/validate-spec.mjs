#!/usr/bin/env node
// Validate that the latest per-runner result JSON for each runner actually
// emits a row for every case in bench-spec.json — and only those cases.
//
// Usage:
//   node scripts/validate-spec.mjs
//
// Exits 0 if every runner covers the spec exactly (skipped rows count as
// covered). Exits 1 with a diff otherwise. Useful after adding a new case
// to confirm all three runners implemented it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SPEC_PATH = join(REPO_ROOT, 'bench-spec.json');
const RESULTS_DIR = join(REPO_ROOT, 'results');
const RUNNER_ORDER = ['go', 'rs', 'js'];

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
const specCases = new Set((spec.cases || []).map(c => c.id));

if (specCases.size === 0) {
  console.error('bench-spec.json has no cases — nothing to validate');
  process.exit(1);
}

const latestByRunner = pickLatestPerRunner(RESULTS_DIR);

let problems = 0;
for (const runner of RUNNER_ORDER) {
  const run = latestByRunner[runner];
  if (!run) {
    console.warn(`[${runner}] no result JSON found in results/ — run ./scripts/run-all.sh first`);
    problems += 1;
    continue;
  }
  const emitted = new Set(run.results.map(r => r.case));
  const skipped = new Set(run.results.filter(r => r.skipped).map(r => r.case));
  const missing = [...specCases].filter(c => !emitted.has(c)).sort();
  const extra = [...emitted].filter(c => !specCases.has(c)).sort();
  const skippedList = [...skipped].sort();
  const hashLabel = run.bench_spec_hash || '(no hash)';

  console.log(`[${runner}]  ${run._file.split('/').pop()}`);
  console.log(`  emits: ${emitted.size}/${specCases.size} cases · skipped: ${skipped.size} · spec-hash: ${hashLabel}`);
  if (missing.length) {
    console.log(`  ⚠ missing (${missing.length}):`);
    for (const c of missing) console.log(`      - ${c}`);
    problems += missing.length;
  }
  if (extra.length) {
    console.log(`  ⚠ extra (not in spec) (${extra.length}):`);
    for (const c of extra) console.log(`      + ${c}`);
    problems += extra.length;
  }
  if (skippedList.length) {
    console.log(`  skips (intentional):`);
    for (const c of skippedList) {
      const r = run.results.find(rr => rr.case === c && rr.skipped);
      console.log(`      ~ ${c}  — ${r?.skip_reason || ''}`);
    }
  }
  console.log();
}

const hashes = new Set(Object.values(latestByRunner).map(r => r.bench_spec_hash).filter(Boolean));
if (hashes.size > 1) {
  console.error(`⚠ runners disagree on bench_spec_hash (${hashes.size} distinct values) — re-run all three with the same spec`);
  problems += 1;
}

if (problems > 0) {
  console.error(`FAIL: ${problems} coverage problem(s).`);
  process.exit(1);
}
console.log('OK: all runners cover the spec exactly.');

function pickLatestPerRunner(dir) {
  let files;
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'aggregate.json' && !f.startsWith('report'));
  } catch {
    console.error(`results dir not found: ${dir}`);
    process.exit(1);
  }
  const out = {};
  for (const f of files) {
    const path = join(dir, f);
    let r;
    try { r = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    if (!r || !r.runner || !Array.isArray(r.results)) continue;
    r._file = path;
    r._mtime = statSync(path).mtimeMs;
    if (!out[r.runner] || r._mtime > out[r.runner]._mtime) out[r.runner] = r;
  }
  return out;
}
