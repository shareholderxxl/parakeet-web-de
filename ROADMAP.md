# Roadmap — portabletranscribe

> Status-Übersicht möglicher Verbesserungen. **Alle Punkte sind offen** — der
> Nutzer entscheidet einzeln, ob und wann umgesetzt wird.
> Verwandt: [`DEPLOY_STRATO_PLAN.md`](./DEPLOY_STRATO_PLAN.md) (Veröffentlichung STRATO).

## Hoher Nutzen

| # | Feature | Beschreibung | Status |
|---|---------|--------------|--------|
| 1 | **Audio-/Video-Datei-Transkription** | Aufnahmen (Meetings, Voice-Memos) hochladen statt nur Mikrofon; `ffmpeg-core.wasm` ist bereits gebundelt (`public/ffmpeg`) → Dekodierung zu PCM 16 kHz, Transcribe-Pfad existiert. Größter Funktionsgewinn, moderater Aufwand. | offen |
| 2 | **Editor-Autosave** | Aktueller Editor-Inhalt (Quill-Delta) in IndexedDB persistieren (Debounce + Flush bei Tab-Wechsel); Wiederherstellung nach Reload mit Toast. Schließt Datenverlust bei Reload/Absturz. | ✅ umgesetzt (2026-09-09) |
| 3 | **Export & Backup** | Eintrags-Export als `.txt`; komplette Historie in **einer** Datei exportieren — Format wählbar (JSON-Backup re-importierbar / `.txt` lesbar); Import mit Validierung + Bestätigungs-Modal, Merge mit ID-Dedupe. Passt zum „Daten liegen bei dir"-Versprechen. | ✅ umgesetzt (2026-09-09) |
| 4 | **PWA (installierbar + offline)** | Service Worker + Manifest; App-Shell und Modell sind lokal gecached → startet ohne Netz wie eine Desktop-App, insbesondere auf Mobilgeräten. | ✅ umgesetzt (2026-09-11) — Manifest/Icons, SW (Shell-Precache, ORT/ffmpeg-Runtime-Cache, `/models/` in Cache Storage), hub.js offline-tolerant; SW wird nur auf Hosts mit gültigem TLS (Nicht-IP) registriert — LAN per IP bewusst ohne PWA |

## Nützlich

