// int4 Empirie-Test: fromUrls mit int4-Encoder im WASM-Backend.
// Fragestellung: unterstützt onnxruntime-web WASM-EP int4-MatMulNBits?
import { fromUrls } from 'parakeet.js';

const BASE = '/models-int4';
const logEl = document.getElementById('log');
const resultEl = document.getElementById('result');
const loadStatus = document.getElementById('loadStatus');
const recStatus = document.getElementById('recStatus');

const log = (msg) => {
  logEl.textContent += msg + '\n';
  console.log('[int4-test]', msg);
};

let model = null;
let recorder = null;
let chunks = [];
let audioCtx = null;

async function loadModel() {
  loadStatus.textContent = 'lädt... (391 MB, erste Ladung ca. 1-2 min über LAN)';
  const t0 = performance.now();
  try {
    model = await fromUrls({
      encoderUrl: `${BASE}/encoder-model.int4.onnx`,
      decoderUrl: `${BASE}/decoder_joint-model.int8.onnx`,
      tokenizerUrl: `${BASE}/vocab.txt`,
      preprocessorBackend: 'js',
      backend: 'wasm',
    });
    log(`✅ Modell geladen in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    loadStatus.textContent = 'bereit ✔';
  } catch (e) {
    log(`❌ LADEFEHLER: ${e?.message || e}`);
    loadStatus.textContent = 'FEHLER (siehe Log)';
  }
}

async function transcribe(pcm16k, label) {
  if (!model) { alert('Erst Modell laden!'); return; }
  resultEl.textContent = `${label}: transkribiere...`;
  const t0 = performance.now();
  try {
    const res = await model.transcribe(pcm16k, 16000, { returnTimestamps: false });
    const secs = ((performance.now() - t0) / 1000).toFixed(2);
    const dur = (pcm16k.length / 16000).toFixed(1);
    const text = res?.utterance_text ?? JSON.stringify(res);
    log(`⏱️ ${label}: ${secs} s für ${dur} s Audio (RTFx ≈ ${(dur / parseFloat(secs)).toFixed(2)})`);
    resultEl.textContent = `${label} → ${text}`;
  } catch (e) {
    log(`❌ TRANSKRIPTIONS-FEHLER: ${e?.message || e}`);
    resultEl.textContent = `Fehler: ${e?.message || e}`;
  }
}

async function startRecord() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  chunks = [];
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream);
  const dest = audioCtx.createMediaStreamDestination();
  src.connect(dest);
  recorder = new MediaRecorder(dest.stream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: recorder.mimeType });
    const ab = await blob.arrayBuffer();
    const pcm = await decodeToPcm16k(ab);
    await transcribe(pcm, 'Mikro');
  };
  recorder.start();
  recStatus.textContent = 'aufnahme läuft...';
  document.getElementById('btnStop').disabled = false;
  // Auto-Stop nach 5 s
  setTimeout(() => document.getElementById('btnStop').click(), 5000);
}

function stopRecord() {
  recorder?.stop();
  audioCtx?.close();
  recStatus.textContent = 'fertig';
  document.getElementById('btnStop').disabled = true;
}

async function decodeToPcm16k(arrayBuffer) {
  // Over 50% resample via OfflineAudioContext (wie App audio.js).
  const ac = new AudioContext();
  const buf = await ac.decodeAudioData(arrayBuffer);
  const target = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * target), target);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  await ac.close();
  return rendered.getChannelData(0);
}

document.getElementById('btnLoad').onclick = loadModel;
document.getElementById('btnRecord').onclick = startRecord;
document.getElementById('btnStop').onclick = stopRecord;
document.getElementById('fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ab = await file.arrayBuffer();
  const pcm = await decodeToPcm16k(ab);
  await transcribe(pcm, `Datei ${file.name}`);
};

log('Bereit. "int4-Modell laden" klicken.');
