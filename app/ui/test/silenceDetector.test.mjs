import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSilenceDetector, VAD_SENSITIVITY } from '../src/lib/silenceDetector.js';

// Hilfsfunktion: füttert den Detektor mit konstantem Level über eine Dauer.
// `stopped` merkt sich, ob irgendwann ausgelöst wurde.
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

test('Absoluter Override: Sprache, dann 5 s Stille → once', () => {
  const d = createSilenceDetector({ threshold: 4, silenceSec: 5 });
  feedFor(d, 0, 0, 700);
  feedFor(d, 50, 700, 1500);
  const { stopped } = feedFor(d, 0, 2200, 6200);
  assert.equal(stopped, true);
});

test('Stille ohne vorherige Sprache löst nicht aus', () => {
  const d = createSilenceDetector({ threshold: 4, silenceSec: 5 });
  feedFor(d, 0, 0, 20000);
  const r = d.feed(0, 20100);
  assert.equal(r.shouldStop, false);
  assert.equal(r.speechDetected, false);
});

test('reset() setzt den Zustand zurück', () => {
  const d = createSilenceDetector({ silenceSec: 5 });
  feedFor(d, 0, 0, 700);
  feedFor(d, 50, 700, 1000);
  d.reset();
  const r = d.feed(0, 100000);
  assert.equal(r.state, 'calibrating');
});

// --- Praxis-Fälle ---

test('LEISES Mikrofon: Sockel 1,5 + Sprache 2,5 (medium) löst aus', () => {
  const d = createSilenceDetector({ sensitivity: 'medium', silenceSec: 5 });
  feedFor(d, 1.5, 0, 700);            // leiser Sockel
  const mid = feedFor(d, 2.5, 700, 1500); // Sprache nur knapp darüber
  assert.equal(mid.last.speechDetected, true, `speechDetected bei effective ${mid.last.effective}`);
  const { stopped } = feedFor(d, 1.5, 2200, 6400);
  assert.equal(stopped, true);
});

test('Sockel fällt nie auf null: Stille bei Sockelpegel löst aus', () => {
  const d = createSilenceDetector({ sensitivity: 'medium', silenceSec: 5 });
  feedFor(d, 4, 0, 700);
  feedFor(d, 15, 700, 1200);
  const { stopped } = feedFor(d, 4, 1900, 6400);
  assert.equal(stopped, true);
});

test('Kalibrierung mit Sprache: nach Pause sinkt Sockel, dann greift Erkennung', () => {
  const d = createSilenceDetector({ sensitivity: 'medium', silenceSec: 5 });
  feedFor(d, 10, 0, 700);             // sofort sprechen (Kalibrierung kontaminiert)
  feedFor(d, 1, 700, 4000);           // längere Pause: Sockel sinkt Richtung 1
  const mid = feedFor(d, 6, 4700, 1200); // Sprache wieder
  assert.equal(mid.last.speechDetected, true, `effective ${mid.last.effective}`);
  const { stopped } = feedFor(d, 1, 5900, 6400);
  assert.equal(stopped, true);
});

test('nur Rauschen ohne Sprache löst nicht aus', () => {
  const d = createSilenceDetector({ sensitivity: 'high', silenceSec: 5 });
  feedFor(d, 2, 0, 25000);
  const r = d.feed(2, 25100);
  assert.equal(r.shouldStop, false);
});

test('Empfindlichkeit: high hat kleinere wirksame Schwelle als low', () => {
  const scen = (sensitivity) => {
    const d = createSilenceDetector({ sensitivity, silenceSec: 5 });
    feedFor(d, 3, 0, 700);
    feedFor(d, 20, 700, 1000);
    return d.feed(20, 1800).effective;
  };
  assert.ok(scen('high') <= scen('medium'));
  assert.ok(scen('medium') <= scen('low'));
});

test('VAD_SENSITIVITY Presets vorhanden und geordnet', () => {
  assert.ok(VAD_SENSITIVITY.low.minRise > VAD_SENSITIVITY.medium.minRise);
  assert.ok(VAD_SENSITIVITY.medium.minRise > VAD_SENSITIVITY.high.minRise);
});
