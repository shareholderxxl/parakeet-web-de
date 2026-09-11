// Nutzer-definierte Diktat-Ersetzungen (zusätzlich zu den CSV-Regeln).
// Regel-Schema: { id, find, replacement, isRegex, caseSensitive, enabled }
// Reine Funktionen, damit sie ohne DOM testbar sind.

export function escapeRegex(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Validiert eine neue Regel. Liefert { ok:true, value } (ohne id) oder
// { ok:false, error } mit 'empty' | 'regex'.
export function validateRule(input) {
  const find = typeof input?.find === 'string' ? input.find : '';
  if (!find) return { ok: false, error: 'empty' };
  const isRegex = !!input.isRegex;
  if (isRegex) {
    try { new RegExp(find); } catch { return { ok: false, error: 'regex' }; }
  }
  return {
    ok: true,
    value: {
      find,
      replacement: typeof input?.replacement === 'string' ? input.replacement : '',
      isRegex,
      caseSensitive: !!input?.caseSensitive,
      enabled: true,
    },
  };
}

// Wendet alle aktivierten Regeln der Reihe nach an (letzte Instanz nach CSV).
export function applyUserRules(text, rules) {
  if (!text || !Array.isArray(rules) || !rules.length) return text;
  let out = text;
  for (const r of rules) {
    if (!r || !r.enabled || typeof r.find !== 'string' || r.find === '') continue;
    try {
      const flags = 'g' + (r.caseSensitive ? '' : 'i');
      const pattern = r.isRegex ? r.find : escapeRegex(r.find);
      out = out.replace(new RegExp(pattern, flags), r.replacement ?? '');
    } catch { /* ungültige Regel überspringen */ }
  }
  return out;
}
