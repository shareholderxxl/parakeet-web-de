import React, { useState, useRef, useEffect, useCallback } from 'react';
import Quill from 'quill';
import 'quill/dist/quill.snow.css';
import './App.css';
import { ParakeetModel, getParakeetModel, checkLocalModelFiles } from 'parakeet.js';
import { useI18n } from './i18n.jsx';
import { CONFIG } from './config.js';
import { openIdb, idbGet, idbPut, idbDeleteDatabase } from '../../src/idb.js';
import { resamplePcmTo16k, createLevelMonitor } from './lib/audio.js';
import { acquireKeepalive, releaseKeepalive } from './lib/keepalive.js';

/* ─── IndexedDB: Settings + Transkripte (Schema wie bisher, text-only) ─── */
const SETTINGS_DB_NAME = 'parakeetweb-settings-db';
const SETTINGS_STORE_NAME = 'settings-store';
const STORAGE_KEY_PREFIX = 'pw_';
const TRANSCRIPTS_DB_NAME = 'parakeetweb-transcripts-db';
const TRANSCRIPTS_STORE_NAME = 'transcripts-store';
const TRANSCRIPTS_KEY = 'transcripts';
const getSettingsDb = () => openIdb(SETTINGS_DB_NAME, SETTINGS_STORE_NAME);
const getTranscriptsDb = () => openIdb(TRANSCRIPTS_DB_NAME, TRANSCRIPTS_STORE_NAME);

async function loadSetting(key, def) {
  try {
    const v = await idbGet(await getSettingsDb(), SETTINGS_STORE_NAME, STORAGE_KEY_PREFIX + key);
    return v !== undefined ? v : def;
  } catch { return def; }
}
async function saveSetting(key, value) {
  try { await idbPut(await getSettingsDb(), SETTINGS_STORE_NAME, STORAGE_KEY_PREFIX + key, value); }
  catch (e) { console.warn(`saveSetting ${key} failed:`, e); }
}
function usePersistedSetting(key, value, loaded) {
  useEffect(() => { if (loaded) saveSetting(key, value); }, [key, value, loaded]);
}
function slimTranscriptForPersist(t) {
  return { id: t.id, text: t.text, timestamp: t.timestamp, wordCount: t.wordCount };
}
async function loadPersistedTranscripts() {
  try {
    const own = await idbGet(await getTranscriptsDb(), TRANSCRIPTS_STORE_NAME, TRANSCRIPTS_KEY);
    if (Array.isArray(own)) return own;
    const legacy = await idbGet(await getSettingsDb(), SETTINGS_STORE_NAME, STORAGE_KEY_PREFIX + 'transcriptions');
    return Array.isArray(legacy) ? legacy : [];
  } catch { return []; }
}
async function putTranscripts(arr) {
  try { await idbPut(await getTranscriptsDb(), TRANSCRIPTS_STORE_NAME, TRANSCRIPTS_KEY, arr.map(slimTranscriptForPersist)); }
  catch (e) { console.warn('saveTranscripts failed:', e); }
}
async function clearTranscriptsDb() { try { await idbDeleteDatabase(TRANSCRIPTS_DB_NAME); } catch {} }
async function clearAllSettings() { try { await idbDeleteDatabase(SETTINGS_DB_NAME); } catch {} }

function transcribeErrorMessage(error) {
  const msg = error?.message || String(error);
  if (/quota|storage|exceeded/i.test(msg)) return 'Zu wenig Speicher – Browserdaten/alte Transkripte löschen.';
  if (/Network|Failed to fetch|404/i.test(msg)) return 'Modell nicht erreichbar. Server läuft und /models gefüllt?';
  return msg;
}
function sanitizeClipboardText(s) {
  return String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200b-\u200f]/g, '');
}
async function fetchTextCapped(url, maxBytes = 5_000_000) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, text: '', declared: 0 };
    const declared = Number(res.headers.get('Content-Length')) || 0;
    if (declared > maxBytes) return { ok: false, oversize: true, text: '', declared };
    return { ok: true, text: await res.text(), declared };
  } catch (e) { return { ok: false, text: '', declared: 0 }; }
}
function parseCSVLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
function pyFlagsToJs(flags) {
  let js = 'g';
  if ((flags || '').includes('i')) js += 'i';
  if ((flags || '').includes('m')) js += 'm';
  if ((flags || '').includes('s')) js += 's';
  return js;
}