| # | Feature | Beschreibung | Status |
|---|---------|--------------|--------|
| 5 | **Sprachauswahl** | v3-Modell beherrscht ~25 europäische Sprachen, genutzt wird nur Deutsch. Dropdown im Settings; Diktat-Regeln bleiben DE-spezifisch. Kleiner Aufwand, großer Zuwachs. | ✅ erledigt (2026-09-11) — Engine erkennt Sprache automatisch (kein Sprachparameter); toten State entfernt, Hinweis ergänzt |
| 6 | **Historie-Suche** | Volltextfilter über alle Einträge (relevant mit wachsender Historie). | ✅ umgesetzt (2026-09-11) |
| 7 | **Auto-Stopp bei Stille (VAD)** | frequenzbasierte Stille-Erkennung, beendet die Aufnahme automatisch (wie in der Desktop-App PortableWhisper). | offen — erster Ansatz (2026-09-11) wieder entfernt, funktionierte nicht zuverlässig |
| 8 | **Eigene Diktat-Ersetzungen** | Nutzer-definierte Regeln (z. B. „Komma" → „,") im Settings, ergänzend zur festen CSV aus `dictation-regex/`. | ✅ umgesetzt (2026-09-11) |
| 9 | **Statistik** | Wörter gesamt, Aufnahmedauer, Ø Sprechgeschwindigkeit; Anreicherung der Settings. | ✅ umgesetzt (2026-09-11) — eigener Nav-Reiter, Gesamtzahlen |
| 15 | **WebGPU int4 (experimentell)** | GPU-Beschleunigung im Browser: int4-Encoder via MatMulNBits auf WebGPU, int8-Decoder im WASM-Hybrid. Setting „GPU (WebGPU) verwenden", **Default AUS**, automatischer CPU-Fallback. | ⛔️ zurückgestellt (2026-09-21) — Messung auf Radeon-iGPU (Chrome 153) zeigt: `backend: webgpu-hybrid` aktiv, aber **kein Speedup** (Encode 25,1 s / 23 s Audio) **und falsche Ausgabe** (nur „A"): ORT 1.27 rechnet int4-MatMulNBits auf WebGPU mit fp16-Akkumulation; der Fix `enableMatmulFp32Accumulation` (ORT-PR #29599) fehlt in 1.27. Reaktivierung erst nach ORT-Upgrade. UI-Hinweis ergänzt. |

## Nice-to-have

| # | Feature | Beschreibung | Status |
|---|---------|--------------|--------|
| 10 | **Wort-Timestamps nutzen** | `words[]` wird von der Engine bereits geliefert; Sprecher-/Pausengrenzen als Absätze bei langen Aufnahmen (v. a. mit Feature 1 sinnvoll). | offen |
| 11 | **Tastenkürzel** | Aufnahme Start/Stopp (z. B. `Strg+Shift+R`); globale Hotkeys wie F9 (Desktop-App) sind im Browser ohne Extension nicht möglich. | offen |
| 12 | **Meta-/OG-Tags** | Preview-Karte beim Teilen des Links, Feinschliff favicon — relevant für den Public-Gang. | offen |

## Betrieb / Technik (begleitend)

| # | Feature | Beschreibung | Status |
|---|---------|--------------|--------|
| 13 | **Playwright-E2E-Smoke-Test** | Headless-Chromium vorhanden: Modell-Load, Aufnahme simulieren, Historie/Export prüfen — sichert künftige Umbauten ab. | offen |
| 14 | **README modernisieren + Cleanup** | README an neue UI/Features anpassen; ungenutzte alte UI-Libs entfernen (`lib/remote`, `diariz`, `supportReport`, …). | teilweise (2026-09-21) — entfernt: `encode.worker.js`, `workerInit.js`, `decode.worker.js`, `asset-integrity.js`, `audioDecode.js`, `beamWidth.js`, `encodePoolPlan()`; behalten: 6 Libs, die nur von Upstream-Unit-Tests referenziert werden (`supportReport`, `format`, `persistStorage`, `chunkDuration`, `captureQueue`, `browserFamily`) |
| 16 | **GitHub-Pages-Hosting (öffentlich, nicht kommerziell)** | Root-Site `shareholderxxl.github.io`; App clientseitig, Modell von HuggingFace (`VITE_MODEL_SOURCE=remote`), Service Worker cached HF-Modell offline; Deploy nur per `scripts/deploy-pages.sh` (opencode-getriggert); Datenschutzseite, kein Impressum (privat). | ✅ umgesetzt (2026-09-21) — live; **Remote-Modell nur im SW-Cache** (kein IndexedDB-Doppel); **Modell-/Offline-Verifikation nur auf Client ≥8 GB** (4-GB-Wyse rebootet bei Modell-Last) |
| 18 | **Encoder-Performance / Thread-Skalierung** | Encoder ~0,5× Echtzeit (i5-10310U, 4C/8T) und ohne Skalierung über die Thread-Zahl. Ursache belegt: ORT liest `env.wasm.numThreads` **nur einmal pro Seitenaufruf** → Thread-Slider wirkte nie ohne Full-Reload; Slider erlaubte zudem 8 Threads auf 4 Kernen (Oversubscription). | ✅ umgesetzt (2026-09-21) — Slider auf `defaultWasmThreads()` gedeckelt + Legacy-Migration aktiviert, Reload-Hinweis auf „Seite neu laden", gated Bench-Hook `?bench=1` + `scripts/bench-encoder.mjs` (frischer Context pro Config, `numThreads`-Gültigkeitsgate, per-Op-Profil) |
| 17 | **Schneller Decoder + Performance-Anzeige** | Stock-Decoder (efederici) hatte keine in-graph `lse`/`topk`-Ausgänge → teurer JS-Log-Partition-Pfad pro Decode-Schritt (thread-/GPU-unabhängig). Fix: optimierter int8-Decoder (Olicorne `int8/`) zum int4-Encoder; Timings im Statistik-Reiter (Encode/Decode/RTF/Backend/Threads). | ✅ umgesetzt (2026-09-21) — LAN-Decoder getauscht, Pages-Decoder-Override in `config.js`; Messwerte im Statistik-Reiter |

## Empfohlene Reihenfolge (bei Fortsetzung)

2 ✅ → 3 ✅ → **1 (Datei-Transkription)** → **4 (PWA)**; 5 jederzeit einschiebbar.
