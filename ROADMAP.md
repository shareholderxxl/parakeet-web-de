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
| 15 | **WebGPU int4 (experimentell)** | GPU-Beschleunigung im Browser: int4-Encoder via MatMulNBits auf WebGPU, int8-Decoder im WASM-Hybrid. Setting „GPU (WebGPU) verwenden", **Default AUS**, automatischer CPU-Fallback. | ✅ umgesetzt (2026-09-14) — Resolver öffnet int4 für WebGPU; Messung/Verifikation auf realer GPU offen |

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
| 14 | **README modernisieren + Cleanup** | README an neue UI/Features anpassen; ungenutzte alte UI-Libs entfernen (`lib/remote`, `diariz`, `supportReport`, …). | offen |

## Empfohlene Reihenfolge (bei Fortsetzung)

2 ✅ → 3 ✅ → **1 (Datei-Transkription)** → **4 (PWA)**; 5 jederzeit einschiebbar.