/* ─── Theme (Hell/Dunkel, Default Hell) ─── */
const THEME_KEY = 'portabletranscribe_theme';
function currentTheme() { return localStorage.getItem(THEME_KEY) || 'light'; }
export function applyThemeToDom(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0d1124' : '#f5f6fb');
}

/* ─── Sprachtexte für NEUE UI-Elemente (DE/EN) ─── */
const STR = {
  de: {
    app: 'portabletranscribe', navInput: 'Eingabe', navHistory: 'Historie',
    navSettings: 'Einstellungen', navAbout: 'Über',
    loadModel: 'Modell laden', loadingModel: 'Modell wird geladen…', modelReady: 'Bereit',
    record: 'Aufnahme', stop: 'Stopp', copy: 'Kopieren', copyPlain: 'Als Text kopieren',
    copied: 'Kopiert', clear: 'Leeren', dictationOn: 'Diktat-Modus',
    histTitle: 'Verlauf', histEmpty: 'Noch keine Transkripte.', insertToEditor: 'In Editor laden',
    delete: 'Löschen', delConfirm: 'Dieses Transkript dauerhaft löschen?', yes: 'Löschen', no: 'Abbrechen',
    micTitle: 'Mikrofon', langLabel: 'Transkriptionssprache', persistLabel: 'Transkripte speichern',
    autoCopyLabel: 'Automatisch kopieren', advanced: 'Erweitert', chunkLabel: 'Lange Audios segmentieren',
    chunkDurLabel: 'Segmentlänge (s)', beamLabel: 'Beam-Breite', threadsLabel: 'CPU-Threads',
    resetAll: 'Einstellungen & Verlauf zurücksetzen', resetConfirm: 'Alle Einstellungen und das Verlaufs-Gedächtnis wirklich löschen?',
    aboutDesc: 'portabletranscribe ist eine lokale Diktier-App: Sprache wird vollständig in deinem Browser transkribiert, Audio verlässt dein Gerät nicht.',
    aboutModel: 'Modell: NVIDIA Parakeet TDT 0.6B v3 (int4, 25 Sprachen inkl. Deutsch).',
    aboutFork: 'Diese App basiert auf / ist ein Fork von „parakeet_web“ (thiswillbeyourgithub).',
    aboutPrivacy: '100 % lokal – kein Konto, kein Tracking, keine Cloud.',
    licenses: 'Lizenzen & Quellen', close: 'Schließen', theme: 'Design',
    errNoModel: 'Bitte zuerst das Modell laden.', statusRecording: 'Aufnahme läuft…',
  },
  en: {
    app: 'portabletranscribe', navInput: 'Dictation', navHistory: 'History',
    navSettings: 'Settings', navAbout: 'About',
    loadModel: 'Load model', loadingModel: 'Loading model…', modelReady: 'Ready',
    record: 'Record', stop: 'Stop', copy: 'Copy', copyPlain: 'Copy as text',
    copied: 'Copied', clear: 'Clear', dictationOn: 'Dictation mode',
    histTitle: 'History', histEmpty: 'No transcripts yet.', insertToEditor: 'Insert into editor',
    delete: 'Delete', delConfirm: 'Permanently delete this transcript?', yes: 'Delete', no: 'Cancel',
    micTitle: 'Microphone', langLabel: 'Transcription language', persistLabel: 'Save transcripts',
    autoCopyLabel: 'Copy automatically', advanced: 'Advanced', chunkLabel: 'Chunk long audio',
    chunkDurLabel: 'Chunk length (s)', beamLabel: 'Beam width', threadsLabel: 'CPU threads',
    resetAll: 'Reset settings & history', resetConfirm: 'Really delete all settings and transcript history?',
    aboutDesc: 'portabletranscribe is a local dictation app: speech is transcribed entirely in your browser; audio never leaves your device.',
    aboutModel: 'Model: NVIDIA Parakeet TDT 0.6B v3 (int4, 25 languages incl. German).',
    aboutFork: 'This app is based on / a fork of “parakeet_web” (thiswillbeyourgithub).',
    aboutPrivacy: '100 % local — no account, no tracking, no cloud.',
    licenses: 'Licenses & sources', close: 'Close', theme: 'Theme',
    errNoModel: 'Load the model first.', statusRecording: 'Recording…',
  },
};

