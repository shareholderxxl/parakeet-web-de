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
import { buildExportJson, buildExportTxt, exportFilename, parseImportJson, mergeEntries, downloadBlob } from './lib/historyIo.js';
import { applyUserRules, validateRule } from './lib/dictationRules.js';
import { createSilenceDetector, VAD_THRESHOLDS } from './lib/silenceDetector.js';

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
    vadLabel: 'Auto-Stopp bei Stille', vadDurLabel: 'Stille-Dauer (s)', vadSensLabel: 'Empfindlichkeit',
    vadSensLow: 'niedrig', vadSensMedium: 'mittel', vadSensHigh: 'hoch', vadSilenceShort: 'Stille',
    importConfirm: '{n} Einträge importieren? Bestehende Einträge bleiben erhalten.',
    importYes: 'Importieren', importedCount: '{n} Einträge importiert', importInvalid: 'Import fehlgeschlagen – keine gültige Historie-Datei.',
    histTitle: 'Verlauf', histEmpty: 'Noch keine Transkripte.', insertToEditor: 'In Editor laden',
    delete: 'Löschen', delConfirm: 'Dieses Transkript dauerhaft löschen?', yes: 'Löschen', no: 'Abbrechen',
    micTitle: 'Mikrofon', langLabel: 'Transkriptionssprache', persistLabel: 'Transkripte speichern',
    autoCopyLabel: 'Automatisch kopieren', advanced: 'Erweitert', chunkLabel: 'Lange Audios segmentieren',
    chunkDurLabel: 'Segmentlänge (s)', beamLabel: 'Beam-Breite', threadsLabel: 'CPU-Threads',
    resetAll: 'Einstellungen & Verlauf zurücksetzen', resetConfirm: 'Alle Einstellungen und das Verlaufs-Gedächtnis wirklich löschen?',
    cachePersistLabel: 'Modell-Cache', cachePersistYes: 'dauerhaft gespeichert',
    cachePersistNo: 'nur best effort – kann unter Speicherdruck entfernt werden',
    cachePersistUnknown: 'nicht geprüft', cachePersistAsk: 'Dauerhaft schützen',
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
    vadLabel: 'Auto-stop on silence', vadDurLabel: 'Silence duration (s)', vadSensLabel: 'Sensitivity',
    vadSensLow: 'low', vadSensMedium: 'medium', vadSensHigh: 'high', vadSilenceShort: 'silence',
    importConfirm: 'Import {n} entries? Existing entries are kept.',
    importYes: 'Import', importedCount: 'Imported {n} entries', importInvalid: 'Import failed – not a valid history file.',
    histTitle: 'History', histEmpty: 'No transcripts yet.', insertToEditor: 'Insert into editor',
    delete: 'Delete', delConfirm: 'Permanently delete this transcript?', yes: 'Delete', no: 'Cancel',
    micTitle: 'Microphone', langLabel: 'Transcription language', persistLabel: 'Save transcripts',
    autoCopyLabel: 'Copy automatically', advanced: 'Advanced', chunkLabel: 'Chunk long audio',
    chunkDurLabel: 'Chunk length (s)', beamLabel: 'Beam width', threadsLabel: 'CPU threads',
    resetAll: 'Reset settings & history', resetConfirm: 'Really delete all settings and transcript history?',
    cachePersistLabel: 'Model cache', cachePersistYes: 'persistently stored',
    cachePersistNo: 'best effort only – may be evicted under storage pressure',
    cachePersistUnknown: 'not checked', cachePersistAsk: 'Protect storage',
    aboutDesc: 'portabletranscribe is a local dictation app: speech is transcribed entirely in your browser; audio never leaves your device.',
    aboutModel: 'Model: NVIDIA Parakeet TDT 0.6B v3 (int4, 25 languages incl. German).',
    aboutFork: 'This app is based on / a fork of “parakeet_web” (thiswillbeyourgithub).',
    aboutPrivacy: '100 % local — no account, no tracking, no cloud.',
    licenses: 'Licenses & sources', close: 'Close', theme: 'Theme',
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
  const [cachePersist, setCachePersist] = useState(null); // null=unbekannt, true=dauerhaft
  const [vadEnabled, setVadEnabled] = useState(false);
  const [vadSilenceSec, setVadSilenceSec] = useState(5);
  const [vadSensitivity, setVadSensitivity] = useState('medium');
  const [vadSilence, setVadSilence] = useState(0); // laufende Stille (nur Anzeige)

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

  // Settings + History laden
  useEffect(() => {
    (async () => {
      const [lng, dic, per, ac, ch, cd, bw, ct, hist, ur, vade, vads, vadsens] = await Promise.all([
        loadSetting('transcriptionLanguage', 'de'), loadSetting('dictationEnabled.v2', true),
        loadSetting('persistTranscripts', true), loadSetting('autoCopy', false),
        loadSetting('enableChunking', true), loadSetting('chunkDuration', 60),
        loadSetting('beamWidth', 1), loadSetting('cpuThreads', 4), loadPersistedTranscripts(),
        loadSetting('userDictationRules', []),
        loadSetting('vadEnabled', false), loadSetting('vadSilenceSec', 5), loadSetting('vadSensitivity', 'medium'),
      ]);
      setTranscriptionLanguage(lng); setDictationEnabled(!!dic); setPersistTranscripts(!!per);
      setAutoCopy(!!ac); setEnableChunking(!!ch); setChunkDuration(Number(cd) || 60);
      setBeamWidth(Number(bw) || 1); setCpuThreads(Number(ct) || 4);
      setTranscriptions(Array.isArray(hist) ? hist : []);
      setUserRules(Array.isArray(ur) ? ur : []);
      setVadEnabled(!!vade); setVadSilenceSec(Number(vads) || 5);
      setVadSensitivity(VAD_THRESHOLDS[vadsens] ? vadsens : 'medium');
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
  usePersistedSetting('userDictationRules', userRules, settingsLoaded);
  usePersistedSetting('vadEnabled', vadEnabled, settingsLoaded);
  usePersistedSetting('vadSilenceSec', vadSilenceSec, settingsLoaded);
  usePersistedSetting('vadSensitivity', vadSensitivity, settingsLoaded);
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
  async function loadModel() {
    setStatus('loading'); setError(null);
    try {
      const progress = () => {};
      const modelUrls = await getParakeetModel(repoId, {
        encoderQuant: 'int4', decoderQuant: 'int8', preprocessor: 'js',
        backend: 'wasm', cpuThreads: Number(cpuThreads), progress,
        localFallbackBaseUrl: '/models',
        ...(CONFIG.VITE_MODEL_REVISION ? { revision: CONFIG.VITE_MODEL_REVISION } : {}),
      });
      const nMels = modelUrls.modelConfig?.featuresSize || 128;
      modelRef.current = await ParakeetModel.fromUrls({
        ...modelUrls.urls, filenames: modelUrls.filenames, backend: 'wasm',
        cpuThreads: Number(cpuThreads), preprocessorBackend: modelUrls.preprocessorBackend, nMels,
      });
      setStatus('ready'); setCanRecord(true);
      requestCachePersist();
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
  const vadRef = useRef(null);
  const stopRef = useRef(null);
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
      vadRef.current = vadEnabled ? createSilenceDetector({ threshold: VAD_THRESHOLDS[vadSensitivity], silenceSec: Number(vadSilenceSec) }) : null;
      setVadSilence(0);
      const monitor = createLevelMonitor(ctx, src, (lv) => {
        setLevel(lv);
        const d = vadRef.current;
        if (d) {
          const r = d.feed(lv, performance.now());
          setVadSilence(r.silenceSec);
          if (r.shouldStop) stopRef.current?.();
        }
      });
      ctxRef.current = ctx; workletRef.current = node; rateRef.current = ctx.sampleRate;
      node._monitor = monitor;
      setIsRecording(true); setStatus('recording');
      acquireKeepalive();
    } catch (e) { console.error('[mic]', e); setError('Mikrofon verweigert/unverfügbar: ' + (e.message || e)); }
  }
  async function stopAndTranscribe() {
    if (!isRecording) return;
    setIsRecording(false); setStatus('transcribing');
    vadRef.current = null; setVadSilence(0);
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
      setChunkProg({ n: 0, total: 1 });
      const res = await modelRef.current.transcribeChunked(audio16, 16000, {
        enableChunking, chunkDurationSec: Number(chunkDuration), overlapSec: 2,
        returnTimestamps: true, temperature: 0, beamWidth: Number(beamWidth), frameStride: 8, enableProfiling: false,
      }, ({ chunkNum, totalChunks }) => setChunkProg({ n: chunkNum, total: totalChunks || 1 }));
      setChunkProg(null);
      let text = res.utterance_text || '';
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
  stopRef.current = stopAndTranscribe; // aktuelle Referenz für den VAD-Trigger

  const historyNeedle = normalizeForSearch(historyQuery.trim());
  const visibleTranscriptions = historyNeedle
    ? transcriptions.filter(t => normalizeForSearch(t.text).includes(historyNeedle))
    : transcriptions;

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
          <button className="pt-theme" onClick={() => setThemeAndStore(theme === 'dark' ? 'light' : 'dark')} aria-label={tr('theme')}>
            {theme === 'dark' ? '🌙' : '☀️'}
          </button>
        </div>
      </nav>

      <main className="pt-main">
        <header className="pt-status" aria-live="polite">
          <span className={`dot ${status}`} aria-hidden="true"></span>
          <span>{status === 'ready' || status === 'recording' ? tr('modelReady') : status === 'error' ? (error || tr('loadModel')) : status === 'loading' ? tr('loadingModel') : status === 'transcribing' ? tr('transcribing') + (chunkProg && chunkProg.total > 1 ? ` (${chunkProg.n}/${chunkProg.total})` : '') : ''} </span>
          {status !== 'ready' && status !== 'recording' && status !== 'transcribing' && status !== 'error' && (
            <button className="pt-btn primary" style={{ marginLeft: 'auto' }} onClick={loadModel} disabled={status === 'loading'}>
              {status === 'loading' ? tr('loadingModel') : tr('loadModel')}
            </button>
          )}
          {status === 'error' && <button className="pt-btn" style={{ marginLeft: 'auto' }} onClick={loadModel}>{tr('loadModel')}</button>}
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
              {isRecording && vadEnabled && <span className="pt-vadinfo" aria-live="off">⏸ {tr('vadSilenceShort')} {vadSilence.toFixed(1)}/{vadSilenceSec} s</span>}
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
                      <button className="pt-btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(sanitizeClipboardText(t.text || '')); flash(tr('copied')); } catch {} }}>📋</button>
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
          </section>

        <section className={`pt-settings${view !== 'settings' ? ' pt-hidden' : ''}`}>
            <h2>{tr('navSettings')}</h2>
            <label className="pt-row"><span>{tr('dictationOn')}</span><input type="checkbox" checked={dictationEnabled} onChange={e => setDictationEnabled(e.target.checked)} /></label>
            <label className="pt-row"><span>{tr('persistLabel')}</span><input type="checkbox" checked={persistTranscripts} onChange={e => setPersistTranscripts(e.target.checked)} /></label>
            <label className="pt-row"><span>{tr('autoCopyLabel')}</span><input type="checkbox" checked={autoCopy} onChange={e => setAutoCopy(e.target.checked)} /></label>
            <fieldset className="pt-fieldset"><legend>{tr('advanced')}</legend>
              <label className="pt-row"><span>{tr('chunkLabel')}</span><input type="checkbox" checked={enableChunking} onChange={e => setEnableChunking(e.target.checked)} /></label>
              <label className="pt-row"><span>{tr('chunkDurLabel')}</span><input type="number" min="5" max="600" value={chunkDuration} onChange={e => setChunkDuration(e.target.value)} /></label>
              <label className="pt-row"><span>{tr('beamLabel')}</span><select value={beamWidth} onChange={e => setBeamWidth(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="5">5</option></select></label>
              <label className="pt-row"><span>{tr('threadsLabel')}</span><select value={cpuThreads} onChange={e => setCpuThreads(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}><option value="2">2</option><option value="4">4</option><option value="8">8</option></select></label>
              <label className="pt-row"><span>{tr('vadLabel')}</span><input type="checkbox" checked={vadEnabled} onChange={e => setVadEnabled(e.target.checked)} /></label>
              {vadEnabled && (
                <>
                  <label className="pt-row"><span>{tr('vadDurLabel')}</span><input type="number" min="2" max="15" value={vadSilenceSec} onChange={e => setVadSilenceSec(e.target.value)} /></label>
                  <label className="pt-row"><span>{tr('vadSensLabel')}</span><select value={vadSensitivity} onChange={e => setVadSensitivity(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}><option value="low">{tr('vadSensLow')}</option><option value="medium">{tr('vadSensMedium')}</option><option value="high">{tr('vadSensHigh')}</option></select></label>
                </>
              )}
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
            <label className="pt-row"><span>{tr('langLabel')} (UI)</span>
              <select value={lang} onChange={e => setLang(e.target.value)} style={{ background: 'var(--bg-card)', color: 'var(--text)' }}><option value="de">Deutsch</option><option value="en">English</option></select></label>
            <div className="pt-row"><span>{tr('theme')}</span>
              <button className="pt-btn" onClick={() => setThemeAndStore(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '🌙 Dunkel' : '☀️ Hell'}</button></div>
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
