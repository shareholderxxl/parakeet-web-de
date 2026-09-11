import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSilenceDetector, VAD_THRESHOLDS } from '../src/lib/silenceDetector.js';

// Hilfsfunktion: füttert den Detektor mit konstantem Level über eine Dauer.
function feedFor(det, level, fromMs, ms, stepMs = 50) {
  let last;
  for (let t = fromMs; t <= fromMs + ms; t += stepMs) last = det.feed(level, t);
  return { last, endMs: fromMs + ms };
}

test('Kalibrierung: in den ersten 700 ms nie auslösen', () => {
  const d = createSilenceDetector({ silenceSec: 5 });
  let r;
  for (let t = 0; t <= 600; t += 50) r = d.feed(0, t);
  assert.equal(r.state, 'calibrating');
  assert.equal(r.shouldStop, false);
});

test('Sprache, dann 5 s Stille → shouldStop genau einmal', () => {
  const d = createSilenceDetector({ silenceSec: 5, threshold: 4 });
  feedFor(d, 0, 0, 700);            // Kalibrierung
  feedFor(d, 50, 700, 1500);        // Sprache
  const { last } = feedFor(d, 0, 2200, 5000);
  assert.equal(last.shouldStop, true, 'sollte nach 5 s Stille auslösen');
  const after = d.feed(0, 7300);
  assert.equal(after.shouldStop, false, 'darf nicht erneut feuern');
});

test('kurze Pause (< 5 s) löst nicht aus', () => {
  const d = createSilenceDetector({ silenceSec: 5, threshold: 4 });
  feedFor(d, 0, 0, 700);
  feedFor(d, 50, 700, 1000);
  const { last } = feedFor(d, 0, 1700, 3000);
  assert.equal(last.shouldStop, false);
});

test('Stille ohne vorherige Sprache löst nicht aus', () => {
  const d = createSilenceDetector({ silenceSec: 5, threshold: 4 });
  feedFor(d, 0, 0, 20000);
  const r = d.feed(0, 20100);
  assert.equal(r.shouldStop, false);
  assert.equal(r.speechDetected, false);
});

test('adaptive Schwelle: lautes Grundrauschen verhindert Fehlauslösung', () => {
  const d = createSilenceDetector({ silenceSec: 5, threshold: 4 });
  feedFor(d, 3, 0, 700);            // Grundrauschen 3 → effektiv max(4, 9) = 9
  const { last } = feedFor(d, 5, 700, 8000); // Level 5 unter effektiver Schwelle, aber kein Sprachbeginn
  assert.equal(last.speechDetected, false);
  assert.equal(last.shouldStop, false);
});

test('reset() setzt den Zustand zurück', () => {
  const d = createSilenceDetector({ silenceSec: 5 });
  feedFor(d, 0, 0, 700);
  feedFor(d, 50, 700, 1000);
  d.reset();
  const r = d.feed(0, 100000);
  assert.equal(r.state, 'calibrating');
});

test('VAD_THRESHOLDS Reihenfolge: hohe Empfindlichkeit = niedrigere Schwelle', () => {
  assert.ok(VAD_THRESHOLDS.high < VAD_THRESHOLDS.medium);
  assert.ok(VAD_THRESHOLDS.medium < VAD_THRESHOLDS.low);
});