const MODELS = [
  { value: 'de', flag: '🇩🇪' }, { value: 'en', flag: '🇬🇧' }, { value: 'auto', flag: '🌐' },
];

export default function App() {
  const { lang, setLang } = useI18n();
  const tr = useCallback((k) => (STR[lang] && STR[lang][k]) || STR.en[k] || k, [lang]);

  const [view, setView] = useState(() => (location.hash.replace('#', '') || 'input'));
  useEffect(() => {
    const onHash = () => setView(location.hash.replace('#', '') || 'input');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (v) => { location.hash = v; setView(v); };

  // Settings
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [transcriptionLanguage, setTranscriptionLanguage] = useState('de');
  const [dictationEnabled, setDictationEnabled] = useState(true);
  const [persistTranscripts, setPersistTranscripts] = useState(true);
  const [autoCopy, setAutoCopy] = useState(false);
  const [enableChunking, setEnableChunking] = useState(true);
  const [chunkDuration, setChunkDuration] = useState(60);
  const [beamWidth, setBeamWidth] = useState(1);
  const [cpuThreads, setCpuThreads] = useState(4);
  const [theme, setTheme] = useState(currentTheme());
  const [showLicenses, setShowLicenses] = useState(false);

  // Engine / transcribe state
  const modelRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle|loading|ready|recording|transcribing|error
  const [error, setError] = useState(null);
  const [canRecord, setCanRecord] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [delTarget, setDelTarget] = useState(null);
  const [toast, setToast] = useState('');
  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 1800); };

  const [transcriptions, setTranscriptions] = useState([]);

  // Diktat-Regeln
  const [dictationRules, setDictationRules] = useState([]);
  async function loadDictationRegex() {
    try {
      const manifest = await fetchTextCapped('/dictation-regex/manifest.txt');
      if (!manifest.ok) return;
      const files = manifest.text.trim().split('\n').filter(f => f.endsWith('.csv'));
      const rules = [];
      for (const file of files) {
        const r = await fetchTextCapped(`/dictation-regex/${file}`);
        if (!r.ok) continue;
        const lines = r.text.trim().split('\n');
        const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
        const ri = header.indexOf('regex');
        const pi = header.indexOf('remplacement') >= 0 ? header.indexOf('remplacement') : header.indexOf('replacement');
        if (ri === -1 || pi === -1) continue;
        for (let i = 1; i < lines.length; i++) {
          const fields = parseCSVLine(lines[i]);
          let rx = fields[ri] ?? ''; let flags = 'gi';
          const m = rx.match(/^\(\?([a-z]+)\)(.*)$/); if (m) { flags = pyFlagsToJs(m[1]); rx = m[2]; }
          if (!rx) continue;
          try { new RegExp(rx, flags.replace(/g/g, '')); rules.push({ regex: rx, replacement: fields[pi] ?? '', flags }); } catch {}
        }
      }
      setDictationRules(rules);
    } catch (e) { console.warn('[Dictation] load failed:', e); }
  }
  function applyDictation(text) {
    if (!dictationEnabled || !dictationRules.length || !text) return text;
    let out = text;
    for (const rule of dictationRules) {
      try { out = out.replace(new RegExp(rule.regex, rule.flags), rule.replacement); } catch {}
    }
    return out;
  }

  useEffect(() => { loadDictationRegex(); }, []);

  // Settings + History laden
  useEffect(() => {
    (async () => {
      const [lng, dic, per, ac, ch, cd, bw, ct, hist] = await Promise.all([
        loadSetting('transcriptionLanguage', 'de'), loadSetting('dictationEnabled.v2', true),
        loadSetting('persistTranscripts', true), loadSetting('autoCopy', false),
        loadSetting('enableChunking', true), loadSetting('chunkDuration', 60),
        loadSetting('beamWidth', 1), loadSetting('cpuThreads', 4), loadPersistedTranscripts(),
      ]);
      setTranscriptionLanguage(lng); setDictationEnabled(!!dic); setPersistTranscripts(!!per);
      setAutoCopy(!!ac); setEnableChunking(!!ch); setChunkDuration(Number(cd) || 60);
      setBeamWidth(Number(bw) || 1); setCpuThreads(Number(ct) || 4);
      setTranscriptions(Array.isArray(hist) ? hist : []);
      setSettingsLoaded(true);
      applyThemeToDom(currentTheme());
    })();
  }, []);
  usePersistedSetting('transcriptionLanguage', transcriptionLanguage, settingsLoaded);
  usePersistedSetting('dictationEnabled.v2', dictationEnabled, settingsLoaded);
  usePersistedSetting('persistTranscripts', persistTranscripts, settingsLoaded);
  usePersistedSetting('autoCopy', autoCopy, settingsLoaded);
  usePersistedSetting('enableChunking', enableChunking, settingsLoaded);
  usePersistedSetting('chunkDuration', chunkDuration, settingsLoaded);
  usePersistedSetting('beamWidth', beamWidth, settingsLoaded);
  usePersistedSetting('cpuThreads', cpuThreads, settingsLoaded);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (persistTranscripts) putTranscripts(transcriptions); else clearTranscriptsDb();
  }, [transcriptions, persistTranscripts, settingsLoaded]);

  function setThemeAndStore(t) { setTheme(t); localStorage.setItem(THEME_KEY, t); applyThemeToDom(t); }

  /* ─── Quill editor (Eingabe) ─── */
  const editorEl = useRef(null);
  const quillRef = useRef(null);
  useEffect(() => {
    if (!editorEl.current || quillRef.current) return;
    const q = new Quill(editorEl.current, {
      theme: 'snow',
      placeholder: tr('aboutDesc').includes('lokale') ? 'Text diktieren oder tippen…' : 'Dictate or type…',
      modules: { toolbar: [['bold', 'italic', 'underline'], { list: 'ordered' }, { list: 'bullet' }, 'clean'] },
    });
    quillRef.current = q;
    return () => {};
  }, []);
  function caretIndex() {
    const q = quillRef.current; if (!q) return 0;
    const sel = q.getSelection();
    return sel ? sel.index : q.getLength() - 1;
  }
  function insertAtCaret(text) {
    const q = quillRef.current; if (!q || !text) return;
    const idx = caretIndex();
    q.insertText(idx, text, 'user');
    q.setSelection(idx + text.length, 0);
    q.focus();
  }
  async function copyEditor(rich) {
    const q = quillRef.current; if (!q) return;
    const root = q.root;
    const plain = sanitizeClipboardText(q.getText().replace(/\n$/, ''));
    try {
      if (rich && navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([root.innerHTML], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        })]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
      flash(tr('copied'));
    } catch (e) { console.error(e); flash(tr('copy') + ' ✗'); }
  }
  function clearEditor() { quillRef.current?.setText(''); quillRef.current?.focus(); }

  /* ─── Modell laden ─── */
  const repoId = CONFIG.VITE_MODEL_REPO || 'efederici/parakeet-tdt-0.6b-v3-onnx-int4';
  async function loadModel() {
    setStatus('loading'); setError(null);
    try {
      const progress = () => {};
      const modelUrls = await getParakeetModel(repoId, {
        encoderQuant: 'int4', decoderQuant: 'int8', preprocessor: 'js',
        backend: 'wasm', cpuThreads, progress,
        localFallbackBaseUrl: '/models',
        ...(CONFIG.VITE_MODEL_REVISION ? { revision: CONFIG.VITE_MODEL_REVISION } : {}),
      });
      const nMels = modelUrls.modelConfig?.featuresSize || 80;
      modelRef.current = await ParakeetModel.fromUrls({
        ...modelUrls.urls, filenames: modelUrls.filenames, backend: 'wasm',
        cpuThreads, preprocessorBackend: modelUrls.preprocessorBackend, nMels,
      });
      setStatus('ready'); setCanRecord(true);
    } catch (e) {
      console.error('[loadModel]', e); setError(transcribeErrorMessage(e)); setStatus('error');
    }
  }

  /* ─── Mikrofon + Aufnahme ─── */
  const mediaRef = useRef([]);
  const ctxRef = useRef(null);
  const workletRef = useRef(null);
  const chunksRef = useRef([]);
  const rateRef = useRef(48000);
  async function startRecording() {
    if (!modelRef.current) { setError(tr('errNoModel')); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      mediaRef.current = stream.getTracks();
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      await ctx.audioWorklet.addModule('/pcm-recorder-worklet.js');
      const node = new AudioWorkletNode(ctx, 'pcm-recorder-processor');
      chunksRef.current = [];
      node.port.onmessage = (e) => { if (Array.isArray(e.data)) e.data.forEach(c => chunksRef.current.push(c)); else chunksRef.current.push(e.data); };
      src.connect(node); // not to destination (no feedback)
      const monitor = createLevelMonitor(ctx, src, setLevel);
      ctxRef.current = ctx; workletRef.current = node; rateRef.current = ctx.sampleRate;
      node._monitor = monitor;
      setIsRecording(true); setStatus('recording');
      acquireKeepalive();
    } catch (e) { console.error('[mic]', e); setError('Mikrofon verweigert/unverfügbar: ' + (e.message || e)); }
  }
  async function stopAndTranscribe() {
    if (!isRecording) return;
    setIsRecording(false); setStatus('transcribing');
    try { workletRef.current?.port?.close?.(); } catch {}
    const ctx = ctxRef.current;
    mediaRef.current.forEach(t => t.stop()); mediaRef.current = [];
    const nativeRate = rateRef.current;
    let pcm = chunksRef.current.length ? concatFloat(chunksRef.current) : new Float32Array(0);
    chunksRef.current = [];
    if (ctx) { try { await ctx.close(); } catch {} ctxRef.current = null; }
    releaseKeepalive();
    setLevel(0);
    if (!pcm.length) { setStatus('ready'); return; }
    try {
      const audio16 = await resamplePcmTo16k(pcm, nativeRate);
      const dur = audio16.length / 16000;
      const res = await modelRef.current.transcribeChunked(audio16, 16000, {
        enableChunking, chunkDurationSec: chunkDuration, overlapSec: 2,
        returnTimestamps: true, temperature: 0, beamWidth, frameStride: 8, enableProfiling: false,
      });
      let text = res.utterance_text || '';
      const entry = { id: Date.now(), text, timestamp: new Date().toLocaleString(lang === 'de' ? 'de-DE' : 'en-US'), wordCount: (text.match(/\S+/g) || []).length };
      setTranscriptions(prev => [entry, ...prev]);
      insertAtCaret(applyDictation(text));
      if (autoCopy) { try { await navigator.clipboard.writeText(sanitizeClipboardText(applyDictation(text))); flash(tr('copied')); } catch {} }
    } catch (e) { console.error('[transcribe]', e); setError(transcribeErrorMessage(e)); }
    setStatus('ready');
  }
  function concatFloat(chunks) {
    let len = 0; for (const c of chunks) len += c.length;
    const out = new Float32Array(len); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  const preventBlur = (e) => e.preventDefault(); // keep caret in Quill

  return (
    <div className="pt-app">
      <nav className="pt-nav" aria-label="Navigation">
        <div className="pt-brand">{tr('app')}</div>
        <a href="#input" className={`pt-navlink ${view === 'input' ? 'active' : ''}`} aria-current={view === 'input'} onClick={() => go('input')}>🎤 {tr('navInput')}</a>
        <a href="#history" className={`pt-navlink ${view === 'history' ? 'active' : ''}`} aria-current={view === 'history'} onClick={() => go('history')}>🗂 {tr('navHistory')}</a>
        <a href="#settings" className={`pt-navlink ${view === 'settings' ? 'active' : ''}`} aria-current={view === 'settings'} onClick={() => go('settings')}>⚙️ {tr('navSettings')}</a>
        <a href="#about" className={`pt-navlink ${view === 'about' ? 'active' : ''}`} aria-current={view === 'about'} onClick={() => go('about')}>ℹ️ {tr('navAbout')}</a>
        <div className="pt-navfoot">
          <button className="pt-theme" onClick={() => setThemeAndStore(theme === 'dark' ? 'light' : 'dark')} aria-label={tr('theme')}>
            {theme === 'dark' ? '🌙' : '☀️'}
          </button>
        </div>
      </nav>

      <main className="pt-main">
        <header className="pt-status" aria-live="polite">
          <span className={`dot ${status}`} aria-hidden="true"></span>
          <span>{status === 'ready' || status === 'recording' ? tr('modelReady') : status === 'error' ? (error || tr('loadModel')) : status === 'loading' ? tr('loadingModel') : status === 'transcribing' ? '…' : ''} </span>
          {status !== 'ready' && status !== 'recording' && status !== 'transcribing' && status !== 'error' && (
            <button className="pt-btn primary" style={{ marginLeft: 'auto' }} onClick={loadModel} disabled={status === 'loading'}>
              {status === 'loading' ? tr('loadingModel') : tr('loadModel')}
            </button>
          )}
          {status === 'error' && <button className="pt-btn" style={{ marginLeft: 'auto' }} onClick={loadModel}>{tr('loadModel')}</button>}
        </header>

        {view === 'input' && (
          <section className="pt-input">
            <div className="pt-editor-wrap">
              <div className="pt-editor-tools">
                <button className="pt-btn" onMouseDown={preventBlur} onClick={async (e) => { e.stopPropagation(); await copyEditor(true); }}>📋 {tr('copy')}</button>
                <button className="pt-btn ghost" onMouseDown={preventBlur} onClick={async (e) => { e.stopPropagation(); await copyEditor(false); }}>{tr('copyPlain')}</button>
                <button className="pt-btn ghost" onMouseDown={preventBlur} onClick={(e) => { e.stopPropagation(); clearEditor(); }}>{tr('clear')}</button>
                <span className="spacer"></span>
                <label className="pt-inline"><input type="checkbox" checked={dictationEnabled} onChange={e => setDictationEnabled(e.target.checked)} /> {tr('dictationOn')}</label>
              </div>
              <div ref={editorEl} className="pt-editor"></div>
            </div>
            <div className="pt-recbar">
              <div className="pt-level" style={{ '--v': level }} aria-hidden="true"></div>
              {status !== 'recording' ? (
                <button className="pt-btn record" onMouseDown={preventBlur} onClick={(e) => { e.stopPropagation(); if (canRecord) startRecording(); else loadModel(); }}>
                  ● {canRecord ? tr('record') : tr('loadModel')}
                </button>
              ) : (
                <button className="pt-btn stop" onClick={stopAndTranscribe}>■ {tr('stop')}</button>
              )}
              <span className="pt-lang"><select value={transcriptionLanguage} onChange={e => setTranscriptionLanguage(e.target.value)} aria-label={tr('langLabel')} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}>
                {MODELS.map(m => <option key={m.value} value={m.value}>{m.flag}</option>)}
              </select></span>
            </div>
          </section>
        )}

        {view === 'history' && (
          <section className="pt-history">
            <h2>{tr('histTitle')}</h2>
            {transcriptions.length === 0 ? <p className="pt-empty">{tr('histEmpty')}</p> : (
              <ul className="pt-histlist">
                {transcriptions.map(t => (
                  <li key={t.id}>
                    <div className="pt-histbody">
                      <div className="pt-histtext">{t.text || ''}</div>
                      <div className="pt-histmeta">{t.timestamp}</div>
                    </div>
                    <div className="pt-histacts">
                      <button className="pt-btn" onClick={() => { go('input'); setTimeout(() => insertAtCaret(applyDictation(t.text || '')), 60); }}>{tr('insertToEditor')}</button>
                      <button className="pt-btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(sanitizeClipboardText(t.text || '')); flash(tr('copied')); } catch {} }}>📋</button>
                      <button className="pt-btn danger" onClick={() => setDelTarget(t.id)}>{tr('delete')}</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {view === 'settings' && (
          <section className="pt-settings">
            <h2>{tr('navSettings')}</h2>
            <label className="pt-row"><span>{tr('langLabel')}</span>
              <select value={transcriptionLanguage} onChange={e => setTranscriptionLanguage(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}>
                <option value="de">Deutsch</option><option value="en">English</option><option value="auto">Auto</option>
              </select></label>
            <label className="pt-row"><span>{tr('dictationOn')}</span><input type="checkbox" checked={dictationEnabled} onChange={e => setDictationEnabled(e.target.checked)} /></label>
            <label className="pt-row"><span>{tr('persistLabel')}</span><input type="checkbox" checked={persistTranscripts} onChange={e => setPersistTranscripts(e.target.checked)} /></label>
            <label className="pt-row"><span>{tr('autoCopyLabel')}</span><input type="checkbox" checked={autoCopy} onChange={e => setAutoCopy(e.target.checked)} /></label>
            <fieldset className="pt-fieldset"><legend>{tr('advanced')}</legend>
              <label className="pt-row"><span>{tr('chunkLabel')}</span><input type="checkbox" checked={enableChunking} onChange={e => setEnableChunking(e.target.checked)} /></label>
              <label className="pt-row"><span>{tr('chunkDurLabel')}</span><input type="number" min="5" max="600" value={chunkDuration} onChange={e => setChunkDuration(e.target.value)} /></label>
              <label className="pt-row"><span>{tr('beamLabel')}</span><select value={beamWidth} onChange={e => setBeamWidth(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="5">5</option></select></label>
              <label className="pt-row"><span>{tr('threadsLabel')}</span><select value={cpuThreads} onChange={e => setCpuThreads(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}><option value="2">2</option><option value="4">4</option><option value="8">8</option></select></label>
            </fieldset>
            <h3>Interface</h3>
            <label className="pt-row"><span>{tr('langLabel')} (UI)</span>
              <select value={lang} onChange={e => setLang(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}><option value="de">Deutsch</option><option value="en">English</option></select></label>
            <div className="pt-row"><span>{tr('theme')}</span>
              <button className="pt-btn" onClick={() => setThemeAndStore(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '🌙 Dunkel' : '☀️ Hell'}</button></div>
            <hr />
            <button className="pt-btn danger" onClick={() => setConfirmReset(true)}>{tr('resetAll')}</button>
          </section>
        )}

        {view === 'about' && (
          <section className="pt-about">
            <h2>{tr('app')}</h2>
            <p>{tr('aboutDesc')}</p>
            <p className="pt-lock">🔒 {tr('aboutPrivacy')}</p>
            <p className="pt-muted">{tr('aboutModel')}</p>
            <p className="pt-muted">{tr('aboutFork')}</p>
            <button className="pt-btn ghost" onClick={() => setShowLicenses(s => !s)} aria-expanded={showLicenses}>{tr('licenses')}</button>
            {showLicenses && (
              <div className="pt-licenses">
                <p>portabletranscribe is a fork/simplification of <strong>parakeet_web</strong> by thiswillbeyourgithub (AGPL-3.0).</p>
                <ul>
                  <li>ASR engine: parakeet.js (MIT), fork of ysdede/parakeet.js</li>
                  <li>Model: NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0); ONNX by istupakov; int4 by efederici; SmoothQuant by Olicorne</li>
                  <li>onnxruntime-web (MIT) · Preact (MIT) · Quill (BSD-3-Clause) · ffmpeg.wasm (GPL)</li>
                  <li>Whole application: AGPL-3.0 (see LICENSE)</li>
                </ul>
              </div>
            )}
          </section>
        )}

        {toast && <div className="pt-toast" role="status" aria-live="polite">{toast}</div>}

        {confirmReset && (
          <div className="pt-modal-bg" onClick={() => setConfirmReset(false)}>
            <div className="pt-modal" role="dialog" aria-modal="true" aria-labelledby="reset-t" onClick={e => e.stopPropagation()}>
              <h3 id="reset-t">{tr('resetAll')}</h3><p>{tr('resetConfirm')}</p>
              <div className="pt-modal-actions">
                <button className="pt-btn danger" onClick={async () => { await clearAllSettings(); await clearTranscriptsDb(); setTranscriptions([]); setConfirmReset(false); }}>{tr('yes')}</button>
                <button className="pt-btn" onClick={() => setConfirmReset(false)}>{tr('no')}</button>
              </div>
            </div>
          </div>
        )}
        {delTarget != null && (
          <div className="pt-modal-bg" onClick={() => setDelTarget(null)}>
            <div className="pt-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
              <p>{tr('delConfirm')}</p>
              <div className="pt-modal-actions">
                <button className="pt-btn danger" onClick={() => { setTranscriptions(p => p.filter(x => x.id !== delTarget)); setDelTarget(null); }}>{tr('yes')}</button>
                <button className="pt-btn" onClick={() => setDelTarget(null)}>{tr('no')}</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
