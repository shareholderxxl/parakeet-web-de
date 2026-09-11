// Stille-Erkennung (VAD) für den Aufnahme-Abbruch. Reine Zustandsmaschine,
// ohne DOM/AudioContext — die RMS-Werte (0..100) liefert der Level-Monitor,
// die Zeit wird injiziert (nowMs), damit sie testbar ist.
//
// Pegel sind stark mikrofonabhängig (leise Laptops liefern RMS 0,005, laute
// Headsets 0,2). Deshalb arbeitet die Erkennung RELATIV zum Rauschpegel:
//   - Pegel wird leicht geglättet (EMA), damit einzelne Ausreißer-Dips den
//     Restsockel nicht nach unten reißen
//   - floor = Restsockel (Minimum des geglätteten Pegels)
//   - peak  = langsam abklingender Spitzenpegel
//   - Sprache liegt vor, wenn level >= floor + max(minRise, (peak-floor)*relRise)
// So funktioniert es bei leisen wie lauten Mikrofonen, ohne feste Absolutwerte.

export const VAD_SENSITIVITY = {
  low:    { minRise: 1.0,  relRise: 0.35 },
  medium: { minRise: 0.5,  relRise: 0.25 },
  high:   { minRise: 0.25, relRise: 0.15 },
};
const SMOOTH_TAU_MS = 120;  // EMA-Glättung des Pegels
const PEAK_TAU_MS = 8000;   // Spitzenpegel klingt über ~8 s ab

export function createSilenceDetector(opts = {}) {
  const sens = VAD_SENSITIVITY[opts.sensitivity] || VAD_SENSITIVITY.medium;
  const absThreshold = Number(opts.threshold) || null; // optionaler absoluter Override (Tests)
  const silenceSec = Number(opts.silenceSec) || 5;
  const minSpeechSec = Number(opts.minSpeechSec) || 0.35;
  const calibrationMs = Number(opts.calibrationMs) || 700;

  let startTime = null;
  let lastT = null;
  let smooth = null;
  let floor = null;
  let peak = null;
  let speechAccumMs = 0;
  let silenceStart = null;
  let speechDetected = false;
  let reported = false;

  function reset() {
    startTime = null; lastT = null; smooth = null; floor = null; peak = null;
    speechAccumMs = 0; silenceStart = null; speechDetected = false; reported = false;
  }

  function effectiveThreshold() {
    if (absThreshold !== null) return absThreshold;
    const f = floor === null ? 0 : floor;
    const p = peak === null ? f : peak;
    return f + Math.max(sens.minRise, Math.max(p - f, 0) * sens.relRise);
  }

  function feed(rawLevel, nowMs) {
    const level = Math.max(0, Math.min(100, Number(rawLevel) || 0));
    if (startTime === null) {
      startTime = nowMs; lastT = nowMs; smooth = level; floor = null; peak = level;
      return snapshot('calibrating', 0, level, effectiveThreshold());
    }

    let dt = nowMs - lastT;
    if (dt < 0) dt = 0;
    if (dt > 500) dt = 500; // Lücken (Tab inaktiv) nicht als Stille zählen
    lastT = nowMs;

    // Leichte Glättung: einzelne Ausreißer-Dips verfälschen den Sockel nicht.
    smooth += (level - smooth) * Math.min(1, dt / SMOOTH_TAU_MS);
    const s = smooth;

    if (nowMs - startTime < calibrationMs) {
      // Sockel NICHT aus dem ersten Sample ableiten (Audio-Start liefert kurz 0).
      peak = Math.max(peak, s);
      return snapshot('calibrating', 0, level, effectiveThreshold());
    }

    if (floor === null) floor = s;         // Sockel = eingeschwungener Pegel am Kalibrierungsende
    else floor = Math.min(floor, s);       // danach nur noch nach unten nachführen
    peak = Math.max(s, peak * Math.exp(-dt / PEAK_TAU_MS));
    const effective = effectiveThreshold();

    if (s >= effective) {
      speechAccumMs += dt;
      silenceStart = null;
      if (speechAccumMs >= minSpeechSec * 1000) speechDetected = true;
      return snapshot('listening', 0, level, effective);
    }

    // Unterhalb der Schwelle.
    if (!speechDetected) { silenceStart = null; return snapshot('waiting', 0, level, effective); }
    if (silenceStart === null) silenceStart = nowMs;
    const silenceMs = nowMs - silenceStart;
    if (silenceMs >= silenceSec * 1000) {
      if (!reported) { reported = true; return { shouldStop: true, state: 'silence', silenceSec: silenceMs / 1000, speechDetected, level, effective }; }
      return snapshot('silence', silenceMs, level, effective);
    }
    return snapshot('silence', silenceMs, level, effective);
  }

  function snapshot(state, silenceMs, level, effective) {
    return { shouldStop: false, state, silenceSec: silenceMs / 1000, speechDetected, level, effective };
  }

  return { feed, reset };
}
