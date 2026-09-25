import React, { useState, useRef, useEffect, useCallback } from 'react';
import Quill from 'quill';
import 'quill/dist/quill.snow.css';
import './App.css';
import { ParakeetModel, getParakeetModel, checkLocalModelFiles, defaultWasmThreads, CanaryModel } from 'parakeet.js';
import { useI18n } from './i18n.jsx';
import { CONFIG } from './config.js';
import { openIdb, idbGet, idbPut, idbDeleteDatabase } from '../../src/idb.js';
import { resamplePcmTo16k, createLevelMonitor } from './lib/audio.js';
import { acquireKeepalive, releaseKeepalive } from './lib/keepalive.js';
import { buildExportJson, buildExportTxt, exportFilename, parseImportJson, mergeEntries, downloadBlob } from './lib/historyIo.js';
import { applyUserRules, validateRule } from './lib/dictationRules.js';
import { restoreCpuThreads } from './lib/cpuThreads.js';

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
// Obergrenze fuer den Thread-Slider: ORTs Heuristik (min(4, ceil(hc/2))) schaetzt
// physische Kerne. Mehr Threads als physische Kerne sind Oversubscription und
// bremsen ORTs spin-waitenden WASM-Pool.
const MAX_CORES = (typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency) && navigator.hardwareConcurrency > 0) ? navigator.hardwareConcurrency : 8;
const MAX_THREADS = defaultWasmThreads(MAX_CORES);

// Bench/Debug-Hook nur mit ?bench=1 (siehe lib/bench.js). Dynamischer Import,
// damit das Modul im Normalbetrieb nicht geladen wird.
const BENCH_ENABLED = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('bench');
if (BENCH_ENABLED) { import('./lib/bench.js').then(m => m.installBench()).catch(e => console.warn('[bench]', e)); }

