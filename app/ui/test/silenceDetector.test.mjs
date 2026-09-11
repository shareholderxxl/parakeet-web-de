import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSilenceDetector, VAD_THRESHOLDS } from '../src/lib/silenceDetector.js';

// Hilfsfunktion: füttert den Detektor mit konstantem Level über eine Dauer.
// `stopped` merkt sich, ob irgendwann ausgelöst wurde (auch wenn danach
// weitergefüttert wird und shouldStop wieder false liefert).
function feedFor(det, level, fromMs, ms, stepMs = 50) {
  let last, stopped = false;
  for (let t = fromMs; t <= fromMs + ms; t += stepMs) { last = det.feed(level, t); if (last.shouldStop) stopped = true; }
  return { last, stopped, endMs: fromMs + ms };
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
  const { stopped } = feedFor(d, 0, 2200, 5000);
  assert.equal(stopped, true, 'sollte nach 5 s Stille auslösen');
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

// --- Regressionen aus dem Praxis-Bugreport ---

test('Restsockel 3,5 + Sprache 10 löst aus (vorher verschluckt)', () => {
  const d = createSilenceDetector({ threshold: 4, silenceSec: 5 });
  feedFor(d, 3.5, 0, 700);           // Kalibrierung auf Restsockel
  feedFor(d, 10, 700, 1500);         // Sprache knapp über Sockel
  const { stopped } = feedFor(d, 3.5, 2200, 5200);
  assert.equal(stopped, true);
});

test('Sprache ab Sekunde 0 (Kalibrierung kontaminiert) löst aus', () => {
  const d = createSilenceDetector({ threshold: 4, silenceSec: 5 });
  feedFor(d, 30, 0, 2200);           // sofort sprechen, Kalibrierung enthält Sprache
  const { stopped } = feedFor(d, 2, 2200, 5200);
  assert.equal(stopped, true);
});

test('Sockel fällt nie auf null: Stille bei Sockelpegel löst aus', () => {
  const d = createSilenceDetector({ threshold: 4, silenceSec: 5 });
  feedFor(d, 4, 0, 700);             // Restsockel 4
  feedFor(d, 15, 700, 1200);         // Sprache
  const { stopped } = feedFor(d, 4, 1900, 5200); // "Stille" ist nur der Sockel
  assert.equal(stopped, true);
});

test('wirksame Schwelle gedeckelt (max threshold*3)', () => {
  const d = createSilenceDetector({ threshold: 4, silenceSec: 5 });
  let r;
  for (let t = 0; t <= 700; t += 16) r = d.feed(50, t); // sehr laute Kalibrierung
  const after = d.feed(50, 800);
  assert.ok(after.effective <= 12, `effective ${after.effective} sollte <= 12 sein`);
  assert.ok(after.effective >= 4);
});
