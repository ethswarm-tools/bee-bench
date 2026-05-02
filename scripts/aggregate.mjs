#!/usr/bin/env node
// Aggregate per-runner JSON results into a markdown report (with inline SVG
// bars) and an HTML report (chart.js via CDN).
//
// Usage:
//   node scripts/aggregate.mjs [--results <dir>] [--out <dir>]
//
// Reads results/*.json. For each (runner, case, param), keeps the most recent
// run only (by file mtime, descending). Emits results/report.md, results/report.html,
// results/aggregate.json.

import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const RESULTS_DIR = args.results || join(REPO_ROOT, 'results');
const OUT_DIR = args.out || RESULTS_DIR;

const RUNNER_ORDER = ['go', 'rs', 'js'];
const RUNNER_LABELS = { go: 'bee-go', rs: 'bee-rs', js: 'bee-js' };
const RUNNER_COLORS = { go: '#00ADD8', rs: '#DEA584', js: '#F7DF1E' };

// Group cases by domain so the Bee-bottlenecked rows are visually separate
// from real client comparisons.
const CASE_GROUPS = [
  { name: 'CPU (no network)', match: /^cpu\./, note: 'Pure client work — no Bee involvement.' },
  { name: 'Calibration', match: /^net\.stamps\./, note: 'Control + concurrent overhead. /stamps.list = sequential calibration. /stamps.concurrent = N parallel calls, exposes HTTP-stack differences (connection pool, keepalive default).' },
  { name: 'Feeds', match: /^net\.feed\./, note: '`fresh` measures Bee /feeds exponential search (Sepolia-bound). `warm` is the cached-lookup cost.' },
  { name: 'Network upload', match: /^net\.(bzz|bytes|tags)\.(upload|upload-with-tag)(?!.*from-disk)/, note: 'POST /bzz, /bytes, /bzz with encrypt=true, /bytes-with-tag. Bee chunking + stamping is the bottleneck (~10 MB/s).' },
  { name: 'Network upload (streaming from disk)', match: /^net\.bzz\.upload-from-disk/, note: 'Stream from disk via fs.createReadStream / os.Open. bee-rs N/A — buffers fully.' },
  { name: 'Network download', match: /^net\.(bzz|bytes)\.(download|head)/, note: '⚠ Local-cache hit — chunks were just uploaded so Bee returns them from local store. Measures client-side download path overhead, NOT real network fetch.' },
  { name: 'Pin / observability', match: /^net\.pin\./, note: 'POST/DELETE /pins/<ref> + GET /pins. Per-call HTTP overhead on a pinning-endpoint shape.' },
  { name: 'Bee chunk-pipeline (Sepolia-bottlenecked)', match: /^net\.(chunks|stream-dir|soc)\./, note: '⚠ These cases are dominated by Bee\'s sync queue on Sepolia (~600ms/chunk push ack). Per-unit times are NOT a client-speed comparison.' },
];

// Map case-id → key inside `param` whose value is the count to normalize by.
// Used to compute per-unit metrics (per-chunk, per-sign, per-file, per-read).
const PER_UNIT_KEY = {
  'cpu.keccak.chunk-hash': { key: 'count', label: 'call' },
  'cpu.keccak.parallel': { key: 'count', label: 'call' },
  'cpu.ecdsa.sign-1000': { key: 'count', label: 'sign' },
  'cpu.ecdsa.verify-1000': { key: 'count', label: 'verify' },
  'cpu.identity.create': { key: 'count', label: 'identity' },
  'cpu.manifest.lookup-large': { key: 'lookups', label: 'lookup' },
  'net.stamps.concurrent': { key: 'count', label: 'call' },
  'net.bytes.head': { key: 'count', label: 'HEAD' },
  'cpu.manifest.hash-50files': { key: 'files', label: 'file' },
  'net.chunks.upload': { key: 'count', label: 'chunk' },
  'net.soc.upload': { key: 'count', label: 'SOC' },
  'net.pin.add-list': { key: 'count', label: 'pin' },
  'net.stream-dir.upload': { key: 'files', label: 'file' },
  'net.feed.write-read.warm': { key: 'reads', label: 'read' },
};

