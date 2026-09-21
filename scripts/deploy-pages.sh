#!/usr/bin/env bash
# Deployment von portabletranscribe auf GitHub Pages (oeffentlich, nicht kommerziell).
#
#   ./scripts/deploy-pages.sh          # Build + Sync + Push
#
# Ziel: Root-Site-Repo <user>.github.io (Wurzelpfad!), damit die absoluten
# Pfade der App (/assets, /sw.js, /manifest.webmanifest, /ort ...) funktionieren.
# Das Modell wird NICHT mitdeployt: die App laedt es von HuggingFace (remote),
# der Service Worker haelt es offline im Cache. ffmpeg/ wird ausgelassen.
#
# Konfiguration (optional, aus deploy.local.conf im Repo-Root, gitignored):
#   PAGES_REPO=https://github.com/<user>/<user>.github.io.git
#   PAGES_DIR=$HOME/.cache/portabletranscribe-pages
#   PAGES_BRANCH=main
#   PAGES_MODEL_REPO=efederici/parakeet-tdt-0.6b-v3-onnx-int4
#   PAGES_MODEL_REVISION=main
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CONF="$REPO_ROOT/deploy.local.conf"
if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
fi

PAGES_REPO="${PAGES_REPO:-https://github.com/shareholderxxl/shareholderxxl.github.io.git}"
PAGES_DIR="${PAGES_DIR:-$HOME/.cache/portabletranscribe-pages}"
PAGES_BRANCH="${PAGES_BRANCH:-main}"
PAGES_MODEL_REPO="${PAGES_MODEL_REPO:-efederici/parakeet-tdt-0.6b-v3-onnx-int4}"
PAGES_MODEL_REVISION="${PAGES_MODEL_REVISION:-main}"
# Decoder aus dem optimierten Repo (in-graph lse/topk) -> schneller Decode.
PAGES_MODEL_DECODER_REPO="${PAGES_MODEL_DECODER_REPO:-Olicorne/parakeet-tdt-0.6b-v3-optimized-onnx}"
PAGES_MODEL_DECODER_SUBFOLDER="${PAGES_MODEL_DECODER_SUBFOLDER:-int8}"
PAGES_MODEL_DECODER_FILE="${PAGES_MODEL_DECODER_FILE:-decoder_joint-model.int8.onnx}"

DIST="$REPO_ROOT/app/ui/dist"
PAGES_URL="https://$(basename "$PAGES_REPO" .git)/"

echo "== Build (app/ui) =="
( cd "$REPO_ROOT/app/ui" && npm run build )

echo "== Modellquelle auf 'remote' (HuggingFace) stellen =="
cat > "$DIST/config.js" <<EOF
window.__CONFIG__ = {
  VITE_MODEL_SOURCE: 'remote',
  VITE_MODEL_REPO: '${PAGES_MODEL_REPO}',
  VITE_MODEL_REVISION: '${PAGES_MODEL_REVISION}',
  VITE_MODEL_DECODER_REPO: '${PAGES_MODEL_DECODER_REPO}',
  VITE_MODEL_DECODER_SUBFOLDER: '${PAGES_MODEL_DECODER_SUBFOLDER}',
  VITE_MODEL_DECODER_FILE: '${PAGES_MODEL_DECODER_FILE}',
};
EOF

# Jekyll aus: sonst ignoriert/transformiert GitHub Pages Dateien (z. B. .well-known).
touch "$DIST/.nojekyll"

echo "== Pages-Repo bereitstellen: $PAGES_DIR =="
if [ ! -d "$PAGES_DIR/.git" ]; then
  mkdir -p "$(dirname "$PAGES_DIR")"
  git clone "$PAGES_REPO" "$PAGES_DIR" 2>/dev/null || {
    echo "Clone fehlgeschlagen (leeres Repo?) – initialisiere lokal und setze Remote."
    mkdir -p "$PAGES_DIR" && git -C "$PAGES_DIR" init -q -b "$PAGES_BRANCH"
    git -C "$PAGES_DIR" remote add origin "$PAGES_REPO"
  }
fi
git -C "$PAGES_DIR" checkout "$PAGES_BRANCH" -q 2>/dev/null || git -C "$PAGES_DIR" checkout -b "$PAGES_BRANCH" -q
git -C "$PAGES_DIR" pull --ff-only -q 2>/dev/null || true

echo "== Sync dist -> Pages-Repo (ohne ffmpeg/) =="
# rsync ist nicht ueberall vorhanden; tar + vorheriges Leeren ist gleichwertig.
find "$PAGES_DIR" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
tar -C "$DIST" --exclude='./ffmpeg' -cf - . | tar -C "$PAGES_DIR" -xf -

cd "$PAGES_DIR"
# Git-Identitaet im Pages-Repo sicherstellen (das Hauptrepo hat sie lokal).
if ! git config user.email >/dev/null 2>&1; then
  git config user.name  "$(git -C "$REPO_ROOT" config user.name  || echo 'portabletranscribe')"
  git config user.email "$(git -C "$REPO_ROOT" config user.email || echo 'noreply@example.com')"
fi
if [ -z "$(git status --porcelain)" ]; then
  echo "Keine Aenderungen – nichts zu committen."
else
  git add -A
  git commit -q -m "Deploy portabletranscribe $(date -u +%Y-%m-%dT%H:%MZ)"
  git push origin "$PAGES_BRANCH"
fi

echo "== Fertig =="
echo "URL: ${PAGES_URL}"
echo "Hinweis: GitHub Pages braucht nach dem ersten Push ggf. ~1 Minute;"
echo "         aktivieren mit: gh api -X POST repos/<user>/<user>.github.io/pages \\"
echo "           -f 'source[branch]=${PAGES_BRANCH}' -f 'source[path]=/'"
