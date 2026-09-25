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
| 15 | **WebGPU int4 (experimentell)** | GPU-Beschleunigung im Browser: int4-Encoder via MatMulNBits auf WebGPU, int8-Decoder im WASM-Hybrid. Setting „GPU (WebGPU) verwenden", **Default AUS**, automatischer CPU-Fallback. | ⛔️ zurückgestellt (2026-09-21) — Messung auf Radeon-iGPU (Chrome 153) zeigt: `backend: webgpu-hybrid` aktiv, aber **kein Speedup** (Encode 25,1 s / 23 s Audio) **und falsche Ausgabe** (nur „A"): ORT 1.27 rechnet int4-MatMulNBits auf WebGPU mit fp16-Akkumulation; der Fix `enableMatmulFp32Accumulation` (ORT-PR #29599) fehlt in 1.27. **Kein ORT-Upgrade hilft:** `enableMatmulFp32Accumulation` wird laut ORT-Doku nur vom **nativen** WebGPU-EP gelesen, der **JSEP-Backend von onnxruntime-web ignoriert es** (geprüft: in 1.30.0-Bundles nicht vorhanden). Der Browser-int4-Pfad bleibt daher dauerhaft unbrauchbar; UI-Warnhinweis bleibt. |

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
| 19 | **CPU-only WASM-Runtime (plain) statt jsep** | A/B-Test (Branch `wasm-plain-ab`, `?wasm=plain`): schlanker 13-MB-Build ohne JSEP/WebGPU-Kleber könnte für denselben Op andere CPU-Kernel wählen. | ⛔️ verworfen (2026-09-22) — Messung i5-10310U, int4: plain 2t **9343 ms** / 4t **8809 ms** vs. jsep 2t **8777 ms** / 4t **7489 ms** → plain **nicht schneller** (eher 6–15 % langsamer). Branch gelöscht, jsep bleibt. Nebenbefund: mit korrigierter Thread-Semantik bringt **4t ≈ +17 %** gegenüber 2t (jsep 7489 vs. 8777 ms), RTF ~0,6. |
| 18 | **Encoder-Performance / Thread-Skalierung** | Encoder ~0,5× Echtzeit (i5-10310U, 4C/8T) und ohne Skalierung über die Thread-Zahl. Ursache belegt: ORT liest `env.wasm.numThreads` **nur einmal pro Seitenaufruf** → Thread-Slider wirkte nie ohne Full-Reload; Slider erlaubte zudem 8 Threads auf 4 Kernen (Oversubscription). | ✅ umgesetzt (2026-09-21) — Slider auf `defaultWasmThreads()` gedeckelt + Legacy-Migration aktiviert, Reload-Hinweis auf „Seite neu laden", gated Bench-Hook `?bench=1` + `scripts/bench-encoder.mjs` (frischer Context pro Config, `numThreads`-Gültigkeitsgate, per-Op-Profil). **Wirkung gemessen (2026-09-22, i5-10310U):** 2t ≈ 8777 ms, 4t ≈ 7489 ms → +17 %; Threadzahl wirkt jetzt, Sättigung erst bei 4 (nicht mehr bei 2). |
| 17 | **Schneller Decoder + Performance-Anzeige** | Stock-Decoder (efederici) hatte keine in-graph `lse`/`topk`-Ausgänge → teurer JS-Log-Partition-Pfad pro Decode-Schritt (thread-/GPU-unabhängig). Fix: optimierter int8-Decoder (Olicorne `int8/`) zum int4-Encoder; Timings im Statistik-Reiter (Encode/Decode/RTF/Backend/Threads). | ✅ umgesetzt (2026-09-21) — LAN-Decoder getauscht, Pages-Decoder-Override in `config.js`; Messwerte im Statistik-Reiter |

### onnxruntime-web 1.30.0 (2026-09-22)
Upgrade 1.27.0 → 1.30.0 gemergt (Branch `ort-1.30-upgrade`, Re-Vendoring mit Registry-SRI-Prüfung).
**Kein messbarer Performance-Delta** (encode ~580 ms/Audio-s auf 1.27 vs. ~618 ms/Audio-s auf 1.30; durch
unterschiedliche Clip-Längen konfundiert, Transkript korrekt). Nutzen: **Sicherheitsfixes** (u. a. Härtung beim
Modell-Laden, `MatMulNBits`-Bounds, Graph-Optimizer/QDQ-Härtung). `public/ort` wuchs 76 → 83 MB.
**Service Worker:** Runtime-Assets (`/ort/`, `/ffmpeg/`) sind jetzt **pro Build versioniert**, der Modell-Cache hat eine
**Generation** (`pt-models-v2`); der Activate-Handler löscht alte Generationen aller drei Familien. Grund: der ORT-Upgrade
ändert die Bytes bei **gleichen Dateinamen**, und ein cache-first Treffer hätte die sha384-Prüfung im PROD-Build hart
scheitern lassen (Modell lädt nicht). Modell-Generation bei jedem Modelldatei-Wechsel manuell hochziehen.
**UI:** WebGPU-Schalter und Encoder-Quantisierung sind vorübergehend **ausgeblendet** und auf `useWebGPU=false`
bzw. `encoderQuant='int4'` festgelegt (Persistenz heilt alte Werte beim Boot). Engine-Pfad und i18n-Keys bleiben,
Reaktivierung = 2 JSX-Zeilen. WebGPU-EP-Optionen an 1.30 angepasst (`{name:'webgpu'}`, Legacy-Felder entfernt).

> ### `canary-web` — Canary-180M als zweite Modellfamilie (gemergt 2026-09-25)
> NVIDIA **Canary-180M-Flash** (AED: FastConformer-Encoder + Transformer-Decoder, CC-BY-4.0, en/de/es/fr) ist
> als **opt-in** wählbar (Einstellungen → Erweitert → **Modell**; Parakeet bleibt Default). Quelle:
> `istupakov/canary-180m-flash-onnx` (int8: Encoder 133,7 MB + Decoder 79,5 MB), LAN-Mirror `/models-canary/`.
>
> **Messung (i5-10310U, 15,89 s Audio, 4 Threads, WASM):** encode **1.547 ms (97 ms/Audio-s)** — ~6× schneller
> als Parakeet (~580–620 ms/Audio-s); decode **5.755 ms für 69 Tokens (12 Tok/s)**; **RTF 0,46** (Parakeet ~0,60).
> ⇒ Encoder-Gate klar bestanden; **Decoder ist der neue Flaschenhals** (Cross-Attention-K/V wird im Export pro
> Token über den ganzen Encoder-Output neu projiziert, O(Tokens × Tenc); onnx-asr hat dasselbe Profil) → bei
> kurzen Diktaten gewinnt Canary, bei sehr langen Aufnahmen könnte Parakeet aufholen.
>
> **Umfang v1:** nur **Transkription** (Sprache de/en/es/fr, PnC an/aus). **Übersetzung (AST) wird nicht
> angeboten** — im Test schlechte Ergebnisse, und der Support ist nicht implementiert (kein `target_language` in
> der UI). Keine Timestamps, keine Chunk-Parallelität.
>
> **Technik:** `app/src/canary.js` (AED-Greedy mit `decoder_mems`-KV-Cache), `app/src/canary-encoder.js`,
> `app/src/tokenizer-canary.js` (▁→Space, Detok-Regex wie onnx-asr), Modell-Dropdown + `modelFamily` im
> Messbericht; `__ptBench.measureCanary`/`transcribeCanary` + `/fixtures/`-Route für Golden-Tests.
> Verifiziert: Unit 25/25, headless Suiten grün, Root-Baseline unverändert.

## Empfohlene Reihenfolge (bei Fortsetzung)

2 ✅ → 3 ✅ → **1 (Datei-Transkription)** → **4 (PWA)**; 5 jederzeit einschiebbar.
