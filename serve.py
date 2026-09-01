#!/usr/bin/env python3
"""
parakeet-web-de static server.

Liefert:
  - dist/              (Vite-Build des Frontends)
  - models/            (Olicorne-ONNX-Modell-Shards, via LOCAL_MODEL_PATH)
  - dictation-regex/   (deutsche Diktat-Regeln)

Features: Range-Requests (ONNX Runtime Web lädt Shards range-basiert),
korrekte MIME-Types, LAN-only Bindung (0.0.0.0:8787).

Start:  python3 serve.py
"""
import http.server
import os
import re
import ssl
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "app" / "ui" / "dist"
MODELS = Path(os.environ.get("LOCAL_MODEL_PATH", ROOT / "models")).resolve()
PORT = int(os.environ.get("PORT", 8787))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".onnx": "application/octet-stream",
    ".csv": "text/csv; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".mp3": "audio/mpeg",
    ".zst": "application/zstd",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def translate_path(self, path):
        # /models/*  ->  MODELS/*
        path = path.split("?", 1)[0].split("#", 1)[0]
        if path.startswith("/models/"):
            return str(MODELS / path[len("/models/"):])
        if path.startswith("/dictation-regex/"):
            return str(ROOT / "app" / "ui" / "public" / path[1:])
        if path.startswith("/config.js"):
            return str(DIST / "config.js")
        return super().translate_path(path)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext, "application/octet-stream")

    def end_headers(self):
        # COOP/COEP wie beim Original (SharedArrayBuffer für Worker-Threads)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    if not DIST.exists():
        print(f"FEHLER: {DIST} fehlt. Bitte zuerst in app/ui 'npm run build' ausführen.")
        sys.exit(1)

    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)

    # HTTPS (selbstsigniert): COOP/COEP braucht eine "trusted origin"
    # (localhost/HTTPS). Ohne HTTPS laufen die crossOriginIsolated-APIs
    # (SharedArrayBuffer für Worker-Threads) auf http://LAN-IP NICHT.
    cert = ROOT / "cert.pem"
    key = ROOT / "key.pem"
    if not (cert.exists() and key.exists()):
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", str(key),
             "-out", str(cert), "-days", "3650", "-nodes", "-subj", "/CN=parakeet-web-de"],
            check=False, capture_output=True,
        )
    if cert.exists() and key.exists():
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        print(f"parakeet-web-de (HTTPS): https://0.0.0.0:{PORT}/")
    else:
        print(f"WARNUNG: Kein Zertifikat (openssl fehlt?) - nur HTTP. COOP/COEP greifen NICHT.")
        print(f"parakeet-web-de (HTTP): http://0.0.0.0:{PORT}/")

    print(f"  UI:    {DIST}")
    print(f"  Model: {MODELS} ({'OK' if MODELS.exists() else 'FEHLT - hf download Olicorne/... --local-dir models'})")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
