// Gated benchmark/debug hook (`window.__ptBench`). Only installed when the page
// is opened with `?bench=1` (see the dynamic import guard in App.jsx), so it
// never exists for normal visitors and adds no weight to the normal bundle.
//
// Purpose: the app is microphone-only, so an external harness (scripts/bench-encoder.mjs)
// has no way to feed a fixed audio buffer and read the engine's per-op timings.
// This module exposes exactly that, using the SAME load path as loadModel() in
// App.jsx (getParakeetModel + ParakeetModel.fromUrls) so a benchmark can never
// drift from what users actually run.
//
// Written with the help of Claude Code.
import { ParakeetModel, getParakeetModel, CanaryEncoder, CanaryModel } from 'parakeet.js';
import { CONFIG } from '../config.js';
import { openIdb, idbGet, idbPut } from '../../../src/idb.js';
import { resamplePcmTo16k } from './audio.js';

const SETTINGS_DB_NAME = 'parakeetweb-settings-db';
const SETTINGS_STORE_NAME = 'settings-store';
const STORAGE_KEY_PREFIX = 'pw_';
const getSettingsDb = () => openIdb(SETTINGS_DB_NAME, SETTINGS_STORE_NAME);

/** Read a persisted app setting (same store/prefix as App.jsx). */
export async function readSetting(key, def) {
  try {
    const v = await idbGet(await getSettingsDb(), SETTINGS_STORE_NAME, STORAGE_KEY_PREFIX + key);
    return v !== undefined ? v : def;
  } catch { return def; }
}

/** Write a persisted app setting. Takes effect only after a full page reload. */
export async function writeSetting(key, value) {
  await idbPut(await getSettingsDb(), SETTINGS_STORE_NAME, STORAGE_KEY_PREFIX + key, value);
}

/**
 * Deterministic pseudo-speech PCM (seeded noise, 16 kHz). The encoder's cost is
 * content-independent, so a fixed synthetic buffer gives reproducible timings
 * without shipping an audio fixture.
 * @param {number} durationSec
 * @param {number} [sampleRate]
 * @returns {Float32Array}
 */
export function synthPcm(durationSec, sampleRate = 16000) {
  const n = Math.max(1, Math.round(durationSec * sampleRate));
  const out = new Float32Array(n);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.1;
  }
  return out;
}

