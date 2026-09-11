import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExportJson, buildExportTxt, parseImportJson, mergeEntries, exportFilename } from '../src/lib/historyIo.js';

test('JSON-Roundtrip erhält durationSec', () => {
  const entries = [{ id: 1000, text: 'Hallo', timestamp: 'x', wordCount: 1, durationSec: 12.3 }];
  const parsed = parseImportJson(buildExportJson(entries));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entries[0], { id: 1000, text: 'Hallo', timestamp: 'x', wordCount: 1, durationSec: 12.3 });
});

test('Import toleriert Alteinträge ohne durationSec', () => {
  const parsed = parseImportJson(JSON.stringify({ entries: [{ id: 1, text: 'a', timestamp: 't', wordCount: 1 }] }));
  assert.equal(parsed.ok, true);
  assert.equal('durationSec' in parsed.entries[0], false);
});

test('parseImportJson lehnt ungültige Struktur/Einträge ab', () => {
  assert.equal(parseImportJson('{broken').reason, 'parse');
  assert.equal(parseImportJson('[]').entries.length, 0);
  assert.equal(parseImportJson('{"entries":[{"text":123}]}').reason, 'entry');
});

test('mergeEntries stempelt kollidierende IDs neu, behält Felder', () => {
  const merged = mergeEntries([{ id: 5, text: 'alt' }], [{ id: 5, text: 'neu', durationSec: 3 }]);
  assert.equal(merged.length, 2);
  const imported = merged.find(e => e.text === 'neu');
  assert.notEqual(imported.id, 5);
  assert.equal(imported.durationSec, 3);
});

test('buildExportTxt enthält Zeitstempel und Text', () => {
  const txt = buildExportTxt([{ id: 1, text: 'Hallo Welt', timestamp: '09.09.2026, 10:00' }]);
  assert.match(txt, /=== 09\.09\.2026, 10:00 ===/);
  assert.match(txt, /Hallo Welt/);
});

test('exportFilename Format', () => {
  assert.match(exportFilename('portabletranscribe', 'txt', 1700000000000), /^portabletranscribe-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.txt$/);
});
