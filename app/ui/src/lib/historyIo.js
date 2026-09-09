// Reine Hilfsfunktionen für Export/Import der lokalen Transkript-Historie.
// Eintrags-Schema: { id, text, timestamp, wordCount } (text-only, wie persistiert).

export function timestampSlug(id) {
  const d = new Date(Number(id));
  const p = (n) => String(n).padStart(2, '0');
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

export function exportFilename(prefix, ext, id) {
  return `${prefix}-${timestampSlug(id ?? Date.now())}.${ext}`;
}

export function buildExportTxt(entries) {
  return entries
    .map(t => `=== ${t.timestamp || timestampSlug(t.id)} ===\n\n${t.text || ''}\n`)
    .join('\n\n');
}

export function buildExportJson(entries) {
  return JSON.stringify({
    app: 'portabletranscribe',
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: entries.map(t => ({ id: t.id, text: t.text, timestamp: t.timestamp, wordCount: t.wordCount })),
  }, null, 2);
}

// Validiert importierten Text; lehnt ungültige Struktur/Einträge ab.
export function parseImportJson(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); } catch { return { ok: false, reason: 'parse' }; }
  const raw = Array.isArray(data) ? data : (data && typeof data === 'object' ? data.entries : null);
  if (!Array.isArray(raw)) return { ok: false, reason: 'shape' };
  const entries = [];
  let nextId = Date.now();
  for (const e of raw) {
    if (!e || typeof e !== 'object' || typeof e.text !== 'string' || !e.text.trim()) return { ok: false, reason: 'entry' };
    const id = Number.isFinite(e.id) ? e.id : nextId++;
    entries.push({
      id,
      text: e.text,
      timestamp: typeof e.timestamp === 'string' && e.timestamp ? e.timestamp : new Date(Number(id)).toLocaleString(),
      wordCount: Number.isFinite(e.wordCount) ? e.wordCount : (e.text.match(/\S+/g) || []).length,
    });
  }
  return { ok: true, entries };
}

// Fügt importierte Einträge vor die bestehenden ein; kollidierende IDs
// werden neu gestempelt (Timestamps bleiben erhalten).
export function mergeEntries(existing, incoming) {
  const ids = new Set(existing.map(e => e.id));
  let nextId = Date.now();
  const add = incoming.map(e => (ids.has(e.id) ? { ...e, id: ++nextId } : e));
  return [...add, ...existing].sort((a, b) => b.id - a.id);
}

export function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