/** Fetch + decode any browser-decodable audio URL into 16 kHz mono PCM. */
export async function pcmFromUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`bench: fetch ${url} -> ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(buf);
    const ch = decoded.numberOfChannels > 1
      ? (() => {
          const a = decoded.getChannelData(0), b = decoded.getChannelData(1);
          const m = new Float32Array(a.length);
          for (let i = 0; i < a.length; i++) m[i] = (a[i] + b[i]) / 2;
          return m;
        })()
      : decoded.getChannelData(0);
    return await resamplePcmTo16k(Float32Array.from(ch), decoded.sampleRate);
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
}

/** Decode a base64-encoded audio file (mp3/wav/…) into 16 kHz mono PCM. */
export async function pcmFromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(bytes.buffer);
    const ch = decoded.numberOfChannels > 1
      ? (() => {
          const a = decoded.getChannelData(0), b = decoded.getChannelData(1);
          const m = new Float32Array(a.length);
          for (let i = 0; i < a.length; i++) m[i] = (a[i] + b[i]) / 2;
          return m;
        })()
      : decoded.getChannelData(0);
    return await resamplePcmTo16k(Float32Array.from(ch), decoded.sampleRate);
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
}

/**
 * Load the model on the current settings and run N transcriptions.
 * @param {Object} opts
 * @param {string} [opts.url]           Audio URL (else synthetic PCM).
 * @param {string} [opts.pcmBase64]     Base64 audio (else url / synthetic).
 * @param {number} [opts.durationSec=20] Synthetic audio length when no url.
 * @param {number} [opts.runs=3]
 * @param {('int4'|'int8')} [opts.encoderQuant='int4']
 * @param {number} [opts.cpuThreads=2]
 * @param {boolean} [opts.enableProfiling=false] Collect ORT per-op profile (slower).
 * @param {boolean} [opts.chunking=false]        Use the app's chunking defaults.
 * @returns {Promise<Object>} { runs, env, transcript, profile }
 */
export async function measure(opts = {}) {
  const {
    url = null, pcmBase64 = null, durationSec = 20, runs = 3,
    encoderQuant = 'int4', cpuThreads = 2,
    enableProfiling = false, chunking = false,
  } = opts;
  const pcm = pcmBase64 ? await pcmFromBase64(pcmBase64) : (url ? await pcmFromUrl(url) : synthPcm(durationSec));
  const repoId = CONFIG.VITE_MODEL_REPO || 'efederici/parakeet-tdt-0.6b-v3-onnx-int4';
  const modelSource = CONFIG.VITE_MODEL_SOURCE || 'local';
  const modelUrls = await getParakeetModel(repoId, {
    encoderQuant, decoderQuant: 'int8', preprocessor: 'js', backend: 'wasm',
    cpuThreads: Number(cpuThreads), progress: () => {},
    ...(modelSource === 'local' ? { localFallbackBaseUrl: '/models' } : { skipIdbCache: true }),
    ...(encoderQuant === 'int8' && CONFIG.VITE_MODEL_ENCODER_REPO ? {
      encoderRepoId: CONFIG.VITE_MODEL_ENCODER_REPO,
      ...(CONFIG.VITE_MODEL_ENCODER_REVISION ? { encoderRevision: CONFIG.VITE_MODEL_ENCODER_REVISION } : {}),
      ...(CONFIG.VITE_MODEL_ENCODER_SUBFOLDER ? { encoderSubfolder: CONFIG.VITE_MODEL_ENCODER_SUBFOLDER } : {}),
      ...(CONFIG.VITE_MODEL_ENCODER_FILE ? { encoderFilename: CONFIG.VITE_MODEL_ENCODER_FILE } : {}),
    } : {}),
    ...(CONFIG.VITE_MODEL_DECODER_REPO ? {
      decoderRepoId: CONFIG.VITE_MODEL_DECODER_REPO,
      ...(CONFIG.VITE_MODEL_DECODER_REVISION ? { decoderRevision: CONFIG.VITE_MODEL_DECODER_REVISION } : {}),
      ...(CONFIG.VITE_MODEL_DECODER_SUBFOLDER ? { decoderSubfolder: CONFIG.VITE_MODEL_DECODER_SUBFOLDER } : {}),
      ...(CONFIG.VITE_MODEL_DECODER_FILE ? { decoderFilename: CONFIG.VITE_MODEL_DECODER_FILE } : {}),
    } : {}),
    ...(CONFIG.VITE_MODEL_REVISION ? { revision: CONFIG.VITE_MODEL_REVISION } : {}),
  });
  const nMels = modelUrls.modelConfig?.featuresSize || 128;
  const model = await ParakeetModel.fromUrls({
    ...modelUrls.urls, filenames: modelUrls.filenames, backend: 'wasm',
    cpuThreads: Number(cpuThreads), preprocessorBackend: modelUrls.preprocessorBackend, nMels,
    collectTimings: true, enableProfiling,
  });
  const runMetrics = [];
  let transcript = '';
  for (let i = 0; i < runs; i++) {
    const res = await model.transcribeChunked(pcm, 16000, {
      enableChunking: chunking, chunkDurationSec: 60, overlapSec: 2,
      returnTimestamps: false, temperature: 0, beamWidth: 1, frameStride: 8,
      enableProfiling,
    });
    transcript = res.utterance_text || '';
    runMetrics.push({
      ...res.metrics,
      backend: 'wasm',
      numThreads: (model.ort && model.ort.env && model.ort.env.wasm && model.ort.env.wasm.numThreads) ?? null,
      crossOriginIsolated: typeof window !== 'undefined' && !!window.crossOriginIsolated,
    });
  }
  const profile = enableProfiling ? model.endProfiling() : null;
  if (profile) window.__ptProfile = profile;
  try { model.release?.(); } catch { /* ignore */ }
  return {
    runs: runMetrics,
    transcript,
    profile,
    env: {
      crossOriginIsolated: typeof window !== 'undefined' && !!window.crossOriginIsolated,
      ortWasmThreads: (typeof globalThis !== 'undefined' && globalThis.ort && globalThis.ort.env && globalThis.ort.env.wasm) ? (globalThis.ort.env.wasm.numThreads ?? null) : null,
      hardwareConcurrency: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) ?? null,
      modelSource, modelRepo: repoId, encoderQuant, cpuThreads: Number(cpuThreads),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    },
  };
}

/**
 * Encoder-only measurement for the Canary-180M experiment (branch `canary-web`).
 * Loads ONLY the FastConformer encoder from the LAN mirror (int8, ~134 MB), runs
 * the shared NeMo mel preprocessor, and reports per-run preprocess/encode times
 * plus the output shape (sanity: `[1, Tenc, D]`, no NaNs). No decoder yet, so
 * this is the M0 gate: if the Canary encoder is not clearly faster than
 * Parakeet's, the branch stops here.
 *
 * @param {Object} opts
 * @param {number} [opts.durationSec=20] Synthetic audio length (else url/pcmBase64).
 * @param {string} [opts.pcmBase64]      Base64 audio (else url / synthetic).
 * @param {string} [opts.url]            Audio URL.
 * @param {number} [opts.runs=2]
 * @param {number} [opts.cpuThreads=4]
 * @param {string} [opts.encoderUrl='/models-canary/encoder-model.int8.onnx']
 * @returns {Promise<Object>} { runs, env }
 */
/**
 * Full Canary transcription for an objective correctness check (M1 golden test).
 * Loads the Canary model from the LAN mirror (or HF when the config says
 * 'remote') and transcribes one clip, so the text can be compared to a known
 * reference (e.g. `/fixtures/jfk.mp3` -> `jfk.expected.txt` in English).
 *
 * @param {Object} opts
 * @param {string} [opts.url]        Audio URL (e.g. '/fixtures/jfk.mp3').
 * @param {string} [opts.pcmBase64]  Base64 audio.
 * @param {number} [opts.durationSec] Synthetic audio when no url/base64.
 * @param {string} [opts.language='en']
 * @param {string} [opts.targetLanguage]
 * @param {boolean} [opts.pnc=true]
 * @param {number} [opts.cpuThreads=4]
 * @returns {Promise<{text:string, ids:number[], metrics:object, env:object}>}
 */
export async function transcribeCanary(opts = {}) {
  const {
    url = null, pcmBase64 = null, durationSec = null,
    language = 'en', targetLanguage = null, pnc = true, cpuThreads = 4,
  } = opts;
  const pcm = pcmBase64 ? await pcmFromBase64(pcmBase64)
    : (url ? await pcmFromUrl(url) : synthPcm(durationSec || 5));
  const repo = CONFIG.VITE_CANARY_REPO || 'istupakov/canary-180m-flash-onnx';
  const source = CONFIG.VITE_MODEL_SOURCE || 'local';
  const base = CONFIG.VITE_CANARY_LOCAL_BASE || '/models-canary/';
  const u = (f) => (source === 'local'
    ? base.replace(/\/?$/, '/') + f
    : `https://huggingface.co/${repo}/resolve/main/${f}`);
  const model = await CanaryModel.fromUrls({
    encoderUrl: u('encoder-model.int8.onnx'),
    decoderUrl: u('decoder-model.int8.onnx'),
    vocabUrl: u('vocab.txt'),
    cpuThreads: Number(cpuThreads),
  });
  try {
    const res = await model.transcribe(pcm, { language, targetLanguage, pnc });
    return {
      text: res.text,
      ids: res.ids,
      metrics: res.metrics,
      env: {
        model: 'canary-180m-flash', audioSec: +(pcm.length / 16000).toFixed(2),
        language, targetLanguage, pnc, cpuThreads: Number(cpuThreads), source,
        crossOriginIsolated: typeof window !== 'undefined' && !!window.crossOriginIsolated,
      },
    };
  } finally {
    try { model.release(); } catch { /* ignore */ }
  }
}