function usePersistedSetting(key, value, loaded) {
  useEffect(() => { if (loaded) saveSetting(key, value); }, [key, value, loaded]);
}
function slimTranscriptForPersist(t) {
  const out = { id: t.id, text: t.text, timestamp: t.timestamp, wordCount: t.wordCount };
  if (Number.isFinite(t.durationSec)) out.durationSec = t.durationSec;
  return out;
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
function normalizeForSearch(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}
function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${r} s`;
  return `${r} s`;
}
function formatDay(ts, lang) {
  if (!Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
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
    loadModel: 'Modell laden', loadingModel: 'Modell wird geladen…', modelReady: 'Bereit', transcribing: 'Transkribiere…',
    record: 'Aufnahme', stop: 'Stopp', copy: 'Kopieren', copyPlain: 'Als Text kopieren',
    copied: 'Kopiert', clear: 'Leeren', dictationOn: 'Diktat-Modus',
    saveToHistory: 'In Historie speichern', savedToHistory: 'In Historie gespeichert',
    draftRestored: 'Entwurf wiederhergestellt',
    exportAll: 'Alle exportieren', exportFormatTitle: 'Export-Format wählen',
    exportFormatHint: 'Die komplette Historie wird in eine Datei exportiert.',
    exportJson: 'JSON-Backup (re-importierbar)', exportTxt: 'Textdatei (.txt, lesbar)',
    exportEntry: 'Als Textdatei speichern', importJson: 'JSON importieren',
    histSearch: 'Historie durchsuchen', histNoMatch: 'Keine Treffer.', histCount: '{n} von {total} Einträgen', histClear: 'Suche leeren',
    customRules: 'Eigene Ersetzungen', customRulesHint: 'Zusätzlich zu den festen Regeln; werden zuletzt angewendet.',
    ruleFind: 'Suchen', ruleReplace: 'Ersetzen', ruleRegex: 'Regex', ruleCase: 'Groß/Klein beachten',
    addRule: 'Hinzufügen', ruleEmpty: 'Bitte einen Suchbegriff angeben.', ruleInvalidRegex: 'Ungültiger regulärer Ausdruck.',
    noRules: 'Noch keine eigenen Ersetzungen.',
    navStats: 'Statistik', statsEmpty: 'Noch keine Daten vorhanden.', words: 'Wörter',
    statEntries: 'Einträge', statWords: 'Wörter gesamt', statAvg: 'Ø Wörter pro Eintrag',
    statDuration: 'Aufnahmedauer gesamt', statDurationHint: 'wird erst seit Einführung erfasst – ältere Einträge ohne Dauer',
    statFirst: 'Ältester Eintrag', statLast: 'Neuester Eintrag',
    perfTitle: 'Performance (letzte Transkription)', perfAvgTitle: 'Ø dieser Sitzung', perfRuns: 'Läufe',
    perfAudio: 'Audio', perfTotal: 'Gesamt', perfRtf: 'RTF (Verarbeitung/Audio)',
    perfPre: 'Vorverarbeitung', perfEnc: 'Encoder', perfDec: 'Decoder', perfTok: 'Tokenizer',
    perfBackend: 'Backend', perfThreads: 'Threads', perfCoi: 'Cross-Origin-Isolation',
    perfYes: 'ja', perfNo: 'nein', perfEmpty: 'Noch keine Messwerte – einmal transkribieren.', perfCopy: 'Messwerte kopieren', perfCopyProfile: 'Profil kopieren',
    threadsHint: 'Threads wirken nur mit Cross-Origin-Isolation (LAN/Cloudflare) und nur auf den Encoder; auf GitHub Pages nicht verfügbar (dann 1 Thread). Höchstens so viele Threads wie physische Kerne. Änderungen greifen erst nach einem vollständigen Seiten-Neuladen (F5).',
    importConfirm: '{n} Einträge importieren? Bestehende Einträge bleiben erhalten.',
    importYes: 'Importieren', importedCount: '{n} Einträge importiert', importInvalid: 'Import fehlgeschlagen – keine gültige Historie-Datei.',
    histTitle: 'Verlauf', histEmpty: 'Noch keine Transkripte.', insertToEditor: 'In Editor laden',
    delete: 'Löschen', delConfirm: 'Dieses Transkript dauerhaft löschen?', yes: 'Löschen', no: 'Abbrechen',
    micTitle: 'Mikrofon', langLabel: 'Sprache (UI)', persistLabel: 'Transkripte speichern',
    persistOffWarn: 'Speichern ist deaktiviert – der Verlauf geht beim Neuladen verloren.', persistEnable: 'Aktivieren',
    langAuto: 'Die Transkriptionssprache wird automatisch erkannt (25 Sprachen inkl. Deutsch).',
    autoCopyLabel: 'Automatisch kopieren', advanced: 'Erweitert', chunkLabel: 'Lange Audios segmentieren',
    chunkDurLabel: 'Segmentlänge (s)', threadsLabel: 'CPU-Threads',
    modelLabel: 'Modell', modelParakeet: 'Parakeet TDT 0.6B v3 (int4)',
    modelCanary: 'Canary 180M Flash (Experiment)', canaryLangLabel: 'Sprache',
    canaryPncLabel: 'Zeichensetzung/Großschreibung',
    canaryHint: 'Canary 180M (en/de/es/fr), AED-Modell, nur CPU/WASM. Kleiner (213 MB), aber Decoder läuft Token für Token — Tempo testen. Nach dem Umschalten neu laden.',
    gpuLabel: 'GPU (WebGPU) verwenden', gpuActive: 'GPU-Backend aktiv',
    gpuInt4Note: 'WebGPU nutzt immer den int4-Encoder (int8 laeuft nur auf CPU). Achtung: In der aktuellen ORT-Version (1.27) rechnet int4 auf WebGPU mit fp16-Akkumulation und liefert teils falsche Texte – bis zum ORT-Update nicht empfehlenswert.',
    reloadNeeded: 'Geänderte Einstellung – Seite neu laden, damit sie wirkt.', reloadNow: 'Seite neu laden',
    encQuantLabel: 'Encoder-Quantisierung', encQuantHint: 'int4 = kleiner (391 MB), int8 = groesser (~880 MB), auf CPU/WASM oft deutlich schneller. Aenderung greift nach einem vollstaendigen Seiten-Neuladen (F5).',
    gpuHint: 'Experimentell: Der Encoder läuft auf der GPU, der Decoder auf der CPU. Bei Fehlern automatischer CPU-Fallback; Perf-Logs erscheinen in der Konsole.',
    gpuUnavailable: 'WebGPU ist in diesem Browser/Gerät nicht verfügbar.',
    gpuFallback: 'WebGPU fehlgeschlagen – CPU-Backend aktiv.',
    resetAll: 'Einstellungen & Verlauf zurücksetzen', resetConfirm: 'Alle Einstellungen und das Verlaufs-Gedächtnis wirklich löschen?',
    cachePersistLabel: 'Modell-Cache', cachePersistYes: 'dauerhaft gespeichert',
    cachePersistNo: 'nur best effort – kann unter Speicherdruck entfernt werden',
    cachePersistUnknown: 'nicht geprüft', cachePersistAsk: 'Dauerhaft schützen',
    aboutDesc: 'portabletranscribe ist eine lokale Diktier-App: Sprache wird vollständig in deinem Browser transkribiert, Audio verlässt dein Gerät nicht.',
    aboutModel: 'Modell: NVIDIA Parakeet TDT 0.6B v3 (int4, 25 Sprachen inkl. Deutsch).',
    aboutFork: 'Diese App basiert auf / ist ein Fork von „parakeet_web“ (thiswillbeyourgithub).',
    aboutPrivacy: '100 % lokal – kein Konto, kein Tracking, keine Cloud.',
    installTitle: 'Als App installieren (PWA)',
    installDesktop: 'Chrome/Edge am Computer: Installations-Symbol in der Adressleiste oder Menü ⋮ → „Seite als App installieren“.',
    installMobile: 'Android: Menü ⋮ → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.',
    installHttps: 'Benötigt HTTPS mit gültigem Zertifikat – im LAN ggf. das Zertifikat vertrauen.',
    licenses: 'Lizenzen & Quellen', close: 'Schließen', theme: 'Design', privacy: 'Datenschutz', themeLight: 'Hell', themeDark: 'Dunkel', switchLang: 'Sprache wechseln',
    errNoModel: 'Bitte zuerst das Modell laden.', statusRecording: 'Aufnahme läuft…',
  },
  en: {
    app: 'portabletranscribe', navInput: 'Dictation', navHistory: 'History',
    navSettings: 'Settings', navAbout: 'About',
    loadModel: 'Load model', loadingModel: 'Loading model…', modelReady: 'Ready', transcribing: 'Transcribing…',
    record: 'Record', stop: 'Stop', copy: 'Copy', copyPlain: 'Copy as text',
    copied: 'Copied', clear: 'Clear', dictationOn: 'Dictation mode',
    saveToHistory: 'Save to history', savedToHistory: 'Saved to history',
    draftRestored: 'Draft restored',
    exportAll: 'Export all', exportFormatTitle: 'Choose export format',
    exportFormatHint: 'The complete history will be exported to a single file.',
    exportJson: 'JSON backup (re-importable)', exportTxt: 'Text file (.txt, readable)',
    exportEntry: 'Save as text file', importJson: 'Import JSON',
    histSearch: 'Search history', histNoMatch: 'No matches.', histCount: '{n} of {total} entries', histClear: 'Clear search',
    customRules: 'Custom replacements', customRulesHint: 'In addition to the built-in rules; applied last.',
    ruleFind: 'Find', ruleReplace: 'Replace with', ruleRegex: 'Regex', ruleCase: 'Case sensitive',
    addRule: 'Add', ruleEmpty: 'Please enter a search term.', ruleInvalidRegex: 'Invalid regular expression.',
    noRules: 'No custom replacements yet.',
    navStats: 'Statistics', statsEmpty: 'No data yet.', words: 'words',
    statEntries: 'Entries', statWords: 'Total words', statAvg: 'Avg. words per entry',
    statDuration: 'Total recording time', statDurationHint: 'recorded only recently – older entries have no duration',
    statFirst: 'Oldest entry', statLast: 'Newest entry',
    perfTitle: 'Performance (last transcription)', perfAvgTitle: 'Session average', perfRuns: 'runs',
    perfAudio: 'Audio', perfTotal: 'Total', perfRtf: 'RTF (processing/audio)',
    perfPre: 'Preprocessing', perfEnc: 'Encoder', perfDec: 'Decoder', perfTok: 'Tokenizer',
    perfBackend: 'Backend', perfThreads: 'Threads', perfCoi: 'Cross-origin isolation',
    perfYes: 'yes', perfNo: 'no', perfEmpty: 'No measurements yet – run a transcription.', perfCopy: 'Copy measurements', perfCopyProfile: 'Copy profile',
    threadsHint: 'Threads only take effect with cross-origin isolation (LAN/Cloudflare) and only for the encoder; unavailable on GitHub Pages (1 thread there). At most one thread per physical core. Changes apply only after a full page reload (F5).',
    importConfirm: 'Import {n} entries? Existing entries are kept.',
    importYes: 'Import', importedCount: 'Imported {n} entries', importInvalid: 'Import failed – not a valid history file.',
    histTitle: 'History', histEmpty: 'No transcripts yet.', insertToEditor: 'Insert into editor',
    delete: 'Delete', delConfirm: 'Permanently delete this transcript?', yes: 'Delete', no: 'Cancel',
    micTitle: 'Microphone', langLabel: 'Language (UI)', persistLabel: 'Save transcripts',
    persistOffWarn: 'Saving is disabled – history will be lost on reload.', persistEnable: 'Enable',
    langAuto: 'The transcription language is detected automatically (25 languages incl. German).',
    autoCopyLabel: 'Copy automatically', advanced: 'Advanced', chunkLabel: 'Chunk long audio',
    chunkDurLabel: 'Chunk length (s)', threadsLabel: 'CPU threads',
    modelLabel: 'Model', modelParakeet: 'Parakeet TDT 0.6B v3 (int4)',
    modelCanary: 'Canary 180M Flash (experimental)', canaryLangLabel: 'Language',
    canaryPncLabel: 'Punctuation/capitalization',
    canaryHint: 'Canary 180M (en/de/es/fr), an AED model, CPU/WASM only. Smaller (213 MB), but the decoder runs token by token — test the speed. Reload after switching.',
    gpuLabel: 'Use GPU (WebGPU)', gpuActive: 'GPU backend active',
    gpuInt4Note: 'WebGPU always uses the int4 encoder (int8 runs on CPU only). Warning: with the current ORT version (1.27) int4 on WebGPU accumulates in fp16 and can return wrong text – not recommended until ORT is updated.',
    reloadNeeded: 'Setting changed – reload the page for it to take effect.', reloadNow: 'Reload page',
    encQuantLabel: 'Encoder quantization', encQuantHint: 'int4 = smaller (391 MB), int8 = larger (~880 MB), often much faster on CPU/WASM. Change applies after a full page reload (F5).',
    gpuHint: 'Experimental: the encoder runs on the GPU, the decoder on the CPU. Automatic CPU fallback on failure; perf logs appear in the console.',
    gpuUnavailable: 'WebGPU is not available in this browser/device.',
    gpuFallback: 'WebGPU failed – CPU backend active.',
    resetAll: 'Reset settings & history', resetConfirm: 'Really delete all settings and transcript history?',
    cachePersistLabel: 'Model cache', cachePersistYes: 'persistently stored',
    cachePersistNo: 'best effort only – may be evicted under storage pressure',
    cachePersistUnknown: 'not checked', cachePersistAsk: 'Protect storage',
    aboutDesc: 'portabletranscribe is a local dictation app: speech is transcribed entirely in your browser; audio never leaves your device.',
    aboutModel: 'Model: NVIDIA Parakeet TDT 0.6B v3 (int4, 25 languages incl. German).',
    aboutFork: 'This app is based on / a fork of “parakeet_web” (thiswillbeyourgithub).',
    aboutPrivacy: '100 % local — no account, no tracking, no cloud.',
    installTitle: 'Install as app (PWA)',
    installDesktop: 'Chrome/Edge on desktop: the install icon in the address bar, or menu ⋮ → “Install page as app”.',
    installMobile: 'Android: menu ⋮ → “Install app” / “Add to Home screen”.',
    installHttps: 'Requires HTTPS with a valid certificate — in a LAN, trust the certificate if needed.',
    licenses: 'Licenses & sources', close: 'Close', theme: 'Theme', privacy: 'Privacy', themeLight: 'Light', themeDark: 'Dark', switchLang: 'Switch language',
    errNoModel: 'Load the model first.', statusRecording: 'Recording…',
  },
};

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
  const [dictationEnabled, setDictationEnabled] = useState(true);
  const [persistTranscripts, setPersistTranscripts] = useState(true);
  const [autoCopy, setAutoCopy] = useState(false);
  const [enableChunking, setEnableChunking] = useState(true);
  const [chunkDuration, setChunkDuration] = useState(60);
  const [cpuThreads, setCpuThreads] = useState(MAX_THREADS);
  const [cpuThreadsMigrated, setCpuThreadsMigrated] = useState(false); // einmalige Default-Migration
  // canary-web (Experiment): Modellfamilie + Canary-Optionen.
  const [modelFamily, setModelFamily] = useState('parakeet'); // 'parakeet' | 'canary'
  const [canaryLanguage, setCanaryLanguage] = useState('de');
  const [canaryPnc, setCanaryPnc] = useState(true);
  const [theme, setTheme] = useState(currentTheme());
  const [showLicenses, setShowLicenses] = useState(false);
  const [cachePersist, setCachePersist] = useState(null); // null=unbekannt, true=dauerhaft
  const [useWebGPU, setUseWebGPU] = useState(false); // voruebergehend fest AUS (UI ausgeblendet, s. Settings)
  const [encoderQuant, setEncoderQuant] = useState('int4'); // voruebergehend fest int4 (UI ausgeblendet)
  const [gpuFallback, setGpuFallback] = useState(false); // WebGPU fehlgeschlagen -> CPU aktiv
  const [webgpuAdapter, setWebgpuAdapter] = useState(undefined); // undefined=unbekannt, true/false
  const [loadedEnv, setLoadedEnv] = useState(null); // {backend, encoderQuant, cpuThreads} des geladenen Modells
  const [perfLast, setPerfLast] = useState(null); // letzte Transkriptions-Messwerte
  const [perfAgg, setPerfAgg] = useState({ n: 0, audio: 0, total: 0, encode: 0, decode: 0, preprocess: 0, tokenize: 0 });
  const webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;

  // Engine / transcribe state
  const modelRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle|loading|ready|recording|transcribing|error
  const [error, setError] = useState(null);
  const [canRecord, setCanRecord] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [chunkProg, setChunkProg] = useState(null); // null | {n,total}
  const [confirmReset, setConfirmReset] = useState(false);
  const [delTarget, setDelTarget] = useState(null);
  const [toast, setToast] = useState('');
  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 1800); };

  const [transcriptions, setTranscriptions] = useState([]);

  // Export/Import + Export-Format-Wahl
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [importPreview, setImportPreview] = useState(null); // validierte Einträge oder null
  const [historyQuery, setHistoryQuery] = useState('');
  const importInputRef = useRef(null);
  function exportAllAs(fmt) {
    const entries = [...transcriptions].sort((a, b) => a.id - b.id);
    if (fmt === 'json') downloadBlob(buildExportJson(entries), exportFilename('portabletranscribe-historie', 'json'), 'application/json');
    else downloadBlob(buildExportTxt(entries), exportFilename('portabletranscribe-historie', 'txt'), 'text/plain;charset=utf-8');
    setShowExportMenu(false);
  }
  async function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // gleiche Datei erneut wählbar machen
    if (!file) return;
    try {
      const parsed = parseImportJson(await file.text());
      if (!parsed.ok || parsed.entries.length === 0) { flash(tr('importInvalid')); return; }
      setImportPreview(parsed.entries);
    } catch (err) { console.warn('[import]', err); flash(tr('importInvalid')); }
  }
  function confirmImport() {
    const n = importPreview.length;
    setTranscriptions(prev => mergeEntries(prev, importPreview));
    setImportPreview(null);
    flash(tr('importedCount').replace('{n}', String(n)));
  }
  function exportEntry(t) {
    downloadBlob(t.text || '', exportFilename('portabletranscribe', 'txt', t.id), 'text/plain;charset=utf-8');
  }

  // Diktat-Regeln
  const [dictationRules, setDictationRules] = useState([]);
  // Eigene Ersetzungen (Nutzer-Regeln)
  const [userRules, setUserRules] = useState([]);
  const [newRule, setNewRule] = useState({ find: '', replacement: '', isRegex: false, caseSensitive: false });
  const [ruleError, setRuleError] = useState('');
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
    if (!dictationEnabled || !text) return text;
    let out = text;
    if (dictationRules.length) {
      for (const rule of dictationRules) {
        try { out = out.replace(new RegExp(rule.regex, rule.flags), rule.replacement); } catch {}
      }
    }
    return applyUserRules(out, userRules);
  }
  function addUserRule() {
    const res = validateRule(newRule);
    if (!res.ok) { setRuleError(tr(res.error === 'regex' ? 'ruleInvalidRegex' : 'ruleEmpty')); return; }
    setUserRules(prev => [{ id: Date.now(), ...res.value }, ...prev]);
    setNewRule({ find: '', replacement: '', isRegex: false, caseSensitive: false });
    setRuleError('');
  }
  function toggleUserRule(id) { setUserRules(prev => prev.map(r => (r.id === id ? { ...r, enabled: !r.enabled } : r))); }
  function deleteUserRule(id) { setUserRules(prev => prev.filter(r => r.id !== id)); }

  useEffect(() => { loadDictationRegex(); }, []);

  async function requestCachePersist() {
    try {
      if (navigator.storage?.persist) {
        const granted = await navigator.storage.persist();
        setCachePersist(!!granted);
        return !!granted;
      }
    } catch (e) { console.warn('[storage] persist failed:', e); }
    setCachePersist(false);
    return false;
  }

  useEffect(() => {
    (async () => {
      try {
        if (navigator.storage?.persisted) setCachePersist(!!(await navigator.storage.persisted()));
        else setCachePersist(null);
      } catch { setCachePersist(null); }
    })();
  }, []);

  // WebGPU-Verfügbarkeit real prüfen (navigator.gpu kann existieren, aber ohne
  // Adapter nutzlos sein — ORT entfernt die EP sonst still).
  useEffect(() => {
    if (!webgpuAvailable) { setWebgpuAdapter(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!cancelled) setWebgpuAdapter(!!adapter);
      } catch { if (!cancelled) setWebgpuAdapter(false); }
    })();
    return () => { cancelled = true; };
  }, [webgpuAvailable]);

  // Settings + History laden
  useEffect(() => {
    (async () => {
      const [dic, per, ac, ch, cd, ct, hist, ur, ctMig, mfam, clang, cpnc] = await Promise.all([
        loadSetting('dictationEnabled.v2', true),
        loadSetting('persistTranscripts', true), loadSetting('autoCopy', false),
        loadSetting('enableChunking', true), loadSetting('chunkDuration', 60),
        loadSetting('cpuThreads', MAX_THREADS),
        loadPersistedTranscripts(),
        loadSetting('userDictationRules', []),
        loadSetting('cpuThreadsMigrated', false),
        loadSetting('modelFamily', 'parakeet'),
        loadSetting('canaryLanguage', 'de'),
        loadSetting('canaryPnc', true),
      ]);
      setDictationEnabled(!!dic); setPersistTranscripts(!!per);
      setAutoCopy(!!ac); setEnableChunking(!!ch); setChunkDuration(Number(cd) || 60);
      const restoredThreads = restoreCpuThreads({ stored: Number(ct), migrated: !!ctMig, maxCores: MAX_CORES });
      setCpuThreads(Math.min(restoredThreads.threads, MAX_THREADS));
      setCpuThreadsMigrated(restoredThreads.migrationApplied || !!ctMig);
      setModelFamily(mfam === 'canary' ? 'canary' : 'parakeet');
      setCanaryLanguage(['de','en','es','fr'].includes(clang) ? clang : 'de');
      setCanaryPnc(cpnc !== false);
      setTranscriptions(Array.isArray(hist) ? hist : []);
      setUserRules(Array.isArray(ur) ? ur : []);
      // WebGPU + Encoder-Quant sind voruebergehend ausgeblendet: fest auf die
      // sicheren Werte. usePersistedSetting() unten schreibt sie zurueck, so
      // dass ein frueher gespeichertes useWebGPU:true / encoderQuant:'int8'
      // beim naechsten Boot ueberschrieben wird (Selbstheilung).
      setUseWebGPU(false);
      setEncoderQuant('int4');
      setSettingsLoaded(true);
      applyThemeToDom(currentTheme());
    })();
  }, []);
  usePersistedSetting('dictationEnabled.v2', dictationEnabled, settingsLoaded);
  usePersistedSetting('persistTranscripts', persistTranscripts, settingsLoaded);
  usePersistedSetting('autoCopy', autoCopy, settingsLoaded);
  usePersistedSetting('enableChunking', enableChunking, settingsLoaded);
  usePersistedSetting('chunkDuration', chunkDuration, settingsLoaded);
  usePersistedSetting('cpuThreads', cpuThreads, settingsLoaded);
  usePersistedSetting('cpuThreadsMigrated', cpuThreadsMigrated, settingsLoaded);
  usePersistedSetting('modelFamily', modelFamily, settingsLoaded);
  usePersistedSetting('canaryLanguage', canaryLanguage, settingsLoaded);
  usePersistedSetting('canaryPnc', canaryPnc, settingsLoaded);
  usePersistedSetting('useWebGPU', useWebGPU, settingsLoaded);
  usePersistedSetting('encoderQuant', encoderQuant, settingsLoaded);
  usePersistedSetting('userDictationRules', userRules, settingsLoaded);
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
      modules: { toolbar: [['bold', 'italic', 'underline', 'clean'], [{ list: 'ordered' }, { list: 'bullet' }]] },
    });
    quillRef.current = q;

    // Autosave: Entwurf (Quill-Delta) debounced in IndexedDB persistieren
    let timer = null;
    const saveDraft = () => saveSetting('editorDraft', q.getContents());
    const scheduleSave = () => { clearTimeout(timer); timer = setTimeout(saveDraft, 800); };
    q.on('text-change', scheduleSave);
    const flushDraft = () => { clearTimeout(timer); saveDraft(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushDraft(); };
    window.addEventListener('beforeunload', flushDraft);
    document.addEventListener('visibilitychange', onVisibility);

    // Wiederherstellung beim Start (nur wenn tatsächlich Inhalt vorhanden)
    loadSetting('editorDraft', null).then(delta => {
      if (delta && Array.isArray(delta.ops) && delta.ops.length && quillRef.current === q && !q.getText().trim()) {
        try { q.setContents(delta, 'silent'); flash(tr('draftRestored')); } catch (e) { console.warn('[draft] restore failed:', e); }
      }
    });

    return () => {
      try { q.off('text-change', scheduleSave); } catch {}
      clearTimeout(timer);
      window.removeEventListener('beforeunload', flushDraft);
      document.removeEventListener('visibilitychange', onVisibility);
    };
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

  async function saveEditorToHistory() {
    const q = quillRef.current;
    if (!q) return;
    const text = q.getText().replace(/\n$/, '');
    if (!text.trim()) { flash(tr('histEmpty')); return; }
    const entry = { id: Date.now(), text, timestamp: new Date().toLocaleString(lang === 'de' ? 'de-DE' : 'en-US'), wordCount: (text.match(/\S+/g) || []).length };
    setTranscriptions(prev => [entry, ...prev]);
    flash(tr('savedToHistory'));
  }

  /* ─── Modell laden ─── */
  const repoId = CONFIG.VITE_MODEL_REPO || 'efederici/parakeet-tdt-0.6b-v3-onnx-int4';
  // Canary-180M (AED) laden: LAN-Mirror (/models-canary/) oder HuggingFace.
  // Kein WebGPU/int4-Pfad — Canary laeuft WASM/int8.
  async function loadCanaryModel() {
    setStatus('loading'); setError(null);
    try {
      const repo = CONFIG.VITE_CANARY_REPO || 'istupakov/canary-180m-flash-onnx';
      const source = CONFIG.VITE_MODEL_SOURCE || 'local';
      const base = CONFIG.VITE_CANARY_LOCAL_BASE || '/models-canary/';
      const url = (f) => (source === 'local'
        ? base.replace(/\/?$/, '/') + f
        : `https://huggingface.co/${repo}/resolve/main/${f}`);
      modelRef.current = await CanaryModel.fromUrls({
        encoderUrl: url('encoder-model.int8.onnx'),
        decoderUrl: url('decoder-model.int8.onnx'),
        vocabUrl: url('vocab.txt'),
        cpuThreads: Number(cpuThreads),
      });
      setStatus('ready'); setCanRecord(true);
      setLoadedEnv({ backend: 'wasm', encoderQuant: 'int8', cpuThreads: Number(cpuThreads), modelFamily: 'canary' });
      requestCachePersist();
    } catch (e) {
      console.error('[loadCanaryModel]', e); setError(transcribeErrorMessage(e)); setStatus('error');
    }
  }

  async function loadModel(backendOverride) {
    if (modelFamily === 'canary') return loadCanaryModel();
    const wantGpu = useWebGPU && webgpuAvailable && webgpuAdapter !== false;
    const backend = (typeof backendOverride === 'string' && backendOverride) || (wantGpu ? 'webgpu-hybrid' : 'wasm');
    // WebGPU kann nur den int4-Encoder (MatMulNBits); int8 wuerde auf fp32
    // aufgestuft und scheitert an fehlenden Shards -> fuer GPU immer int4.
    const effEncoderQuant = wantGpu ? 'int4' : encoderQuant;
    setStatus('loading'); setError(null);
    try {
      const progress = () => {};
      // Modellquelle: 'local' (eigener /models-Mirror, LAN) oder 'remote'
      // (HuggingFace, z. B. GitHub Pages). Bei remote KEIN localFallbackBaseUrl,
      // sonst probt die Engine zuerst /models und faellt dann auf int8 zurueck.
      const modelSource = CONFIG.VITE_MODEL_SOURCE || 'local';
      const modelUrls = await getParakeetModel(repoId, {
        encoderQuant: effEncoderQuant, decoderQuant: 'int8', preprocessor: 'js',
        backend, cpuThreads: Number(cpuThreads), progress,
        ...(modelSource === 'local'
          ? { localFallbackBaseUrl: '/models' }
          // Remote (HuggingFace): nur der Service Worker cacht das Modell
          // (Cache Storage). Keine zusaetzliche IndexedDB-Kopie -> halbiert
          // den Speicherbedarf; offline liefert der SW aus dem Cache.
          : { skipIdbCache: true }),
        // Optionaler separater Encoder (nur wenn int8 gewaehlt und konfiguriert).
        ...(effEncoderQuant === 'int8' && CONFIG.VITE_MODEL_ENCODER_REPO ? {
          encoderRepoId: CONFIG.VITE_MODEL_ENCODER_REPO,
          ...(CONFIG.VITE_MODEL_ENCODER_REVISION ? { encoderRevision: CONFIG.VITE_MODEL_ENCODER_REVISION } : {}),
          ...(CONFIG.VITE_MODEL_ENCODER_SUBFOLDER ? { encoderSubfolder: CONFIG.VITE_MODEL_ENCODER_SUBFOLDER } : {}),
          ...(CONFIG.VITE_MODEL_ENCODER_FILE ? { encoderFilename: CONFIG.VITE_MODEL_ENCODER_FILE } : {}),
        } : {}),
        // Optionaler separater Decoder (mit in-graph lse/topk) – vermeidet den
        // teuren JS-Log-Partition-Pfad eines Stock-Decoders.
        ...(CONFIG.VITE_MODEL_DECODER_REPO ? {
          decoderRepoId: CONFIG.VITE_MODEL_DECODER_REPO,
          ...(CONFIG.VITE_MODEL_DECODER_REVISION ? { decoderRevision: CONFIG.VITE_MODEL_DECODER_REVISION } : {}),
          ...(CONFIG.VITE_MODEL_DECODER_SUBFOLDER ? { decoderSubfolder: CONFIG.VITE_MODEL_DECODER_SUBFOLDER } : {}),
          ...(CONFIG.VITE_MODEL_DECODER_FILE ? { decoderFilename: CONFIG.VITE_MODEL_DECODER_FILE } : {}),
        } : {}),
        ...(CONFIG.VITE_MODEL_REVISION ? { revision: CONFIG.VITE_MODEL_REVISION } : {}),
      });
      const nMels = modelUrls.modelConfig?.featuresSize || 128;
      modelRef.current = await ParakeetModel.fromUrls({
        ...modelUrls.urls, filenames: modelUrls.filenames, backend,
        cpuThreads: Number(cpuThreads), preprocessorBackend: modelUrls.preprocessorBackend, nMels,
        collectTimings: true,
      });
      setStatus('ready'); setCanRecord(true);
      setLoadedEnv({ backend, encoderQuant: effEncoderQuant, cpuThreads: Number(cpuThreads), modelFamily: 'parakeet' });
      if (backend !== 'wasm') flash(tr('gpuActive'));
      requestCachePersist();
    } catch (e) {
      // Variante 1: WebGPU-Fehler -> einmaliger Auto-Retry auf WASM, Toggle
      // bleibt an, Status weist auf den Fallback hin.
      if (backend !== 'wasm') {
        console.warn('[loadModel] WebGPU failed, falling back to WASM:', e);
        setGpuFallback(true);
        return loadModel('wasm');
      }
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
      let text = '';
      let metrics = null;
      setChunkProg({ n: 0, total: 1 });
      if (modelFamily === 'canary') {
        // Canary (AED): ein Encoder-Lauf + autoregressiver Decoder; keine
        // Chunk-Parallelitaet/Timestamps.
        const res = await modelRef.current.transcribe(audio16, {
          language: canaryLanguage, pnc: canaryPnc,
        });
        text = res.text || '';
        metrics = res.metrics || null;
      } else {
        const res = await modelRef.current.transcribeChunked(audio16, 16000, {
          enableChunking, chunkDurationSec: Number(chunkDuration), overlapSec: 2,
          returnTimestamps: true, temperature: 0, beamWidth: 1, frameStride: 8, enableProfiling: BENCH_ENABLED,
        }, ({ chunkNum, totalChunks }) => setChunkProg({ n: chunkNum, total: totalChunks || 1 }));
        text = res.utterance_text || '';
        metrics = res.metrics || null;
      }
      setChunkProg(null);
      // Messwerte fuer den Statistik-Reiter (Timings werden immer gesammelt;
      // enableProfiling bleibt aus -> kein ORT-Session-Profiling-Overhead).
      if (metrics) {
        setPerfLast({ audioSec: +dur.toFixed(2), ...metrics });
        setPerfAgg(a => ({
          n: a.n + 1,
          audio: a.audio + dur,
          total: a.total + metrics.total_ms,
          encode: a.encode + metrics.encode_ms,
          decode: a.decode + metrics.decode_ms,
          preprocess: a.preprocess + metrics.preprocess_ms,
          tokenize: a.tokenize + (metrics.tokenize_ms || 0),
        }));
      }
      const entry = { id: Date.now(), text, timestamp: new Date().toLocaleString(lang === 'de' ? 'de-DE' : 'en-US'), wordCount: (text.match(/\S+/g) || []).length, durationSec: Math.round(dur * 10) / 10 };
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

  const historyNeedle = normalizeForSearch(historyQuery.trim());
  const visibleTranscriptions = historyNeedle
    ? transcriptions.filter(t => normalizeForSearch(t.text).includes(historyNeedle))
    : transcriptions;

  const crossOriginIsolated = typeof window !== 'undefined' && !!window.crossOriginIsolated;
  // Wurde das Modell mit anderen Einstellungen geladen als jetzt gewaehlt?
  const currentBackend = (useWebGPU && webgpuAvailable && webgpuAdapter !== false) ? 'webgpu-hybrid' : 'wasm';
  const currentQuant = useWebGPU ? 'int4' : encoderQuant;
  const needsReload = !!modelRef.current && !!loadedEnv && (
    loadedEnv.backend !== currentBackend ||
    loadedEnv.encoderQuant !== currentQuant ||
    loadedEnv.cpuThreads !== Number(cpuThreads) ||
    (loadedEnv.modelFamily || 'parakeet') !== modelFamily
  );
  const stats = (() => {
    const count = transcriptions.length;
    const words = transcriptions.reduce((a, t) => a + (Number(t.wordCount) || 0), 0);
    const withDur = transcriptions.filter(t => Number(t.durationSec) > 0);
    const totalDur = withDur.reduce((a, t) => a + Number(t.durationSec), 0);
    const ids = transcriptions.map(t => t.id).filter(Number.isFinite);
    return {
      count, words,
      avg: count ? Math.round(words / count) : 0,
      totalDur,
      withDurCount: withDur.length,
      first: ids.length ? Math.min(...ids) : null,
      last: ids.length ? Math.max(...ids) : null,
    };
  })();

  return (
    <div className="pt-app">
      <nav className="pt-nav" aria-label="Navigation">
        <div className="pt-brand">{tr('app')}</div>
        <a href="#input" className={`pt-navlink ${view === 'input' ? 'active' : ''}`} aria-current={view === 'input'} onClick={() => go('input')}>🎤 {tr('navInput')}</a>
        <a href="#history" className={`pt-navlink ${view === 'history' ? 'active' : ''}`} aria-current={view === 'history'} onClick={() => go('history')}>🗂 {tr('navHistory')}</a>
        <a href="#stats" className={`pt-navlink ${view === 'stats' ? 'active' : ''}`} aria-current={view === 'stats'} onClick={() => go('stats')}>📊 {tr('navStats')}</a>
        <a href="#settings" className={`pt-navlink ${view === 'settings' ? 'active' : ''}`} aria-current={view === 'settings'} onClick={() => go('settings')}>⚙️ {tr('navSettings')}</a>
        <a href="#about" className={`pt-navlink ${view === 'about' ? 'active' : ''}`} aria-current={view === 'about'} onClick={() => go('about')}>ℹ️ {tr('navAbout')}</a>
        <div className="pt-navfoot">
          <button className="pt-theme" onClick={() => setThemeAndStore(theme === 'dark' ? 'light' : 'dark')} aria-label={tr('theme')} title={tr('theme')}>
            {theme === 'dark' ? '🌙' : '☀️'}
          </button>
          <button className="pt-theme" onClick={() => setLang(lang === 'de' ? 'en' : 'de')} aria-label={tr('switchLang')} title={tr('switchLang')}>
            🌐 {lang.toUpperCase()}
          </button>
        </div>
      </nav>

      <main className="pt-main">
        <header className="pt-status" aria-live="polite">
          <span className={`dot ${status}`} aria-hidden="true"></span>
          <span>{status === 'ready' || status === 'recording' ? tr('modelReady') : status === 'error' ? (error || tr('loadModel')) : status === 'loading' ? tr('loadingModel') : status === 'transcribing' ? tr('transcribing') + (chunkProg && chunkProg.total > 1 ? ` (${chunkProg.n}/${chunkProg.total})` : '') : ''} </span>
          {status !== 'ready' && status !== 'recording' && status !== 'transcribing' && status !== 'error' && (
            <button className="pt-btn primary" style={{ marginLeft: 'auto' }} onClick={() => loadModel()} disabled={status === 'loading'}>
              {status === 'loading' ? tr('loadingModel') : tr('loadModel')}
            </button>
          )}
          {status === 'error' && <button className="pt-btn" style={{ marginLeft: 'auto' }} onClick={() => loadModel()}>{tr('loadModel')}</button>}
        </header>

        <section className={`pt-input${view !== 'input' ? ' pt-hidden' : ''}`}>
            <div className="pt-editor-wrap">
              <div className="pt-editor-tools">
                <button className="pt-btn" onMouseDown={preventBlur} onClick={async (e) => { e.stopPropagation(); await copyEditor(true); }}>📋 {tr('copy')}</button>
                <button className="pt-btn ghost" onMouseDown={preventBlur} onClick={async (e) => { e.stopPropagation(); await copyEditor(false); }}>{tr('copyPlain')}</button>
                <button className="pt-btn ghost" onMouseDown={preventBlur} onClick={(e) => { e.stopPropagation(); clearEditor(); }}>{tr('clear')}</button>
                <button className="pt-btn" onMouseDown={preventBlur} onClick={async (e) => { e.stopPropagation(); await saveEditorToHistory(); }}>💾 {tr('saveToHistory')}</button>
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
            </div>
          </section>

        <section className={`pt-history${view !== 'history' ? ' pt-hidden' : ''}`}>
            <div className="pt-histhead">
              <h2>{tr('histTitle')}</h2>
              <div className="pt-histtools">
                {transcriptions.length > 0 && (
                  <input type="search" className="pt-search" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setHistoryQuery(''); }} placeholder={tr('histSearch')} aria-label={tr('histSearch')} />
                )}
                {transcriptions.length > 0 && (
                  <button className="pt-btn ghost" onClick={() => setShowExportMenu(true)}>⬇ {tr('exportAll')}</button>
                )}
                <button className="pt-btn ghost" onClick={() => importInputRef.current?.click()}>⬆ {tr('importJson')}</button>
                <input type="file" accept=".json,application/json" hidden ref={importInputRef} onChange={onImportFile} aria-hidden="true" tabIndex={-1} />
              </div>
            </div>
            {settingsLoaded && !persistTranscripts && (
              <div className="pt-warn" role="status">
                <span>⚠️ {tr('persistOffWarn')}</span>
                <button className="pt-btn" onClick={() => setPersistTranscripts(true)}>{tr('persistEnable')}</button>
              </div>
            )}
            {transcriptions.length > 0 && historyQuery.trim() && (
              <p className="pt-histcount">
                <span>{tr('histCount').replace('{n}', String(visibleTranscriptions.length)).replace('{total}', String(transcriptions.length))}</span>
                <button className="pt-btn ghost" onClick={() => setHistoryQuery('')} aria-label={tr('histClear')}>✕ {tr('histClear')}</button>
              </p>
            )}
            {transcriptions.length === 0 ? <p className="pt-empty">{tr('histEmpty')}</p> : visibleTranscriptions.length === 0 ? <p className="pt-empty">{tr('histNoMatch')}</p> : (
              <ul className="pt-histlist">
                {visibleTranscriptions.map(t => (
                  <li key={t.id}>
                    <div className="pt-histbody">
                      <div className="pt-histtext">{t.text || ''}</div>
                      <div className="pt-histmeta">{t.timestamp}{Number.isFinite(t.wordCount) ? ` · ${t.wordCount} ${tr('words')}` : ''}</div>
                    </div>
                    <div className="pt-histacts">
                      <button className="pt-btn" onClick={() => { go('input'); setTimeout(() => insertAtCaret(applyDictation(t.text || '')), 60); }}>{tr('insertToEditor')}</button>
                      <button className="pt-btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(sanitizeClipboardText(t.text || '')); flash(tr('copied')); } catch {} }} title={tr('copyPlain')} aria-label={tr('copyPlain')}>📋</button>
                      <button className="pt-btn ghost" onClick={() => exportEntry(t)} aria-label={tr('exportEntry')} title={tr('exportEntry')}>⬇</button>
                      <button className="pt-btn danger" onClick={() => setDelTarget(t.id)}>{tr('delete')}</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

        <section className={`pt-stats${view !== 'stats' ? ' pt-hidden' : ''}`}>
            <h2>{tr('navStats')}</h2>
            {stats.count === 0 ? <p className="pt-empty">{tr('statsEmpty')}</p> : (
              <div className="pt-statgrid">
                <div className="pt-statcard"><span className="pt-statnum">{stats.count}</span><span className="pt-statlabel">{tr('statEntries')}</span></div>
                <div className="pt-statcard"><span className="pt-statnum">{stats.words.toLocaleString(lang === 'de' ? 'de-DE' : 'en-US')}</span><span className="pt-statlabel">{tr('statWords')}</span></div>
                <div className="pt-statcard"><span className="pt-statnum">{stats.avg}</span><span className="pt-statlabel">{tr('statAvg')}</span></div>
                <div className="pt-statcard">
                  <span className="pt-statnum">{formatDuration(stats.totalDur)}</span>
                  <span className="pt-statlabel">{tr('statDuration')}</span>
                  {stats.withDurCount < stats.count && <span className="pt-statnote">{tr('statDurationHint')}</span>}
                </div>
                <div className="pt-statcard"><span className="pt-statnum">{formatDay(stats.first, lang)}</span><span className="pt-statlabel">{tr('statFirst')}</span></div>
                <div className="pt-statcard"><span className="pt-statnum">{formatDay(stats.last, lang)}</span><span className="pt-statlabel">{tr('statLast')}</span></div>
              </div>
            )}
            <h3 className="pt-perfhead">{tr('perfTitle')}</h3>
            {perfLast ? (
              <div className="pt-statgrid">
                <div className="pt-statcard"><span className="pt-statnum">{perfLast.audioSec.toFixed(2)} s</span><span className="pt-statlabel">{tr('perfAudio')}</span></div>
                <div className="pt-statcard"><span className="pt-statnum">{(perfLast.total_ms / 1000).toFixed(2)} s</span><span className="pt-statlabel">{tr('perfTotal')}</span></div>
                <div className="pt-statcard"><span className="pt-statnum">{perfLast.procPerDur != null ? perfLast.procPerDur.toFixed(2) : '—'}</span><span className="pt-statlabel">{tr('perfRtf')}</span></div>
                <div className="pt-statcard"><span className="pt-statnum">{perfLast.preprocess_ms} ms</span><span className="pt-statlabel">{tr('perfPre')}</span></div>
                <div className="pt-statcard"><span className="pt-statnum">{perfLast.encode_ms} ms</span><span className="pt-statlabel">{tr('perfEnc')}</span></div>
                <div className="pt-statcard"><span className="pt-statnum">{perfLast.decode_ms} ms</span><span className="pt-statlabel">{tr('perfDec')}</span></div>
                <div className="pt-statcard"><span className="pt-statnum">{perfLast.tokenize_ms} ms</span><span className="pt-statlabel">{tr('perfTok')}</span></div>
              </div>
            ) : <p className="pt-muted">{tr('perfEmpty')}</p>}
            {perfAgg.n > 0 && (
              <p className="pt-muted">
                {tr('perfAvgTitle')} ({perfAgg.n} {tr('perfRuns')}): {(perfAgg.total / 1000).toFixed(2)} s · RTF {perfAgg.audio ? (perfAgg.total / 1000 / perfAgg.audio).toFixed(2) : '—'} · {tr('perfEnc')} {(perfAgg.encode / perfAgg.n).toFixed(0)} ms · {tr('perfDec')} {(perfAgg.decode / perfAgg.n).toFixed(0)} ms
              </p>
            )}
            <p className="pt-muted">
              {tr('perfBackend')}: {(perfLast && perfLast.backend) || (useWebGPU ? 'WebGPU-Hybrid' : 'WASM')} · {tr('perfThreads')}: {(perfLast && perfLast.numThreads != null) ? perfLast.numThreads : (crossOriginIsolated ? Number(cpuThreads) : 1)} · {tr('perfCoi')}: {((perfLast && perfLast.crossOriginIsolated != null) ? perfLast.crossOriginIsolated : crossOriginIsolated) ? tr('perfYes') : tr('perfNo')}
            </p>
            <p style={{ marginTop: 10 }}>
              <button className="pt-btn ghost" onClick={async () => {
                // Immer kopierbar: Umgebungswerte auch ohne Messung; Messwerte
                // (letzte + Sitzungsdurchschnitt) sobald vorhanden.
                const report = {
                  measured: !!perfLast,
                  last: perfLast || null,
                  sessionAvg: perfAgg.n ? {
                    runs: perfAgg.n,
                    audioSec: +perfAgg.audio.toFixed(2),
                    totalMs: +perfAgg.total.toFixed(1),
                    encodeMsAvg: +(perfAgg.encode / perfAgg.n).toFixed(1),
                    decodeMsAvg: +(perfAgg.decode / perfAgg.n).toFixed(1),
                    rtf: perfAgg.audio ? +((perfAgg.total / 1000) / perfAgg.audio).toFixed(2) : null,
                  } : null,
                  env: {
                    crossOriginIsolated: (typeof window !== 'undefined' && typeof window.crossOriginIsolated === 'boolean') ? window.crossOriginIsolated : null,
                    ortWasmThreads: (typeof globalThis !== 'undefined' && globalThis.ort && globalThis.ort.env && globalThis.ort.env.wasm) ? (globalThis.ort.env.wasm.numThreads ?? null) : null,
                    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
                    backendSetting: useWebGPU ? 'webgpu-hybrid' : 'wasm',
                    webgpuAdapterAvailable: webgpuAdapter ?? null,
                    cpuThreadsSetting: Number(cpuThreads),
                    encoderQuantSetting: encoderQuant,
                    modelFamily: modelFamily,
                    canaryLanguage: modelFamily === 'canary' ? canaryLanguage : null,
                    canaryPnc: modelFamily === 'canary' ? canaryPnc : null,
                    modelSource: CONFIG.VITE_MODEL_SOURCE || null,
                    modelRepo: CONFIG.VITE_MODEL_REPO || null,
                    decoderRepo: CONFIG.VITE_MODEL_DECODER_REPO || null,
                    userAgent: navigator.userAgent,
                  },
                };
                try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); flash(tr('copied')); } catch (e) { console.warn(e); }
              }}>{tr('perfCopy')}</button>
              {BENCH_ENABLED && (
                <button className="pt-btn ghost" style={{ marginLeft: 8 }} onClick={async () => {
                  try {
                    const prof = (typeof window !== 'undefined' && window.__ptProfile) || modelRef.current?.endProfiling?.() || null;
                    await navigator.clipboard.writeText(JSON.stringify(prof, null, 2));
                    flash(tr('copied'));
                  } catch (e) { console.warn(e); }
                }}>{tr('perfCopyProfile')}</button>
              )}
            </p>
          </section>

        <section className={`pt-settings${view !== 'settings' ? ' pt-hidden' : ''}`}>
            <h2>{tr('navSettings')}</h2>
            <p className="pt-muted" style={{ marginBottom: 10 }}>{tr('langAuto')}</p>
            <label className="pt-row"><span>{tr('dictationOn')}</span><input type="checkbox" checked={dictationEnabled} onChange={e => setDictationEnabled(e.target.checked)} /></label>
            <label className="pt-row"><span>{tr('persistLabel')}</span><input type="checkbox" checked={persistTranscripts} onChange={e => setPersistTranscripts(e.target.checked)} /></label>
            <label className="pt-row"><span>{tr('autoCopyLabel')}</span><input type="checkbox" checked={autoCopy} onChange={e => setAutoCopy(e.target.checked)} /></label>
            <fieldset className="pt-fieldset"><legend>{tr('advanced')}</legend>
              <label className="pt-row"><span>{tr('modelLabel')}</span><select value={modelFamily} onChange={e => setModelFamily(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}><option value="parakeet">{tr('modelParakeet')}</option><option value="canary">{tr('modelCanary')}</option></select></label>
              {modelFamily === 'canary' && (
                <>
                  <label className="pt-row"><span>{tr('canaryLangLabel')}</span><select value={canaryLanguage} onChange={e => setCanaryLanguage(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}><option value="de">Deutsch</option><option value="en">English</option><option value="es">Español</option><option value="fr">Français</option></select></label>
                  <label className="pt-row"><span>{tr('canaryPncLabel')}</span><input type="checkbox" checked={canaryPnc} onChange={e => setCanaryPnc(e.target.checked)} /></label>
                  <p className="pt-muted" style={{ margin: '2px 0 8px' }}>{tr('canaryHint')}</p>
                </>
              )}
              <label className="pt-row"><span>{tr('chunkLabel')}</span><input type="checkbox" checked={enableChunking} onChange={e => setEnableChunking(e.target.checked)} /></label>
              <label className="pt-row"><span>{tr('chunkDurLabel')}</span><input type="number" min="5" max="600" value={chunkDuration} onChange={e => setChunkDuration(e.target.value)} /></label>
              <label className="pt-row"><span>{tr('threadsLabel')}</span><select value={cpuThreads} onChange={e => setCpuThreads(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}>{Array.from({ length: MAX_THREADS }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}</select></label>
              {/* Encoder-Quantisierung voruebergehend ausgeblendet (2026-09-22):
                  int4 und int8 messen praktisch gleich schnell, int4 ist kleiner.
                  Wert ist auf 'int4' festgelegt (State + Persistenz unten). */}
              {needsReload && (
                <p className="pt-warn" style={{ marginTop: 10 }}>
                  <span>{tr('reloadNeeded')}</span>
                  <button className="pt-btn" onClick={() => location.reload()}>{tr('reloadNow')}</button>
                </p>
              )}
              <p className="pt-muted" style={{ margin: '2px 0 8px' }}>{tr('threadsHint')}</p>
              {/* WebGPU-Schalter voruebergehend ausgeblendet (2026-09-22): der
                  int4-Encoder liefert im JSEP-Backend von onnxruntime-web falsche
                  Texte (fp16-Akkumulation; der Fix greift nur im nativen EP).
                  Wert ist fest AUS (State + Persistenz unten). */}
            </fieldset>
            <fieldset className="pt-fieldset"><legend>{tr('customRules')}</legend>
              <p className="pt-muted" style={{ marginBottom: 10 }}>{tr('customRulesHint')}</p>
              {userRules.length === 0 ? <p className="pt-muted">{tr('noRules')}</p> : (
                <ul className="pt-rulelist">
                  {userRules.map(r => (
                    <li key={r.id} className="pt-rule">
                      <input type="checkbox" checked={r.enabled} onChange={() => toggleUserRule(r.id)} aria-label={tr('dictationOn')} />
                      <span className="pt-ruletxt"><code>{r.find}</code> → <code>{r.replacement || '␀'}</code></span>
                      {r.isRegex && <span className="pt-badge">Regex</span>}
                      {r.caseSensitive && <span className="pt-badge">Aa</span>}
                      <button className="pt-btn danger" onClick={() => deleteUserRule(r.id)} aria-label={tr('delete')}>✕</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="pt-ruleform">
                <input type="text" value={newRule.find} onChange={e => setNewRule(v => ({ ...v, find: e.target.value }))} placeholder={tr('ruleFind')} aria-label={tr('ruleFind')} />
                <span aria-hidden="true">→</span>
                <input type="text" value={newRule.replacement} onChange={e => setNewRule(v => ({ ...v, replacement: e.target.value }))} placeholder={tr('ruleReplace')} aria-label={tr('ruleReplace')} />
                <label className="pt-inline"><input type="checkbox" checked={newRule.isRegex} onChange={e => setNewRule(v => ({ ...v, isRegex: e.target.checked }))} /> {tr('ruleRegex')}</label>
                <label className="pt-inline"><input type="checkbox" checked={newRule.caseSensitive} onChange={e => setNewRule(v => ({ ...v, caseSensitive: e.target.checked }))} /> {tr('ruleCase')}</label>
                <button className="pt-btn" onClick={addUserRule}>{tr('addRule')}</button>
              </div>
              {ruleError && <p className="pt-error" role="alert">{ruleError}</p>}
            </fieldset>
            <h3>Interface</h3>
            <label className="pt-row"><span>{tr('langLabel')}</span>
              <select value={lang} onChange={e => setLang(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}><option value="de">Deutsch</option><option value="en">English</option></select></label>
            <div className="pt-row"><span>{tr('theme')}</span>
              <button className="pt-btn" onClick={() => setThemeAndStore(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '🌙 ' + tr('themeDark') : '☀️ ' + tr('themeLight')}</button></div>
            <label className="pt-row"><span>{tr('cachePersistLabel')}</span>
              <span className="pt-cache">{cachePersist === true ? '✅ ' + tr('cachePersistYes') : cachePersist === false ? '⚠️ ' + tr('cachePersistNo') : tr('cachePersistUnknown')}
                {cachePersist === false && <button className="pt-btn ghost" onClick={() => requestCachePersist()}>{tr('cachePersistAsk')}</button>}
              </span></label>
            <hr />
            <button className="pt-btn danger" onClick={() => setConfirmReset(true)}>{tr('resetAll')}</button>
          </section>

        <section className={`pt-about${view !== 'about' ? ' pt-hidden' : ''}`}>
            <h2>{tr('app')}</h2>
            <p>{tr('aboutDesc')}</p>
            <p className="pt-lock">🔒 {tr('aboutPrivacy')}</p>
            <p className="pt-muted">{tr('aboutModel')}</p>
            <p className="pt-muted">{tr('aboutFork')}</p>
            <div className="pt-install">
              <h3>{tr('installTitle')}</h3>
              <ul>
                <li>{tr('installDesktop')}</li>
                <li>{tr('installMobile')}</li>
              </ul>
              <p className="pt-muted">{tr('installHttps')}</p>
            </div>
            <div className="pt-aboutlinks">
              <button className="pt-btn ghost" onClick={() => setShowLicenses(s => !s)} aria-expanded={showLicenses}>{tr('licenses')}</button>
              <a className="pt-btn ghost" href="/datenschutz.html" target="_blank" rel="noopener">{tr('privacy')}</a>
            </div>
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
        {showExportMenu && (
          <div className="pt-modal-bg" onClick={() => setShowExportMenu(false)}>
            <div className="pt-modal" role="dialog" aria-modal="true" aria-labelledby="export-t" onClick={e => e.stopPropagation()}>
              <h3 id="export-t">{tr('exportFormatTitle')}</h3>
              <p>{tr('exportFormatHint')}</p>
              <div className="pt-export-options">
                <button className="pt-btn" onClick={() => exportAllAs('json')}>{tr('exportJson')}</button>
                <button className="pt-btn" onClick={() => exportAllAs('txt')}>{tr('exportTxt')}</button>
              </div>
              <div className="pt-modal-actions">
                <button className="pt-btn ghost" onClick={() => setShowExportMenu(false)}>{tr('no')}</button>
              </div>
            </div>
          </div>
        )}
        {importPreview && (
          <div className="pt-modal-bg" onClick={() => setImportPreview(null)}>
            <div className="pt-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
              <p>{tr('importConfirm').replace('{n}', String(importPreview.length))}</p>
              <div className="pt-modal-actions">
                <button className="pt-btn primary" onClick={confirmImport}>{tr('importYes')}</button>
                <button className="pt-btn" onClick={() => setImportPreview(null)}>{tr('no')}</button>
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
