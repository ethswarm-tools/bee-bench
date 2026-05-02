#!/usr/bin/env node
// Compare two aggregate.json files and emit a markdown delta report.
//
// Usage:
//   node scripts/compare.mjs <baseline-aggregate.json> <new-aggregate.json> [--out <file>]
//
// For each (case, param, runner) present in both files, computes:
//   delta_ms       = new.median_ms - baseline.median_ms
//   delta_pct      = (new.median_ms / baseline.median_ms - 1) * 100
//
// Rows where the delta is < 5% are dimmed (likely noise). Rows where the
// regression > 20% or improvement > 20% get a marker.

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = parseArg('--out', args);
const positional = args.filter((a, i) => a !== '--out' && args[i - 1] !== '--out');
if (positional.length < 2) {
  console.error('usage: compare.mjs <baseline.json> <new.json> [--out <file>]');
  process.exit(1);
}

const base = JSON.parse(readFileSync(positional[0], 'utf8'));
const cur = JSON.parse(readFileSync(positional[1], 'utf8'));

const RUNNERS = ['go', 'rs', 'js'];
const LABELS = { go: 'bee-go', rs: 'bee-rs', js: 'bee-js' };

const lines = [];
lines.push(`# bee-bench compare`);
lines.push('');
lines.push(`Baseline: ${base.generated_at} (${positional[0]})`);
lines.push(`Current:  ${cur.generated_at} (${positional[1]})`);
lines.push('');

// Summary: per-runner geomean shift across all (case, param) rows.
const shifts = {};
for (const r of RUNNERS) shifts[r] = [];

const baseByKey = indexAgg(base);
const curByKey = indexAgg(cur);

const keys = new Set([...baseByKey.keys(), ...curByKey.keys()]);
const rowsByCase = new Map();

for (const k of keys) {
  const b = baseByKey.get(k);
  const c = curByKey.get(k);
  const [caseId, paramKey] = k.split('||');
  if (!rowsByCase.has(caseId)) rowsByCase.set(caseId, []);
  const entry = { paramKey, paramLabel: paramKey || '—', cells: {} };
  for (const r of RUNNERS) {
    const bm = b?.runners?.[r];
    const cm = c?.runners?.[r];
    const bms = validMs(bm);
    const cms = validMs(cm);
    if (bms != null && cms != null) {
      const ratio = cms / bms;
      shifts[r].push(ratio);
      entry.cells[r] = { bms, cms, delta_pct: (ratio - 1) * 100 };
    } else if (bms != null) {
      entry.cells[r] = { bms, cms: null };
    } else if (cms != null) {
      entry.cells[r] = { bms: null, cms };
    } else {
      entry.cells[r] = null;
    }
  }
  rowsByCase.get(caseId).push(entry);
}

lines.push('## Summary');
lines.push('');
lines.push('Geomean of (current / baseline) ratio per runner across all paired rows. <1.00 = improvement, >1.00 = regression.');
lines.push('');
lines.push('| Runner | rows compared | geomean shift |');
lines.push('|---|---|---|');
for (const r of RUNNERS) {
  const arr = shifts[r];
  const gm = arr.length ? Math.exp(arr.reduce((s, x) => s + Math.log(x), 0) / arr.length) : null;
  const fmt = gm == null ? '—' : (gm < 1 ? `↓ ${((1 - gm) * 100).toFixed(1)}% faster` : `↑ ${((gm - 1) * 100).toFixed(1)}% slower`);
  lines.push(`| ${LABELS[r]} | ${arr.length} | ${fmt} |`);
}
lines.push('');

lines.push('## Per-case deltas');
lines.push('');
lines.push('Δ%: positive = slower in current run, negative = faster. ⚠ flags >20% in either direction.');
lines.push('');

for (const [caseId, rows] of rowsByCase) {
  lines.push(`### \`${caseId}\``);
  lines.push('');
  const headers = ['param', ...RUNNERS.flatMap(r => [`${LABELS[r]} base`, `${LABELS[r]} cur`, `${LABELS[r]} Δ%`])];
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('|' + headers.map(() => '---').join('|') + '|');
  for (const e of rows) {
    const cells = [e.paramLabel];
    for (const r of RUNNERS) {
      const c = e.cells[r];
      if (!c) { cells.push('—', '—', '—'); continue; }
      cells.push(c.bms != null ? fmtMs(c.bms) : '—');
      cells.push(c.cms != null ? fmtMs(c.cms) : '—');
      if (c.delta_pct == null) {
        cells.push('—');
      } else {
        const flag = Math.abs(c.delta_pct) > 20 ? '⚠ ' : '';
        const sign = c.delta_pct >= 0 ? '+' : '';
        cells.push(`${flag}${sign}${c.delta_pct.toFixed(1)}%`);
      }
    }
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  lines.push('');
}

const md = lines.join('\n');
if (out) {
  writeFileSync(out, md);
  console.error(`wrote ${out}`);
} else {
  process.stdout.write(md);
}

function parseArg(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function validMs(x) {
  if (!x || x.skipped) return null;
  if (!x.iters_ms || x.iters_ms.length === 0) return null;
  if (!(x.median_ms > 0)) return null;
  return x.median_ms;
}

function indexAgg(agg) {
  const m = new Map();
  for (const c of agg.cases || []) {
    for (const row of c.rows || []) {
      const pk = paramKeyOf(row.param);
      m.set(`${c.case}||${pk}`, row);
    }
  }
  return m;
}

function paramKeyOf(p) {
  if (!p || typeof p !== 'object') return '';
  return Object.keys(p).sort().map(k => `${k}=${JSON.stringify(p[k])}`).join('&');
}

function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}
