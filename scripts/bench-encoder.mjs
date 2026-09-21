#!/usr/bin/env node
// Encoder thread/quant scaling benchmark.
//
// WHY THIS EXISTS
// ---------------
// The app's encoder is the bottleneck, and ORT-Web reads env.wasm.numThreads
// exactly ONCE per page load (initializeWebAssembly() is memoized). Changing the
// Threads setting and merely reloading the MODEL therefore has no effect at all
// -- every "2 vs 4 vs 8 threads" comparison made that way is silently measuring
// the same pool size. This harness opens a FRESH browser context per config, so
// each run really gets the thread count it asked for, and then asserts it:
// `env.ortWasmThreads` must equal the requested value or the run is marked
// invalid instead of being reported as data.
//
// It drives the app's gated debug hook (window.__ptBench, installed by
// app/ui/src/lib/bench.js only with ?bench=1), which loads the model through the
// same code path as App.jsx's loadModel() and exposes the engine's per-op ORT
// profile. No UI automation, no re-implementation.
//
// REQUIREMENTS
// ------------
// - A built app served with COOP/COEP (the LAN server: npm run build --prefix app/ui).
// - Playwright's Chromium: npx playwright install chromium
//
// USAGE
// -----
//   node scripts/bench-encoder.mjs --url https://192.168.178.99:8787 \
//     --audio test/fixtures/jfk-moon-3min.mp3 --threads 1,2,4 --quants int4,int8 --runs 3
//   node scripts/bench-encoder.mjs --url http://localhost:8787 --profile
//
// Written with the help of Claude Code.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { chromium } from '@playwright/test';

const DEFAULTS = {
  url: 'https://192.168.178.99:8787',
  audio: null,
  durationSec: 20,
  threads: '1,2,4',
  quants: 'int4',
  runs: 3,
  profile: false,
  out: null,
  headless: true,
  dryRun: false,
  timeoutSec: 900,
  verbose: false,
};

export function parseArgs(argv) {
  const a = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--url': a.url = next(); break;
      case '--audio': a.audio = next(); break;
      case '--duration': a.durationSec = Number(next()); break;
      case '--threads': a.threads = next(); break;
      case '--quants': a.quants = next(); break;
      case '--runs': a.runs = Number(next()); break;
      case '--out': a.out = next(); break;
      case '--timeout': a.timeoutSec = Number(next()); break;
      case '--profile': a.profile = true; break;
      case '--dry-run': a.dryRun = true; break;
      case '--headed': a.headless = false; break;
      case '--headless': a.headless = true; break;
      case '--verbose': a.verbose = true; break;
      case '--help': case '-h': a.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  a.url = a.url.replace(/\/+$/, '');
  a.threadList = a.threads.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n >= 1);
  a.quantList = a.quants.split(',').map(s => s.trim()).filter(Boolean);
  if (!a.threadList.length) throw new Error('--threads must list at least one positive integer');
  if (!a.quantList.length) throw new Error('--quants must list at least one value');
  return a;
}

/** Cartesian product of the requested configs, in a stable order. */
export function buildMatrix({ quantList, threadList }) {
  const out = [];
  for (const encoderQuant of quantList) {
    for (const cpuThreads of threadList) out.push({ encoderQuant, cpuThreads });
  }
  return out;
}