main();

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const runs = loadRuns(RESULTS_DIR);
  if (runs.length === 0) {
    console.error(`no results found in ${RESULTS_DIR}`);
    process.exit(1);
  }
  const { latestByRunner, allCases, specHashes } = collapse(runs);

  const caseDocs = loadCaseDocs(join(REPO_ROOT, 'bench-spec.json'));
  for (const c of allCases) {
    if (caseDocs[c.case]) c.doc = caseDocs[c.case];
  }

  const aggregate = {
    generated_at: new Date().toISOString(),
    spec_hashes: [...specHashes],
    runners: Object.fromEntries(
      Object.entries(latestByRunner).map(([k, v]) => [k, {
        client_version: v.client_version,
        bee_version: v.bee_version,
        started_at: v.started_at,
        host: v.host,
      }])
    ),
    cases: allCases,
    scoreboard: buildScoreboard(allCases),
  };

  writeFileSync(join(OUT_DIR, 'aggregate.json'), JSON.stringify(aggregate, null, 2));
  writeFileSync(join(OUT_DIR, 'report.md'), buildMarkdown(aggregate, latestByRunner));
  writeFileSync(join(OUT_DIR, 'report.html'), buildHtml(aggregate));

  console.log(`wrote ${OUT_DIR}/aggregate.json`);
  console.log(`wrote ${OUT_DIR}/report.md`);
  console.log(`wrote ${OUT_DIR}/report.html`);
  if (specHashes.size > 1) {
    console.warn(`WARNING: results span ${specHashes.size} different bench-spec.json hashes — comparisons may be invalid`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--results') out.results = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

function loadCaseDocs(specPath) {
  try {
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const out = {};
    for (const c of spec.cases || []) {
      if (c && c.id && c.doc) out[c.id] = c.doc;
    }
    return out;
  } catch {
    return {};
  }
}

function loadRuns(dir) {
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'aggregate.json' && !f.startsWith('report'))
    .map(f => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const runs = [];
  for (const f of files) {
    let r;
    try {
      r = JSON.parse(readFileSync(f.path, 'utf8'));
    } catch (err) {
      console.error(`ERROR: ${f.path} — malformed JSON: ${err.message}`);
      console.error('Refusing to aggregate; fix or remove the file and rerun.');
      process.exit(2);
    }
    if (!r || typeof r !== 'object' || !r.runner || !Array.isArray(r.results)) {
      console.error(`ERROR: ${f.path} — missing required fields (runner, results[])`);
      console.error('Refusing to aggregate; fix or remove the file and rerun.');
      process.exit(2);
    }
    r._file = f.path;
    r._mtime = f.mtime;
    runs.push(r);
  }
  return runs;
}

function collapse(runs) {
  const latestByRunner = {};
  const specHashes = new Set();
  for (const r of runs) {
    specHashes.add(r.bench_spec_hash);
    if (!latestByRunner[r.runner] || r._mtime > latestByRunner[r.runner]._mtime) {
      latestByRunner[r.runner] = r;
    }
  }

  const cases = new Map();
  for (const runner of RUNNER_ORDER) {
    const run = latestByRunner[runner];
    if (!run) continue;
    for (const r of run.results) {
      if (!cases.has(r.case)) cases.set(r.case, new Map());
      const paramKey = paramKeyOf(r.param);
      const byParam = cases.get(r.case);
      if (!byParam.has(paramKey)) byParam.set(paramKey, { param: r.param, runners: {} });
      byParam.get(paramKey).runners[runner] = r;
    }
  }

  const allCases = [];
  for (const [caseId, byParam] of cases) {
    const rows = [];
    for (const [_, entry] of byParam) {
      rows.push(entry);
    }
    allCases.push({ case: caseId, rows });
  }
  return { latestByRunner, allCases, specHashes };
}

function paramKeyOf(p) {
  if (!p || typeof p !== 'object') return '';
  return Object.keys(p).sort().map(k => `${k}=${JSON.stringify(p[k])}`).join('&');
}

function paramLabel(p) {
  if (!p || typeof p !== 'object') return '';
  const keys = Object.keys(p).filter(k => k !== 'large');
  if (keys.length === 0) return '—';
  return keys.map(k => `${k}=${p[k]}`).join(', ');
}

// ----- Stats helpers -----

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function rangePercent(iters) {
  if (!iters || iters.length < 2) return null;
  const med = median(iters);
  if (med == null || med === 0) return null;
  const min = Math.min(...iters);
  const max = Math.max(...iters);
  const half = Math.max(med - min, max - med);
  return (half / med) * 100; // ±X%
}

// Inline sparkline of iters_ms as a tiny SVG polyline. Reveals JIT warmup
// (iter 0 high then settle), GC pauses (one outlier), Sepolia variance.
function sparkline(iters, color) {
  if (!iters || iters.length < 2) return '';
  const w = 60, h = 14, pad = 1;
  const min = Math.min(...iters);
  const max = Math.max(...iters);
  const range = Math.max(max - min, 1e-9);
  const stepX = (w - pad * 2) / (iters.length - 1);
  const points = iters.map((v, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" style="vertical-align:middle"><polyline points="${points}" fill="none" stroke="${color || '#64748b'}" stroke-width="1"/></svg>`;
}

// Linear regression of (size_bytes, ms) for cases that span multiple sizes.
// Returns { fixed_overhead_ms, throughput_mbps } describing the fit
// `time_ms = a + bytes / (throughput_mbps * 1024)`, where a is the y-intercept.
function fitLatencyVsSize(rowsForRunner) {
  const pts = rowsForRunner
    .map(({ param, ms }) => {
      const mb = param?.size_mb;
      if (typeof mb !== 'number' || mb <= 0) return null;
      if (!(ms > 0)) return null;
      return { x: mb * 1024 * 1024, y: ms };
    })
    .filter(Boolean);
  if (pts.length < 2) return null;
  const n = pts.length;
  const sumX = pts.reduce((s, p) => s + p.x, 0);
  const sumY = pts.reduce((s, p) => s + p.y, 0);
  const sumXY = pts.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pts.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom; // ms per byte
  const intercept = (sumY - slope * sumX) / n;     // ms
  if (!(slope > 0)) return { fixed_overhead_ms: intercept, throughput_mbps: null, points: n };
  // ms_per_byte → MB/s: inverse, scale: bytes/ms → MB/s = (1/slope) / 1024 ... want bytes/ms / 1048576 * 1000
  const bytesPerMs = 1 / slope;
  const mbps = bytesPerMs * 1000 / (1024 * 1024);
  return { fixed_overhead_ms: intercept, throughput_mbps: mbps, points: n };
}

// Geometric mean of ratios. Skips null/non-finite.
function geomean(ratios) {
  const valid = ratios.filter(r => Number.isFinite(r) && r > 0);
  if (valid.length === 0) return null;
  const sumLog = valid.reduce((s, r) => s + Math.log(r), 0);
  return Math.exp(sumLog / valid.length);
}

// Per-row best (lowest median_ms) across runners.
function rowBestMs(row) {
  let best = Infinity;
  for (const r of RUNNER_ORDER) {
    const x = row.runners[r];
    if (x && !x.skipped && x.iters_ms && x.iters_ms.length > 0 && x.median_ms > 0) {
      if (x.median_ms < best) best = x.median_ms;
    }
  }
  return best === Infinity ? null : best;
}

// ----- Scoreboard -----

function buildScoreboard(allCases) {
  // For each row, find best, then ratio per runner. Aggregate per group.
  const perRunner = {};
  for (const r of RUNNER_ORDER) perRunner[r] = { wins: 0, ratiosAll: [], ratiosByGroup: {} };

  for (const c of allCases) {
    const group = caseGroup(c.case);
    for (const row of c.rows) {
      const best = rowBestMs(row);
      if (best == null) continue;
      for (const r of RUNNER_ORDER) {
        const x = row.runners[r];
        if (!x || x.skipped || !x.iters_ms || x.iters_ms.length === 0 || !(x.median_ms > 0)) continue;
        const ratio = x.median_ms / best;
        perRunner[r].ratiosAll.push(ratio);
        perRunner[r].ratiosByGroup[group] ||= [];
        perRunner[r].ratiosByGroup[group].push(ratio);
        if (ratio === 1) perRunner[r].wins += 1;
      }
    }
  }

  const runnerSummaries = {};
  for (const r of RUNNER_ORDER) {
    const overall = geomean(perRunner[r].ratiosAll);
    const byGroup = {};
    for (const [g, arr] of Object.entries(perRunner[r].ratiosByGroup)) {
      byGroup[g] = geomean(arr);
    }
    runnerSummaries[r] = {
      wins: perRunner[r].wins,
      geomean_overall: overall,
      geomean_by_group: byGroup,
      sample_count: perRunner[r].ratiosAll.length,
    };
  }
  return runnerSummaries;
}

function caseGroup(caseId) {
  for (const g of CASE_GROUPS) if (g.match.test(caseId)) return g.name;
  return 'Other';
}

// ----- Markdown output -----

function buildMarkdown(agg, latest) {
  const lines = [];
  lines.push('# bee-bench report');
  lines.push('');
  lines.push(`Generated: ${agg.generated_at}`);
  lines.push('');
  lines.push('**See also:** [results landing page](INDEX.md) · [findings (qualitative)](../FINDINGS.md) · [README (how to run)](../README.md)');
  lines.push('');
  lines.push('> ## ⚠ MB/s numbers are NOT Swarm-network throughput');
  lines.push('>');
  lines.push('> Every byte/sec figure in this report is **client ↔ local Bee node** over loopback HTTP, NOT real Swarm-network throughput:');
  lines.push('>');
  lines.push('> - **Uploads** measure how fast the client pushes data into the local Bee node\'s store under deferred-upload mode. The chunks are still being pushed to the Swarm network in the background after the call returns.');
  lines.push('> - **Downloads** of references uploaded earlier in the same run hit the local Bee cache. Numbers like "253 MB/s" are local-store reads, not network fetches.');
  lines.push('>');
  lines.push('> For real Swarm-network numbers, fetch from a Bee that doesn\'t have the chunks (different node, or after cache eviction) and re-run uploads with `deferred: false`. See [FINDINGS § measurement scope](../FINDINGS.md#-measurement-scope-caveat-read-first).');
  lines.push('');

  // Runners table
  lines.push('## Runners');
  lines.push('');
  lines.push('| Runner | Client | Bee node | Started | CPU |');
  lines.push('|---|---|---|---|---|');
  for (const r of RUNNER_ORDER) {
    const run = latest[r];
    if (!run) {
      lines.push(`| ${RUNNER_LABELS[r]} | — | — | (no run) | — |`);
      continue;
    }
    const cpu = (run.host?.cpu || '').slice(0, 40);
    lines.push(`| ${RUNNER_LABELS[r]} | ${run.client_version} | ${run.bee_version} | ${run.started_at} | ${cpu} |`);
  }
  lines.push('');
  if (agg.spec_hashes.length > 1) {
    lines.push(`> ⚠ Results span ${agg.spec_hashes.length} different bench-spec.json hashes — comparisons may be invalid.`);
    lines.push('');
  }

  // Scoreboard
  lines.push('## Scoreboard');
  lines.push('');
  lines.push('Geometric mean of *median-time ratio to fastest runner per row*. 1.00x = fastest. Higher = slower. The "wins" column counts rows where the runner had the lowest median. "Rows" is the number of (case, param) rows the runner contributed a valid sample for — context for how broad each geomean is.');
  lines.push('');
  const groupNames = CASE_GROUPS.map(g => g.name);
  const sb = agg.scoreboard;
  const headers = ['Runner', 'Wins', 'Rows', 'Overall', ...groupNames];
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('|' + headers.map(() => '---').join('|') + '|');
  for (const r of RUNNER_ORDER) {
    const s = sb[r] || {};
    const cells = [RUNNER_LABELS[r], String(s.wins ?? 0), String(s.sample_count ?? 0), fmtRatio(s.geomean_overall)];
    for (const gn of groupNames) cells.push(fmtRatio(s.geomean_by_group?.[gn]));
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  lines.push('');

  // Cases grouped by domain
  for (const g of CASE_GROUPS) {
    const groupCases = agg.cases.filter(c => g.match.test(c.case));
    if (groupCases.length === 0) continue;
    lines.push(`## ${g.name}`);
    lines.push('');
    if (g.note) { lines.push(`> ${g.note}`); lines.push(''); }

    for (const c of groupCases) {
      lines.push(`### \`${c.case}\``);
      lines.push('');
      if (c.doc) { lines.push(`> ${c.doc}`); lines.push(''); }
      const headers2 = ['param', ...RUNNER_ORDER.map(r => RUNNER_LABELS[r]), 'chart'];
      lines.push('| ' + headers2.join(' | ') + ' |');
      lines.push('|' + headers2.map(() => '---').join('|') + '|');

      for (const row of c.rows) {
        const best = rowBestMs(row);
        const pl = paramLabel(row.param);
        const cells = [pl];
        const values = [];
        for (const r of RUNNER_ORDER) {
          cells.push(formatCell(c.case, row, r, best));
          const x = row.runners[r];
          const ok = x && !x.skipped && x.iters_ms && x.iters_ms.length > 0 && x.median_ms > 0;
          values.push(ok ? x.median_ms : null);
        }
        cells.push(svgBars(values));
        lines.push('| ' + cells.join(' | ') + ' |');
      }
      lines.push('');

      // Latency-vs-size linear fit (only when ≥2 rows have size_mb).
      const fitLines = renderLatencyFit(c);
      if (fitLines) {
        lines.push(...fitLines);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

function formatCell(caseId, row, runner, bestMs) {
  const x = row.runners[runner];
  if (!x) return '—';
  if (x.skipped) return `*skip:* ${x.skip_reason || ''}`;
  if (!x.iters_ms || x.iters_ms.length === 0) return '—';

  const med = x.median_ms;
  const ratio = bestMs && med ? med / bestMs : null;
  const isBest = ratio === 1;

  const perUnit = perUnitFmt(caseId, row.param, med);
  const range = rangePercent(x.iters_ms);
  const tp = x.throughput_mbps != null ? `${x.throughput_mbps.toFixed(1)} MB/s` : null;

  // line 1: median + ratio (bold if winner)
  const line1 = isBest
    ? `**${fmtMs(med)}** (best)`
    : `${fmtMs(med)} (${fmtRatio(ratio)})`;

  // line 2: throughput / per-unit
  const parts2 = [];
  if (tp) parts2.push(tp);
  if (perUnit) parts2.push(perUnit);
  const line2 = parts2.length ? parts2.join(' · ') : null;

  // line 3: variance + rss (variance gets ⚠ if > 50% — flaky)
  const parts3 = [];
  if (range != null) {
    const flag = range > 50 ? '⚠ ' : '';
    parts3.push(`${flag}±${range.toFixed(0)}%`);
  }
  if (x.peak_rss_mb) parts3.push(`rss ${x.peak_rss_mb.toFixed(0)}MB`);
  const line3 = parts3.length ? parts3.join(' · ') : null;

  // line 4: per-iter sparkline (reveals JIT warmup, GC pauses, network jitter)
  const sk = sparkline(x.iters_ms, RUNNER_COLORS[runner]);

  return [line1, line2, line3, sk].filter(Boolean).join('<br>');
}

function renderLatencyFit(caseObj) {
  // Only meaningful when there are ≥2 size-keyed param rows.
  const sizeRows = caseObj.rows.filter(r => typeof r.param?.size_mb === 'number');
  if (sizeRows.length < 2) return null;
  const fits = {};
  let any = false;
  for (const runner of RUNNER_ORDER) {
    const ptsForRunner = sizeRows.map(row => {
      const x = row.runners[runner];
      const ms = x && !x.skipped && x.iters_ms && x.iters_ms.length > 0 && x.median_ms > 0 ? x.median_ms : null;
      return { param: row.param, ms };
    });
    const f = fitLatencyVsSize(ptsForRunner);
    fits[runner] = f;
    if (f) any = true;
  }
  if (!any) return null;
  const out = [];
  out.push('**Latency-vs-size linear fit** (`time_ms ≈ fixed_overhead + bytes / throughput`):');
  out.push('');
  out.push('| Runner | fixed overhead | peak throughput | points |');
  out.push('|---|---|---|---|');
  for (const r of RUNNER_ORDER) {
    const f = fits[r];
    if (!f) { out.push(`| ${RUNNER_LABELS[r]} | — | — | — |`); continue; }
    const ovh = f.fixed_overhead_ms != null ? fmtMs(Math.max(0, f.fixed_overhead_ms)) : '—';
    const tp = f.throughput_mbps != null ? `${f.throughput_mbps.toFixed(1)} MB/s` : '—';
    out.push(`| ${RUNNER_LABELS[r]} | ${ovh} | ${tp} | ${f.points} |`);
  }
  return out;
}

function perUnitFmt(caseId, param, medianMs) {
  const cfg = PER_UNIT_KEY[caseId];
  if (!cfg || !param || medianMs == null) return null;
  const n = param[cfg.key];
  if (typeof n !== 'number' || n <= 0) return null;
  const perMs = medianMs / n;
  return `${fmtMs(perMs)}/${cfg.label}`;
}

function fmtRatio(r) {
  if (r == null || !isFinite(r)) return '—';
  if (r === 1) return '1.00x';
  if (r < 10) return `${r.toFixed(2)}x`;
  if (r < 100) return `${r.toFixed(1)}x`;
  return `${Math.round(r)}x`;
}

function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(1)}min`;
}

// Inline SVG bars: lower-is-better. The fastest bar is full-width green;
// others scale relative to it. Renders in any markdown viewer including GitHub.
function svgBars(values) {
  const valid = values.filter(v => v != null && !isNaN(v));
  if (valid.length === 0) return '';
  const max = Math.max(...valid);
  const min = Math.min(...valid);
  const w = 140, barH = 8, gap = 2;
  const totalH = values.length * (barH + gap);
  const bars = [];
  values.forEach((v, i) => {
    const y = i * (barH + gap);
    const runner = RUNNER_ORDER[i];
    if (v == null || isNaN(v)) {
      bars.push(`<rect x="0" y="${y}" width="0" height="${barH}" fill="#ccc"/>`);
      return;
    }
    const len = Math.max(2, Math.round((v / max) * w));
    const isWinner = v === min;
    const color = isWinner ? '#22c55e' : RUNNER_COLORS[runner] || '#94a3b8';
    bars.push(`<rect x="0" y="${y}" width="${len}" height="${barH}" fill="${color}"/>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${totalH}">${bars.join('')}</svg>`;
}

// ----- HTML output -----

function buildHtml(agg) {
  const groupsForHtml = CASE_GROUPS.map(g => ({
    name: g.name,
    note: g.note || '',
    pattern: g.match.source,
  }));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>bee-bench report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, sans-serif; max-width: 1300px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { margin-bottom: 0.25rem; }
  h2 { margin-top: 2.5rem; padding-top: 0.5rem; border-top: 1px solid #e2e8f0; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 2rem; }
  .case { margin-bottom: 2.5rem; padding: 1rem 1.25rem; border: 1px solid #e2e8f0; border-radius: 8px; }
  .case h3 { margin: 0 0 0.5rem; font-family: ui-monospace, monospace; font-size: 1rem; }
  .doc { color: #666; font-size: 0.85rem; margin-bottom: 0.75rem; font-style: italic; }
  .fit { margin-top: 0.75rem; padding: 0.5rem 0.75rem; background: #f8fafc; border-radius: 6px; }
  .fit-title { font-size: 0.85rem; margin-bottom: 0.25rem; }
  .fit table { margin-top: 0.25rem; }
  .group-note { color: #666; font-size: 0.9rem; margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; background: #f8fafc; border-radius: 6px; }
  .chart-wrap { height: 320px; position: relative; }
  table { border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
  th, td { padding: 4px 10px; border-bottom: 1px solid #eee; text-align: left; vertical-align: top; }
  th { background: #f8fafc; }
  .skip { color: #999; font-style: italic; }
  .warn { background: #fef3c7; padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; }
  .winner { font-weight: bold; color: #047857; }
  .sub { font-size: 0.8em; color: #555; }
  .scoreboard { background: #f8fafc; padding: 1rem; border-radius: 8px; }
  .speed-disclaimer { background: #fff7ed; border: 2px solid #f97316; padding: 1rem 1.25rem; border-radius: 8px; margin: 1rem 0 1.5rem; }
  .speed-disclaimer h2 { margin: 0 0 0.5rem; color: #c2410c; font-size: 1.05rem; }
  .speed-disclaimer p { margin: 0.4rem 0; }
  .nav-links { color: #444; font-size: 0.95rem; margin-bottom: 0.75rem; }
  .nav-links a { margin-right: 0.5rem; }
</style>
</head>
<body>
<h1>bee-bench report</h1>
<div class="meta">Generated ${agg.generated_at}</div>
<div class="nav-links">See also: <a href="INDEX.md">results landing page</a> · <a href="../FINDINGS.md">findings (qualitative)</a> · <a href="../README.md">README (how to run)</a></div>
<div class="speed-disclaimer">
  <h2>⚠ MB/s numbers are NOT Swarm-network throughput</h2>
  <p>Every byte/sec figure in this report is <strong>client ↔ local Bee node</strong> over loopback HTTP, NOT real Swarm-network throughput:</p>
  <ul>
    <li><strong>Uploads</strong> measure how fast the client pushes data into the local Bee node's store under deferred-upload mode. The chunks are still being pushed to the Swarm network in the background after the call returns.</li>
    <li><strong>Downloads</strong> of references uploaded earlier in the same run hit the local Bee cache. Numbers like "253 MB/s" are local-store reads, not network fetches.</li>
  </ul>
  <p>For real Swarm-network numbers, fetch from a Bee that doesn't have the chunks and re-run uploads with <code>deferred: false</code>. See <a href="../FINDINGS.md#-measurement-scope-caveat-read-first">FINDINGS § measurement scope</a>.</p>
</div>
${agg.spec_hashes.length > 1 ? `<div class="warn">⚠ Results span ${agg.spec_hashes.length} different bench-spec.json hashes — comparisons may be invalid.</div>` : ''}

<h2>Scoreboard</h2>
<div class="scoreboard">
  <p>Geometric mean of <em>median-time ratio to fastest runner per row</em>. 1.00x = fastest.</p>
  <table id="scoreboardTable"></table>
</div>

<div id="root"></div>

<script>
const data = ${JSON.stringify(agg)};
const RUNNERS = ${JSON.stringify(RUNNER_ORDER)};
const LABELS = ${JSON.stringify(RUNNER_LABELS)};
const COLORS = ${JSON.stringify(RUNNER_COLORS)};
const GROUPS = ${JSON.stringify(groupsForHtml)};
const PER_UNIT = ${JSON.stringify(PER_UNIT_KEY)};

function paramLabel(p) {
  if (!p || typeof p !== 'object') return '—';
  const keys = Object.keys(p).filter(k => k !== 'large');
  if (keys.length === 0) return '—';
  return keys.map(k => k + '=' + p[k]).join(', ');
}
function fmtMs(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms < 1) return (ms*1000).toFixed(0) + 'µs';
  if (ms < 1000) return ms.toFixed(1) + 'ms';
  if (ms < 60000) return (ms/1000).toFixed(2) + 's';
  return (ms/60000).toFixed(1) + 'min';
}
function fmtRatio(r) {
  if (r == null || !isFinite(r)) return '—';
  if (r === 1) return '1.00x';
  if (r < 10) return r.toFixed(2) + 'x';
  if (r < 100) return r.toFixed(1) + 'x';
  return Math.round(r) + 'x';
}
function rangePct(iters) {
  if (!iters || iters.length < 2) return null;
  const s = [...iters].sort((a,b)=>a-b);
  const med = s.length%2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2;
  if (med === 0) return null;
  const half = Math.max(med - s[0], s[s.length-1] - med);
  return (half/med)*100;
}
function bestMs(row) {
  let b = Infinity;
  for (const r of RUNNERS) {
    const x = row.runners[r];
    if (x && !x.skipped && x.median_ms != null && x.median_ms < b) b = x.median_ms;
  }
  return b === Infinity ? null : b;
}
function perUnit(caseId, param, med) {
  const cfg = PER_UNIT[caseId];
  if (!cfg || !param || med == null) return null;
  const n = param[cfg.key];
  if (typeof n !== 'number' || n <= 0) return null;
  return fmtMs(med/n) + '/' + cfg.label;
}
function fitLatencyVsSize(pts) {
  const filtered = pts.filter(p => typeof p.size_mb === 'number' && p.size_mb > 0 && p.ms > 0);
  if (filtered.length < 2) return null;
  const xs = filtered.map(p => p.size_mb * 1024 * 1024);
  const ys = filtered.map(p => p.ms);
  const n = xs.length;
  const sumX = xs.reduce((a,b)=>a+b,0);
  const sumY = ys.reduce((a,b)=>a+b,0);
  const sumXY = xs.reduce((s,x,i)=>s+x*ys[i],0);
  const sumX2 = xs.reduce((s,x)=>s+x*x,0);
  const denom = n*sumX2 - sumX*sumX;
  if (denom === 0) return null;
  const slope = (n*sumXY - sumX*sumY) / denom;
  const intercept = (sumY - slope*sumX) / n;
  if (!(slope > 0)) return { fixed_overhead_ms: intercept, throughput_mbps: null, points: n };
  const bytesPerMs = 1/slope;
  const mbps = bytesPerMs * 1000 / (1024 * 1024);
  return { fixed_overhead_ms: intercept, throughput_mbps: mbps, points: n };
}
function renderLatencyFitHtml(c) {
  const sizeRows = c.rows.filter(r => typeof r.param?.size_mb === 'number');
  if (sizeRows.length < 2) return '';
  const fits = {};
  let any = false;
  for (const runner of RUNNERS) {
    const pts = sizeRows.map(row => {
      const x = row.runners[runner];
      const ok = x && !x.skipped && x.iters_ms && x.iters_ms.length > 0 && x.median_ms > 0;
      return { size_mb: row.param.size_mb, ms: ok ? x.median_ms : null };
    });
    const f = fitLatencyVsSize(pts);
    fits[runner] = f;
    if (f) any = true;
  }
  if (!any) return '';
  let html = '<div class="fit"><div class="fit-title"><strong>Latency-vs-size linear fit</strong> <span class="sub">(time_ms ≈ fixed_overhead + bytes / throughput)</span></div>';
  html += '<table><thead><tr><th>Runner</th><th>fixed overhead</th><th>peak throughput</th><th>points</th></tr></thead><tbody>';
  for (const r of RUNNERS) {
    const f = fits[r];
    if (!f) { html += '<tr><td>' + LABELS[r] + '</td><td>—</td><td>—</td><td>—</td></tr>'; continue; }
    const ovh = f.fixed_overhead_ms != null ? fmtMs(Math.max(0, f.fixed_overhead_ms)) : '—';
    const tp = f.throughput_mbps != null ? f.throughput_mbps.toFixed(1) + ' MB/s' : '—';
    html += '<tr><td>' + LABELS[r] + '</td><td>' + ovh + '</td><td>' + tp + '</td><td>' + f.points + '</td></tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

// Scoreboard
(function () {
  const t = document.getElementById('scoreboardTable');
  const groupNames = GROUPS.map(g => g.name);
  let html = '<thead><tr><th>Runner</th><th>Wins</th><th>Rows</th><th>Overall</th>';
  for (const gn of groupNames) html += '<th>' + gn + '</th>';
  html += '</tr></thead><tbody>';
  for (const r of RUNNERS) {
    const s = data.scoreboard?.[r] || {};
    html += '<tr><td>' + LABELS[r] + '</td><td>' + (s.wins ?? 0) + '</td><td>' + (s.sample_count ?? 0) + '</td><td>' + fmtRatio(s.geomean_overall) + '</td>';
    for (const gn of groupNames) html += '<td>' + fmtRatio(s.geomean_by_group?.[gn]) + '</td>';
    html += '</tr>';
  }
  html += '</tbody>';
  t.innerHTML = html;
})();

const root = document.getElementById('root');
for (const g of GROUPS) {
  const re = new RegExp(g.pattern);
  const groupCases = data.cases.filter(c => re.test(c.case));
  if (groupCases.length === 0) continue;
  const h2 = document.createElement('h2');
  h2.textContent = g.name;
  root.appendChild(h2);
  if (g.note) {
    const n = document.createElement('div');
    n.className = 'group-note';
    n.textContent = g.note;
    root.appendChild(n);
  }
  for (const c of groupCases) {
    const div = document.createElement('div');
    div.className = 'case';
    const docHtml = c.doc ? '<div class="doc">' + escapeHtml(c.doc) + '</div>' : '';
    div.innerHTML = '<h3>' + c.case + '</h3>' + docHtml + '<div class="chart-wrap"><canvas></canvas></div>';
    root.appendChild(div);
    const canvas = div.querySelector('canvas');

    const labels = c.rows.map(r => paramLabel(r.param));
    const datasets = RUNNERS.map(runner => ({
      label: LABELS[runner],
      backgroundColor: COLORS[runner],
      data: c.rows.map(r => r.runners[runner]?.median_ms ?? null),
    }));

    new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        maintainAspectRatio: false, responsive: true,
        scales: { y: { title: { display: true, text: 'median ms (lower is better, log)' }, type: 'logarithmic' } },
        plugins: { tooltip: {
          callbacks: {
            label: (ctx) => {
              const row = c.rows[ctx.dataIndex];
              const result = row.runners[RUNNERS[ctx.datasetIndex]];
              if (!result) return ctx.dataset.label + ': —';
              if (result.skipped) return ctx.dataset.label + ': skip — ' + (result.skip_reason || '');
              const b = bestMs(row);
              const ratio = b ? result.median_ms / b : null;
              const tp = result.throughput_mbps != null ? ' (' + result.throughput_mbps.toFixed(1) + ' MB/s)' : '';
              const pu = perUnit(c.case, row.param, result.median_ms);
              const rss = result.peak_rss_mb ? ' rss ' + result.peak_rss_mb.toFixed(0) + 'MB' : '';
              const r = ratio != null ? ' [' + fmtRatio(ratio) + ']' : '';
              return ctx.dataset.label + ': ' + fmtMs(result.median_ms) + r + tp + (pu ? ' — ' + pu : '') + rss;
            }
          }
        } }
      }
    });

    // Companion table
    const table = document.createElement('table');
    let header = '<thead><tr><th>param</th>' + RUNNERS.map(r => '<th>' + LABELS[r] + '</th>').join('') + '</tr></thead>';
    let body = '<tbody>' + c.rows.map(row => {
      const b = bestMs(row);
      return '<tr><td>' + paramLabel(row.param) + '</td>' + RUNNERS.map(r => {
        const x = row.runners[r];
        if (!x) return '<td>—</td>';
        if (x.skipped) return '<td class="skip">skip</td>';
        const ratio = b && x.median_ms ? x.median_ms / b : null;
        const isBest = ratio === 1;
        const pu = perUnit(c.case, row.param, x.median_ms);
        const rng = rangePct(x.iters_ms);
        const tp = x.throughput_mbps != null ? ' (' + x.throughput_mbps.toFixed(1) + ' MB/s)' : '';
        const rss = x.peak_rss_mb ? '<div class="sub">rss ' + x.peak_rss_mb.toFixed(0) + 'MB' + (rng!=null?' · ±'+rng.toFixed(0)+'%':'') + '</div>' : (rng!=null?'<div class="sub">±'+rng.toFixed(0)+'%</div>':'');
        const main = '<div class="' + (isBest?'winner':'') + '">' + fmtMs(x.median_ms) + ' ' + (isBest?'(best)':'('+fmtRatio(ratio)+')') + tp + '</div>';
        const sub = pu ? '<div class="sub">' + pu + '</div>' : '';
        return '<td>' + main + sub + rss + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody>';
    table.innerHTML = header + body;
    div.appendChild(table);

    const fitHtml = renderLatencyFitHtml(c);
    if (fitHtml) {
      const fitDiv = document.createElement('div');
      fitDiv.innerHTML = fitHtml;
      div.appendChild(fitDiv.firstChild);
    }
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
</script>
</body>
</html>`;
}
