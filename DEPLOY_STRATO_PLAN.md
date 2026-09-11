# Deploy-Plan: portabletranscribe auf STRATO Hosting

> **Status:** Planung abgeschlossen, Umsetzung noch nicht begonnen.
> **Ziel:** Veröffentlichung von portabletranscribe auf STRATO Hosting Basic
> (100 GB, 3 Domains, 3 SSL-Zertifikate), Deployment vollständig aus opencode
> heraus (Wyse Thin Client), bei Bedarf angestoßen — nicht bei jedem Push.

---

## Grundlagen

- **App ist reiner statischer Webspace**: Vite-Build (`dist/`) + ONNX-Modelle +
  Worklet. `serve.py` war nur fürs LAN nötig.
- **Alle App-Assets liegen in `app/ui/public/`** (`config.js`, `dictation-regex/`,
  `pcm-recorder-worklet.js`, `ort/`, `ffmpeg/`, Architektur-Diagramm) und landen
  automatisch im Build. Deploy = `dist/` hochladen.
- **STRATO-Fähigkeit geprüft**:
  - HTTPS via Let's Encrypt inklusive (Aktivierung im Kundenbereich) — Pflicht für Mikrofon
  - `.htaccess` mit `mod_headers` auf allen Tarifen → COOP/COEP umsetzbar
  - `AddType application/wasm` per `.htaccess` umsetzbar
  - Range-Requests nativ durch Apache/NGINX
  - SSH + SFTP (Port 22) in allen Paketen, **Public-Key-Auth** möglich
    (Public Key nach `.ssh/authorized_keys` hochladen)
  - Kein `rsync` auf dem Server verfügbar → Deploy via **tar-Archiv + SSH-Entpacken**
    (von STRATO selbst empfohlen, ~30× schneller als Einzeldateien)
- **Modell int4 (391 MB) wird mit gehostet** → App bleibt 100 % autonom.
- **Kein GitHub Actions**: Deploy-Skript läuft lokal auf dem Wyse, opencode führt
  es bei Bedarf aus. Zugangsdaten bleiben lokal (nichts im öffentlichen Repo).
- Die **LAN-Instanz (Wyse, Port 8787, systemd) bleibt unangetastet** und dient
  als Entwicklungs-/Fallback-Umgebung.

---

## Phase A — Vorbereitung im Repo (unabhängig vom STRATO-Konto, kann sofort starten)

| # | Schritt | Details |
|---|---------|---------|
| A1 | `scripts/deploy-strato.sh` | Build → tar.gz → SCP → SSH-Entpacken → Verifikation. Flags: `--with-models` (einmaliger 391-MB-Upload), `--no-auth` (Phase D) |
| A2 | `deploy.local.conf` (gitignored) | Vorlage mit Platzhaltern: STRATO-Host, SSH-Benutzer, Webroot. Zugangsdaten nie committen |
| A3 | `.htaccess` im Repo | COOP `same-origin`, COEP `require-corp`, `AddType application/wasm .wasm`, `Cache-Control: immutable` für `/models/`, HTTPS-Redirect (erst nach SSL-Aktivierung scharf). **Auth-Basic-Block als auskommentierte Vorlage** |
| A4 | SSH-Key-Paar generieren | `opencode-deploy@wyse`, ohne Passphrase, bleibt lokal auf dem Wyse |
| A5 | Impressum + Datenschutz als Platzhalter-Seiten | `public/impressum.html`, `public/datenschutz.html`. Inhalte: 100 % lokale Verarbeitung, keine Audio-/Text-Übertragung, Server-Logs durch STRATO, lokale Speicherung (IndexedDB), AGPL-Hinweis + Repo-Link. Pflichtangaben als `<!-- TODO -->`-Platzhalter. Verlinkung in der About-Seite ergänzen |
| A6 | Build-Test + Commit + push | — |

## Phase B — STRATO einrichten (wartet auf Nutzer-Aktionen)

1. **Nutzer**: Hosting Basic bestellen + Domain wählen *(Domain-Wunsch wird noch
   mitgeteilt — Verfügbarkeit vorher prüfen, z. B. `portabletranscribe.de`)*
2. **Nutzer** (Kundenbereich): SSL-Zertifikat aktivieren (kann Stunden dauern),
   Zugang vom Typ „SFTP + SSH" anlegen (Startverzeichnis = Webroot, minimal privilegiert)
3. **Einmalig manuell**: Nutzer gibt in einem Terminal (Befehl wird von opencode
   vorbereitet) das STRATO-Passwort ein → Public Key wandert nach `.ssh/authorized_keys`
4. Zugangsdaten in `deploy.local.conf` eintragen
5. **opencode**: erster Deploy **inkl. Modelle** (`--with-models`, 391 MB, Dauer
   abhängig vom Upstream) + `.htaccess`
6. **opencode: Verifikation**
   - `curl -I`: COOP/COEP-Header, Range-Requests (HTTP 206)
   - Headless-Chromium (`/home/hermes/.cache/ms-playwright/...`): `self.crossOriginIsolated === true` + Modell-Load-Smoke-Test
   - SSL aktiv (kein Zertifikatsfehler)

## Phase C — Passwortschutz (privat, wenn Zugangsdaten vergeben sind)

- **htpasswd + Auth-Block in `.htaccess`** statt STRATO-Kundenbereich-Tool
  (vollständig aus opencode skriptbar):
  - `htpasswd`-Datei lokal generieren, **außerhalb des Webroots** ablegen
  - Auth-Basic-Block in `.htaccess` scharf schalten, Deploy
  - Schützt App **und** `/models/` gleichermaßen
  - Same-origin-`fetch` sendet Basic-Auth-Header automatisch → Modell-Download funktioniert unverändert
- Zugangsdaten (Benutzername + Passwort) vergibt der **Nutzer** zu gegebener Zeit

## Phase D — Public-Gang (später, Entscheidung des Nutzers)

1. Deploy mit `--no-auth` (Auth-Block entfernt)
2. Platzhalter in Impressum/Datenschutz füllen (Nutzer liefert Name/Adresse)
3. AGPL-Konformität: Fork von `parakeet_web` (AGPL-3.0) — Quellcode-Verfügbarkeit
   durch öffentliches GitHub-Repo erfüllt; Repo-Link zusätzlich im Impressum/About
4. Normaler Deploy — fertig

---

## Deploy-Zyklus danach

> **„opencode, deploy nach STRATO"** → Skript baut, packt, lädt hoch, entpackt,
> verifiziert. `git push` ist davon entkoppelt. LAN-Instanz läuft parallel weiter.

## Notizen / Risiken

- Upload der 391 MB Modells via SFTP ist einmalig, aber langsam (Upstream des Wyse);
  ggf. von einem schnelleren Rechner aus einmalig hochladen
- STRATO erlaubt keine externen Domains — Domain muss über STRATO laufen
  (1 Inklusiv-Domain schon im Basic-Tarif)
- COEP `require-corp` blockt Cross-Origin-Ressourcen ohne CORS/CORP — alle
  Assets sind gebundelt, sollte sauber sein; notfalls `credentialless` als Ausweichoption
- `.htaccess` wird aus dem Repo deployt (eine Quelle der Wahrheit); falls später
  doch STRATO-Panel-Tools genutzt werden, diese nicht gleichzeitig einsetzen
