import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeRegex, validateRule, applyUserRules } from '../src/lib/dictationRules.js';

test('escapeRegex escaped Sonderzeichen', () => {
  assert.equal(escapeRegex('a.b*c'), 'a\\.b\\*c');
  assert.equal(escapeRegex('(x)[y]'), '\\(x\\)\\[y\\]');
});

test('validateRule: leer / ungültiges Regex / gültig', () => {
  assert.deepEqual(validateRule({ find: '' }), { ok: false, error: 'empty' });
  assert.deepEqual(validateRule({ find: '(', isRegex: true }), { ok: false, error: 'regex' });
  const ok = validateRule({ find: 'a.b', isRegex: true, replacement: 'X' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { find: 'a.b', replacement: 'X', isRegex: true, caseSensitive: false, enabled: true });
});

test('applyUserRules: Literal case-insensitiv (Default)', () => {
  const rules = [{ id: 1, find: 'komma', replacement: ',', isRegex: false, caseSensitive: false, enabled: true }];
  assert.equal(applyUserRules('Hallo Komma Welt', rules), 'Hallo , Welt');
});

test('applyUserRules: Literal case-sensitiv', () => {
  const rules = [{ id: 1, find: 'Komma', replacement: ',', isRegex: false, caseSensitive: true, enabled: true }];
  assert.equal(applyUserRules('Hallo komma Welt', rules), 'Hallo komma Welt');
  assert.equal(applyUserRules('Hallo Komma Welt', rules), 'Hallo , Welt');
});

test('applyUserRules: Regex global', () => {
  const rules = [{ id: 1, find: '\\d+', replacement: 'N', isRegex: true, enabled: true }];
  assert.equal(applyUserRules('Test 123 und 45', rules), 'Test N und N');
});

test('applyUserRules: deaktivierte Regeln übersprungen, Reihenfolge erhalten', () => {
  const rules = [
    { id: 1, find: 'a', replacement: 'b', isRegex: false, enabled: false },
    { id: 2, find: 'b', replacement: 'c', isRegex: false, enabled: true },
  ];
  assert.equal(applyUserRules('a', rules), 'a');
  assert.equal(applyUserRules('b', rules), 'c');
});

test('applyUserRules: ungültiges Regex wird zur Laufzeit ignoriert', () => {
  const rules = [{ id: 1, find: '(', replacement: 'x', isRegex: true, enabled: true }];
  assert.equal(applyUserRules('abc', rules), 'abc');
});

test('applyUserRules: kein Text / keine Regeln → unverändert', () => {
  assert.equal(applyUserRules('', [{ id: 1, find: 'a', replacement: 'b', enabled: true }]), '');
  assert.equal(applyUserRules('abc', []), 'abc');
  assert.equal(applyUserRules('abc', null), 'abc');
});