export async function measureCanary(opts = {}) {
  const {
    durationSec = 20, pcmBase64 = null, url = null, runs = 2, cpuThreads = 4,
    encoderUrl = '/models-canary/encoder-model.int8.onnx',
  } = opts;
  const pcm = pcmBase64 ? await pcmFromBase64(pcmBase64) : (url ? await pcmFromUrl(url) : synthPcm(durationSec));
  const enc = await CanaryEncoder.fromUrls({ encoderUrl, backend: 'wasm', cpuThreads: Number(cpuThreads) });
  const runMetrics = [];
  try {
    for (let i = 0; i < runs; i++) runMetrics.push(await enc.encode(pcm));
  } finally {
    try { enc.release(); } catch { /* ignore */ }
  }
  return {
    runs: runMetrics,
    env: {
      model: 'canary-180m-flash',
      encoderUrl,
      audioSec: pcm.length / 16000,
      cpuThreads: Number(cpuThreads),
      crossOriginIsolated: typeof window !== 'undefined' && !!window.crossOriginIsolated,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    },
  };
}

/** Return the most recent per-op profile collected by a measure({enableProfiling:true}). */
export function profile() {
  return window.__ptProfile || null;
}

const RUN_KEY = 'ptBenchRun';

function mean(runs, field) {
  const vals = runs.map(r => Number(r[field])).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function finishMatrix(rows) {
  const valid = rows.filter(r => r.valid);
  console.log('[bench] === matrix done ===');
  console.table(rows.map(r => ({
    quant: r.encoderQuant, threads: r.cpuThreads, ortThreads: r.ortThreads ?? '—', valid: r.valid,
    encode_ms: r.encodeMs ? Math.round(r.encodeMs) : '—', rtf: r.rtf ? +r.rtf.toFixed(2) : '—', error: r.error || '',
  })));
  for (const q of [...new Set(valid.map(r => r.encoderQuant))]) {
    const of = valid.filter(r => r.encoderQuant === q).sort((a, b) => a.cpuThreads - b.cpuThreads);
    if (!of.length) continue;
    console.log(`${q}: ` + of.map(r => `${r.cpuThreads}t=${Math.round(r.encodeMs)}ms`).join('  '));
    for (const r of of.slice(1)) if (r.encodeMs && of[0].encodeMs) console.log(`   ${of[0].cpuThreads}t → ${r.cpuThreads}t: ${(of[0].encodeMs / r.encodeMs).toFixed(2)}×`);
  }
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), env: { hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent }, rows }, null, 2);
  try { navigator.clipboard?.writeText(json); console.log('[bench] JSON in die Zwischenablage kopiert (sonst aus __ptLastMatrix).'); } catch { /* ignore */ }
  window.__ptLastMatrix = rows;
  return rows;
}

