// Stille-Erkennung (VAD) für den Aufnahme-Abbruch. Reine Zustandsmaschine,
// ohne DOM/AudioContext — die RMS-Werte (0..100) liefert der Level-Monitor,
// die Zeit wird injiziert (nowMs), damit sie testbar ist.
//
// Wichtig zur Kalibrierung: Das Mikrofon liefert praktisch nie echten
// Nullpegel — es gibt immer einen Restsockel (Raumgeräusch, Dither). Wir
// messen ihn als MINIMUM der Kalibrierungsphase (nicht als Mittelwert), damit
// sofortiges Sprechen die Messung nicht verfälscht. Die wirksame Schwelle wird
// zusätzlich auf threshold*3 gedeckelt, damit ein hoher Sockel normale Sprache
// nicht verschluckt.

export const VAD_THRESHOLDS = { low: 8, medium: 4, high: 2 };

export function createSilenceDetector(opts = {}) {
  const threshold = Number(opts.threshold) || 4;
  const silenceSec = Number(opts.silenceSec) || 5;
  const minSpeechSec = Number(opts.minSpeechSec) || 0.4;
  const calibrationMs = Number(opts.calibrationMs) || 700;
  const adaptiveFactor = Number(opts.adaptiveFactor) || 2;

  let startTime = null;
  let lastT = null;
  let noiseMin = null;
  let speechAccumMs = 0;
  let silenceStart = null;
  let speechDetected = false;
  let reported = false;

  function reset() {
    startTime = null; lastT = null; noiseMin = null;
    speechAccumMs = 0; silenceStart = null; speechDetected = false; reported = false;
  }

  function feed(rawLevel, nowMs) {
    const level = Math.max(0, Math.min(100, Number(rawLevel) || 0));
    if (startTime === null) { startTime = nowMs; lastT = nowMs; noiseMin = level; return snapshot('calibrating', 0, level, null); }

    // Kalibrierung: Minimum (Restsockel) über das Fenster messen.
    if (nowMs - startTime < calibrationMs) {
      noiseMin = Math.min(noiseMin === null ? level : noiseMin, level);
      lastT = nowMs;
      return snapshot('calibrating', 0, level, null);
    }

    // Gedeckelte adaptive Schwelle: nie höher als threshold*3.
    const floor = noiseMin === null ? 0 : noiseMin;
    const effective = Math.max(threshold, Math.min(floor * adaptiveFactor, threshold * 3));

    let dt = nowMs - lastT;
    if (dt < 0) dt = 0;
    if (dt > 500) dt = 500; // Lücken (Tab inaktiv) nicht als Stille zählen
    lastT = nowMs;

    if (level >= effective) {
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
    return {
      shouldStop: false,
      state,
      silenceSec: silenceMs / 1000,
      speechDetected,
      level,
      effective,
    };
  }

  return { feed, reset };
}