/** Mean of a numeric field over the runs of one config. */
export function meanField(runs, field) {
  const vals = runs.map(r => Number(r[field])).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function fmt(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(24, 34).join('\n'));
    return;
  }
  const matrix = buildMatrix(args);
  const pcmBase64 = args.audio ? readFileSync(resolve(args.audio)).toString('base64') : null;
  const audioLabel = args.audio ? basename(args.audio) : `synthetic ${args.durationSec}s`;
  const timeoutMs = args.timeoutSec * 1000;

  console.log(`[bench] url=${args.url} audio=${audioLabel} runs=${args.runs} profile=${args.profile}`);
  console.log(`[bench] ${matrix.length} configs: ${matrix.map(c => `${c.encoderQuant}/${c.cpuThreads}t`).join(', ')}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: args.headless,
      args: ['--ignore-certificate-errors', '--enable-features=SharedArrayBuffer'],
    });
  } catch (e) {
    console.error('[bench] Could not launch Chromium. Run: npx playwright install chromium');
    throw e;
  }

  const rows = [];
  try {
    for (const cfg of matrix) {
      const label = `${cfg.encoderQuant} × ${cfg.cpuThreads} Threads`;
      process.stdout.write(`[bench] ${label} … `);
      // Fresh context: a new renderer process, so ORT's memoized
      // initializeWebAssembly() runs again with the requested thread count.
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      if (args.verbose) page.on('console', m => console.log(`    [page] ${m.text()}`));
      try {
        await page.goto(`${args.url}/?bench=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction('!!window.__ptBench', null, { timeout: 30000 });
        await page.evaluate(c => window.__ptBench.setConfig(c), cfg);
        const stored = await page.evaluate(async () => ({
          q: await window.__ptBench.readSetting('encoderQuant', null),
          t: await window.__ptBench.readSetting('cpuThreads', null),
        }));
        if (stored.q !== cfg.encoderQuant || Number(stored.t) !== cfg.cpuThreads) {
          throw new Error(`setting not persisted (got ${JSON.stringify(stored)})`);
        }
        if (args.dryRun) {
          console.log(`ok  settings persisted (${stored.q}, ${stored.t}t)  [dry-run: no model load]`);
          rows.push({ ...cfg, label, valid: true, dryRun: true });
          continue;
        }
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction('!!window.__ptBench', null, { timeout: 30000 });
        const res = await withTimeout(
          page.evaluate(o => window.__ptBench.measure(o), {
            pcmBase64, durationSec: args.durationSec, runs: args.runs,
            encoderQuant: cfg.encoderQuant, cpuThreads: cfg.cpuThreads,
            enableProfiling: args.profile,
          }),
          timeoutMs, 'measure',
        );
        const encodeMs = meanField(res.runs, 'encode_ms');
        const decodeMs = meanField(res.runs, 'decode_ms');
        const totalMs = meanField(res.runs, 'total_ms');
        const audioSec = meanField(res.runs, 'audioSec');
        const valid = res.env.ortWasmThreads === cfg.cpuThreads;
        const topOps = res.profile
          ? Object.values(res.profile).flatMap(p => p.topOps || []).slice(0, 10)
          : null;
        rows.push({ ...cfg, label, valid, audioSec, encodeMs, decodeMs, totalMs, rtf: audioSec ? totalMs / 1000 / audioSec : null, env: res.env, transcript: res.transcript, topOps });
        console.log(valid
          ? `ok  encode ${fmt(encodeMs, 0)} ms  rtf ${fmt(rows[rows.length - 1].rtf, 2)}  (threads=${res.env.ortWasmThreads})`
          : `INVALID: asked ${cfg.cpuThreads} threads, ORT reports ${res.env.ortWasmThreads}`);
      } catch (e) {
        console.log(`FAILED: ${e.message}`);
        rows.push({ ...cfg, label, valid: false, error: e.message });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== Scaling (encode_ms; lower is better) ===');
  const valid = rows.filter(r => r.valid);
  for (const quant of args.quantList) {
    const ofQuant = valid.filter(r => r.encoderQuant === quant).sort((a, b) => a.cpuThreads - b.cpuThreads);
    if (!ofQuant.length) continue;
    console.log(`${quant}: ` + ofQuant.map(r => `${r.cpuThreads}t=${fmt(r.encodeMs, 0)}ms (rtf ${fmt(r.rtf, 2)})`).join('  '));
    const base = ofQuant[0];
    for (const r of ofQuant.slice(1)) {
      if (r.encodeMs && base.encodeMs) console.log(`   ${base.cpuThreads}t → ${r.cpuThreads}t: ${(base.encodeMs / r.encodeMs).toFixed(2)}× speedup`);
    }
  }
  const invalid = rows.filter(r => !r.valid);
  if (invalid.length) console.log(`\n${invalid.length} invalid/failed config(s): ${invalid.map(r => r.label).join(', ')}`);

  if (args.dryRun) { console.log('\n[bench] dry-run: no output file written'); return; }
  const out = args.out || `bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), url: args.url, audio: audioLabel, runs: args.runs, rows }, null, 2));
  console.log(`\n[bench] wrote ${out}`);
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