/**
 * Run the full quant × threads matrix from the DevTools console — no install
 * needed. Each config needs a FRESH page (ORT memoizes initializeWebAssembly),
 * so the runner persists its state in localStorage, applies a config, reloads,
 * measures, and repeats; it finishes with a console.table + clipboard JSON.
 *
 *   await __ptBench.runMatrix({ quants:['int4','int8'], threads:[1,2,4], runs:3 })
 *
 * @param {Object} opts
 * @param {string[]} [opts.quants=['int4']]
 * @param {number[]} [opts.threads=[1,2,4]]
 * @param {number}   [opts.runs=3]
 * @param {number}   [opts.durationSec=20] Synthetic audio length (or pass url).
 * @param {string}   [opts.url=null]
 * @param {boolean}  [opts.profile=false]
 */
export function runMatrix(opts = {}) {
  const { quants = ['int4'], threads = [1, 2, 4], runs = 3, durationSec = 20, url = null, profile = false } = opts;
  const plan = [];
  for (const q of quants) for (const t of threads) plan.push({ encoderQuant: q, cpuThreads: Number(t) });
  localStorage.setItem(RUN_KEY, JSON.stringify({ plan, idx: 0, phase: 'apply', rows: [], opts: { runs, durationSec, url, profile } }));
  console.log(`[bench] matrix: ${plan.length} configs (${plan.map(c => `${c.encoderQuant}/${c.cpuThreads}t`).join(', ')}) — die Seite lädt pro Config neu.`);
  return resumeMatrix();
}

