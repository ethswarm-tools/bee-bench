#!/usr/bin/env node
// Export results/aggregate.json to a flat CSV for spreadsheet / pandas analysis.
//
// Usage:
//   node scripts/export-csv.mjs [--in <aggregate.json>] [--out <file.csv>]
//
// One row per (case, param, runner) tuple. Skipped runners are emitted with
// blank metric columns and the skip_reason in the `notes` column.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const IN = args.in || join(REPO_ROOT, 'results', 'aggregate.json');
const OUT = args.out || join(REPO_ROOT, 'results', 'report.csv');

const RUNNER_ORDER = ['go', 'rs', 'js'];

const agg = JSON.parse(readFileSync(IN, 'utf8'));

const HEADERS = [
  'case', 'param', 'runner',
  'iters', 'median_ms', 'mean_ms', 'min_ms', 'max_ms',
  'stddev_ms', 'cv_pct', 'range_pct', 'p95_ms',
  'throughput_mbps', 'peak_rss_mb',
  'cpu_user_ms', 'cpu_sys_ms', 'cpu_wall_ratio',
  'ratio_to_best', 'is_best', 'skipped', 'notes',
];

const rows = [HEADERS.join(',')];

for (const c of agg.cases) {
  for (const row of c.rows) {
    const best = bestMs(row);
    const paramLabel = formatParam(row.param);
    for (const r of RUNNER_ORDER) {
      const x = row.runners[r];
      if (!x) continue;
      const iters = x.iters_ms?.length ?? 0;
      const skipped = x.skipped ? 'true' : 'false';
      const notes = x.skipped ? (x.skip_reason || '') : (x.notes || '');
      const ratio = !x.skipped && best && x.median_ms > 0 ? x.median_ms / best : null;
      const isBest = ratio === 1 ? 'true' : 'false';
      const range = !x.skipped ? rangePct(x.iters_ms) : null;
      const sd = !x.skipped ? stddev(x.iters_ms) : null;
      const cv = !x.skipped ? cvPct(x.iters_ms) : null;
      const p95 = !x.skipped ? quantile(x.iters_ms, 0.95) : null;
      const cpuTot = !x.skipped ? (x.cpu_user_ms || 0) + (x.cpu_sys_ms || 0) : 0;
      const wallTot = !x.skipped ? (x.iters_ms || []).reduce((a, b) => a + b, 0) : 0;
      const cpuWall = (cpuTot > 0 && wallTot > 0) ? cpuTot / wallTot : null;
      rows.push([
        csv(c.case),
        csv(paramLabel),
        r,
        iters,
        num(x.median_ms),
        num(x.mean_ms),
        num(x.min_ms),
        num(x.max_ms),
        num(sd),
        num(cv),
        num(range),
        num(p95),
        num(x.throughput_mbps),
        num(x.peak_rss_mb),
        num(x.cpu_user_ms),
        num(x.cpu_sys_ms),
        num(cpuWall),
        num(ratio),
        x.skipped ? '' : isBest,
        skipped,
        csv(notes),
      ].join(','));
    }
  }
}

writeFileSync(OUT, rows.join('\n') + '\n');
console.log(`wrote ${OUT} (${rows.length - 1} data rows)`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') out.in = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

function bestMs(row) {
  let b = Infinity;
  for (const r of RUNNER_ORDER) {
    const x = row.runners[r];
    if (x && !x.skipped && typeof x.median_ms === 'number' && x.median_ms > 0 && x.median_ms < b) b = x.median_ms;
  }
  return b === Infinity ? null : b;
}

function rangePct(iters) {
  if (!iters || iters.length < 2) return null;
  const s = [...iters].sort((a, b) => a - b);
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  if (med === 0) return null;
  const half = Math.max(med - s[0], s[s.length - 1] - med);
  return (half / med) * 100;
}
function stddev(iters) {
  if (!iters || iters.length < 2) return null;
  const mean = iters.reduce((s, v) => s + v, 0) / iters.length;
  const variance = iters.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (iters.length - 1);
  return Math.sqrt(variance);
}
function cvPct(iters) {
  const sd = stddev(iters);
  if (sd == null) return null;
  const mean = iters.reduce((s, v) => s + v, 0) / iters.length;
  if (mean === 0) return null;
  return (sd / mean) * 100;
}
function quantile(iters, q) {
  if (!iters || iters.length < 10) return null;
  const s = [...iters].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function formatParam(p) {
  if (!p || typeof p !== 'object') return '';
  return Object.keys(p).sort().map(k => `${k}=${p[k]}`).join(';');
}

function csv(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function num(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return v.toFixed(4).replace(/\.?0+$/, '');
}
