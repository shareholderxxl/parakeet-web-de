# portabletranscribe

Lokale Sprach-zu-Text-Transkription im Browser — **alles läuft clientseitig**,
kein einziges Audio-Sample verlässt dein Gerät. Basierend auf
[NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
(ONNX, SmoothQuant-int8-Encoder) via ONNX Runtime Web (WASM).

> **Vereinfachter Fork** von [thiswillbeyourgithub/parakeet_web](https://github.com/thiswillbeyourgithub/parakeet_web)
> mit dem Ziel: **schlank, deutsch, lokal**.

## Was drin ist

- 🎤 **Mikrofon-Aufnahme** → Transkription mit Wort-Zeitstempeln
- 📁 **Audio-Datei hochladen** (mp3, m4a, wav, … via ffmpeg.wasm)
- 📝 **Diktat-Modus** (deutsche Regeln: gesprochene Satzzeichen → Zeichen)
- 📋 Kopieren / Zwischenablage, Transkriptionsverlauf (lokal)
- 🌐 **UI Deutsch + Englisch** (automatisch erkannt, manuell umschaltbar)
- 🗣️ Multilinguales Modell (25 EU-Sprachen, inkl. Deutsch)

## Was bewusst entfernt wurde (vs. Original)

| Feature | Status |
|---|---|
| Phone-as-Mic (WebRTC + Signaling-Server) | ❌ entfernt |
| Sprecher-Diarization (sherpa-onnx) | ❌ entfernt |
| Phrase-Boosting | ❌ entfernt |
| Live-Transcription | ❌ entfernt |
| Benchmark + Auto-Configure (WebGPU-Probe) | ❌ entfernt (fester WASM-Pfad) |
| OpenAI-kompatibler API-Server | ❌ entfernt |
| SpeechMike-Geräte (WebHID) | ❌ entfernt |

## Quick Start (Server)

```bash
cd /home/hermes/Documents/parakeet-web-de

# 1. Frontend bauen
cd app/ui && npm ci && npm run build && cd ../..

# 2. Modell-Dateien (einmalig; liegen im models/-Ordner)
hf download Olicorne/parakeet-tdt-0.6b-v3-optimized-onnx \
    encoder-model.int8.onnx encoder-model.int8.lite.onnx \
    decoder_joint-model.int8.onnx vocab.txt --local-dir models

# 3. Starten (statischer Server, LAN-only)
python3 serve.py
# → http://<server-ip>:8787/
```

Der Browser lädt das Modell beim **ersten** Besuch einmalig vom Server
(~600 MB, im gleichen Netz schnell) und cached es in IndexedDB — danach
kein erneuter Download.

## Lizenz & Attribution

- Dieser Fork: **AGPL-3.0** (siehe `LICENSE`)
- Basiskode: [thiswillbeyourgithub/parakeet_web](https://github.com/thiswillbeyourgithub/parakeet_web) (AGPL-3.0) — Fork von
  [ysdede/parakeet.js](https://github.com/ysdede/parakeet.js) (MIT)
- Modell: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
  (CC-BY-4.0), ONNX-Konvertierung [istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx),
  Browser-Optimierung [Olicorne](https://huggingface.co/Olicorne/parakeet-tdt-0.6b-v3-optimized-onnx)
- Laufzeit: ONNX Runtime Web (MIT), Preact (MIT), ffmpeg.wasm (GPL)

Details: `ATTRIBUTION.md` (aufgenommen vom Original-Fork).