/** Resume/continue an in-progress matrix run (called automatically on install). */
export async function resumeMatrix() {
  let state = null;
  try { state = JSON.parse(localStorage.getItem(RUN_KEY) || 'null'); } catch { /* ignore */ }
  if (!state || !Array.isArray(state.plan)) return null;
  const { plan, idx, phase, rows, opts } = state;
  if (idx >= plan.length) { localStorage.removeItem(RUN_KEY); return finishMatrix(rows); }
  const cfg = plan[idx];
  if (phase === 'apply') {
    await writeSetting('encoderQuant', cfg.encoderQuant);
    await writeSetting('cpuThreads', cfg.cpuThreads);
    state.phase = 'measure';
    localStorage.setItem(RUN_KEY, JSON.stringify(state));
    console.log(`[bench] (${idx + 1}/${plan.length}) setze ${cfg.encoderQuant} × ${cfg.cpuThreads}t — Seite lädt neu …`);
    location.reload();
    return null;
  }
  console.log(`[bench] (${idx + 1}/${plan.length}) messe ${cfg.encoderQuant} × ${cfg.cpuThreads}t …`);
  try {
    const res = await measure({
      url: opts.url, durationSec: opts.durationSec, runs: opts.runs,
      encoderQuant: cfg.encoderQuant, cpuThreads: cfg.cpuThreads, enableProfiling: opts.profile,
    });
    const audioSec = mean(res.runs, 'audioSec');
    const totalMs = mean(res.runs, 'total_ms');
    rows.push({
      ...cfg, valid: res.env.ortWasmThreads === cfg.cpuThreads, ortThreads: res.env.ortWasmThreads,
      audioSec, encodeMs: mean(res.runs, 'encode_ms'), decodeMs: mean(res.runs, 'decode_ms'), totalMs,
      rtf: audioSec ? totalMs / 1000 / audioSec : null, transcript: (res.transcript || '').slice(0, 80),
      topOps: res.profile ? Object.values(res.profile).flatMap(p => p.topOps || []).slice(0, 20) : undefined,
    });
  } catch (e) {
    rows.push({ ...cfg, valid: false, error: String((e && e.message) || e) });
  }
  state.rows = rows; state.idx = idx + 1; state.phase = 'apply';
  localStorage.setItem(RUN_KEY, JSON.stringify(state));
  location.reload();
  return null;
}

/** Install the hook on window (idempotent). */
export function installBench() {
  if (typeof window === 'undefined') return;
  window.__ptBench = {
    version: 1,
    readSetting, writeSetting, measure, measureCanary, transcribeCanary, profile,
    synthPcm, pcmFromUrl, pcmFromBase64, runMatrix, resumeMatrix,
    async setConfig({ encoderQuant, cpuThreads, useWebGPU = false } = {}) {
      if (encoderQuant !== undefined) await writeSetting('encoderQuant', encoderQuant);
      if (cpuThreads !== undefined) await writeSetting('cpuThreads', Number(cpuThreads));
      await writeSetting('useWebGPU', !!useWebGPU);
    },
  };
  console.log('[bench] window.__ptBench installed');
  // Continue an interrupted runMatrix (state survives the per-config reloads).
  if (localStorage.getItem(RUN_KEY)) {
    setTimeout(() => { resumeMatrix().catch(e => console.warn('[bench] resume failed', e)); }, 1200);
  }
}
