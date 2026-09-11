// Stille-Erkennung (VAD) für den Aufnahme-Abbruch. Reine Zustandsmaschine,
// ohne DOM/AudioContext — die RMS-Werte (0..100) liefert der Level-Monitor,
// die Zeit wird injiziert (nowMs), damit sie testbar ist.

export const VAD_THRESHOLDS = { low: 8, medium: 4, high: 2 };

export function createSilenceDetector(opts = {}) {
  const threshold = Number(opts.threshold) || 4;
  const silenceSec = Number(opts.silenceSec) || 5;
  const minSpeechSec = Number(opts.minSpeechSec) || 0.4;
  const calibrationMs = Number(opts.calibrationMs) || 700;
  const adaptiveFactor = Number(opts.adaptiveFactor) || 3;

  let startTime = null;
  let lastT = null;
  let noiseSum = 0;
  let noiseCount = 0;
  let speechAccumMs = 0;
  let silenceStart = null;
  let speechDetected = false;
  let reported = false;

  function reset() {
    startTime = null; lastT = null; noiseSum = 0; noiseCount = 0;
    speechAccumMs = 0; silenceStart = null; speechDetected = false; reported = false;
  }

  function feed(rawLevel, nowMs) {
    const level = Math.max(0, Math.min(100, Number(rawLevel) || 0));
    if (startTime === null) { startTime = nowMs; lastT = nowMs; return snapshot('calibrating', 0); }

    // Kalibrierung: Grundrauschen messen, in dieser Zeit nicht auslösen.
    if (nowMs - startTime < calibrationMs) {
      noiseSum += level; noiseCount += 1;
      lastT = nowMs;
      return snapshot('calibrating', 0);
    }

    const noiseFloor = noiseCount ? noiseSum / noiseCount : 0;
    const effective = Math.max(threshold, noiseFloor * adaptiveFactor);

    let dt = nowMs - lastT;
    if (dt < 0) dt = 0;
    if (dt > 500) dt = 500; // Lücken (Tab inaktiv) nicht als Stille zählen
    lastT = nowMs;

    if (level >= effective) {
      speechAccumMs += dt;
      silenceStart = null;
      if (speechAccumMs >= minSpeechSec * 1000) speechDetected = true;
      return snapshot('listening', 0);
    }

    // Unterhalb der Schwelle.
    if (!speechDetected) { silenceStart = null; return snapshot('waiting', 0); }
    if (silenceStart === null) silenceStart = nowMs;
    const silenceMs = nowMs - silenceStart;
    if (silenceMs >= silenceSec * 1000) {
      if (!reported) { reported = true; return { shouldStop: true, state: 'silence', silenceSec: silenceMs / 1000, speechDetected }; }
      return snapshot('silence', silenceMs);
    }
    return snapshot('silence', silenceMs);
  }

  function snapshot(state, silenceMs) {
    return {
      shouldStop: false,
      state,
      silenceSec: silenceMs / 1000,
      speechDetected,
    };
  }

  return { feed, reset };
}
