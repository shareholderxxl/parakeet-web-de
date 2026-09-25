#!/usr/bin/env bash
# Deployment von portabletranscribe (reiner Static-Host) auf den VPS hinter Caddy.
#   ./scripts/deploy-vps.sh                  # Build + Sync, Modell unverändert lassen
#   ./scripts/deploy-vps.sh --with-models    # zusätzlich Modell von HuggingFace laden
#   ./scripts/deploy-vps.sh --no-auth        # Caddy-Site ohne Basic Auth schreiben
# Konfiguration: deploy.local.conf (Vorlage: deploy/deploy.local.conf.example)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CONF="$REPO_ROOT/deploy.local.conf"
if [ ! -f "$CONF" ]; then
  echo "FEHLT: $CONF (Vorlage: deploy/deploy.local.conf.example)" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$CONF"
: "${VPS_TARGET:?VPS_TARGET fehlt}" "${VPS_HOSTNAME:?VPS_HOSTNAME fehlt}" "${VPS_ROOT:?VPS_ROOT fehlt}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/doko_vps}"
MODEL_REPO="${MODEL_REPO:-efederici/parakeet-tdt-0.6b-v3-onnx-int4}"
MODEL_FILES="${MODEL_FILES:-config.json vocab.txt nemo128.int8.onnx decoder_joint-model.int8.onnx encoder-model.int4.onnx}"

WITH_MODELS=0
NO_AUTH=0
for arg in "$@"; do
  case "$arg" in
    --with-models) WITH_MODELS=1 ;;
    --no-auth) NO_AUTH=1 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "$SSH_KEY")
SSH=(ssh "${SSH_OPTS[@]}" "$VPS_TARGET")
SCP=(scp "${SSH_OPTS[@]}")

echo "== Build (app/ui) =="
( cd "$REPO_ROOT/app/ui" && npm ci --no-audit --no-fund && npm run build )

echo "== Sync dist nach $VPS_TARGET:$VPS_ROOT (models/ bleibt) =="
# models/ (Parakeet) UND models-canary/ (Canary 180M, eigener Mirror) ueberleben
# den Sync — beide werden nicht mitdeployt und muessten sonst (~213/391 MB) neu
# hochgeladen werden.
"${SSH[@]}" "mkdir -p '$VPS_ROOT' && find '$VPS_ROOT' -mindepth 1 -maxdepth 1 ! -name models ! -name models-canary -exec rm -rf {} +"
tar -C "$REPO_ROOT/app/ui/dist" -czf - . | "${SSH[@]}" "tar -xzf - -C '$VPS_ROOT'"

if [ "$WITH_MODELS" = 1 ]; then
  echo "== Modell laden (int4: $MODEL_REPO; int8: $MODEL_EXTRA) =="
  "${SSH[@]}" "VPS_ROOT='$VPS_ROOT' MODEL_REPO='$MODEL_REPO' MODEL_FILES='$MODEL_FILES' MODEL_EXTRA='$MODEL_EXTRA' bash -s" <<'REMOTE'
set -euo pipefail
mkdir -p "$VPS_ROOT/models"
cd "$VPS_ROOT/models"

# Laedt eine Datei nur, wenn sie fehlt oder die Groesse von HuggingFace nicht passt.
download() { # $1=repo  $2=pfad  $3=zielname
  url="https://huggingface.co/$1/resolve/main/$2"
  want="$(curl -fsIL "$url" | awk 'tolower($1)=="content-length:"{v=$2} END{gsub(/\r/,"",v); print v}')"
  have=0; [ -f "$3" ] && have="$(stat -c%s "$3")"
  if [ -n "$want" ] && [ "$want" = "$have" ]; then
    echo "-> $3 vorhanden ($have Bytes, passt)"
    return 0
  fi
  echo "-> $3 laden ($want Bytes)"
  curl -fL --retry 3 --retry-delay 2 -C - -sS -o "$3" "$url"
}

for f in $MODEL_FILES; do download "$MODEL_REPO" "$f" "$f"; done
for e in ${MODEL_EXTRA:-}; do
  download "$(printf '%s' "$e" | cut -d'|' -f1)" "$(printf '%s' "$e" | cut -d'|' -f2)" "$(printf '%s' "$e" | cut -d'|' -f3)"
done

# zstd-Sidecars fuer grosse Gewichte (>500 MB) - Caddy liefert sie via precompressed.
for f in "$VPS_ROOT"/models/*.onnx; do
  [ -e "$f" ] || continue
  sz="$(stat -c%s "$f")"
  [ "$sz" -lt 500000000 ] && continue
  if [ ! -f "$f.zst" ] || [ "$f" -nt "$f.zst" ]; then
    if command -v zstd >/dev/null 2>&1; then
      echo "-> zstd -9 $(basename "$f")"
      zstd -q -9 -f -o "$f.zst" "$f"
    else
      echo "WARNUNG: zstd fehlt - $f bleibt unkomprimiert"
    fi
  fi
done
ls -la
REMOTE
fi

echo "== Zugangsschutz =="
PW_FILE="$HOME/.transcribe-password"
AUTH_USER=transcribe
AUTH_HASH=""
if [ "$NO_AUTH" = 1 ]; then
  echo '(ohne Basic Auth)'
else
  if [ ! -s "$PW_FILE" ]; then
    umask 077
    openssl rand -base64 24 | tr -d '/+=' | cut -c1-20 > "$PW_FILE"
    chmod 600 "$PW_FILE"
    echo "Neues Passwort erzeugt: $PW_FILE"
  fi
  AUTH_PW="$(cat "$PW_FILE")"
  AUTH_HASH="$(AUTH_PW="$AUTH_PW" python3 -c 'import bcrypt,os;print(bcrypt.hashpw(os.environ["AUTH_PW"].encode(), bcrypt.gensalt(rounds=12)).decode())')"
fi

echo "== Caddy-Site rendern =="
TMPDIR_LOCAL="$(mktemp -d)"
VPS_HOSTNAME="$VPS_HOSTNAME" VPS_ROOT="$VPS_ROOT" AUTH_USER="$AUTH_USER" AUTH_HASH="$AUTH_HASH" \
  TMPDIR_LOCAL="$TMPDIR_LOCAL" python3 - "$REPO_ROOT/deploy/caddy/portabletranscribe.caddy.tmpl" <<'PY'
import os, sys
tpl = open(sys.argv[1]).read()
auth_hash = os.environ.get('AUTH_HASH') or ''
auth_block = ''
if auth_hash:
    auth_block = "\tbasic_auth {\n\t\t%s %s\n\t}\n" % (os.environ.get('AUTH_USER') or 'transcribe', auth_hash)
site = (tpl.replace('{HOST}', os.environ['VPS_HOSTNAME'])
           .replace('{ROOT}', os.environ['VPS_ROOT'])
           .replace('{AUTH_BLOCK}', auth_block))
out = os.environ['TMPDIR_LOCAL']
open(out + '/portabletranscribe.caddy', 'w').write(site)
env = [
    "# portabletranscribe: Zugangsschutz + Pfade (erzeugt von scripts/deploy-vps.sh)",
    "TRANSCRIBE_AUTH_USER=" + (os.environ.get('AUTH_USER') or 'transcribe'),
    "TRANSCRIBE_AUTH_HASH=" + auth_hash,
    "TRANSCRIBE_HOST=" + os.environ['VPS_HOSTNAME'],
    "TRANSCRIBE_ROOT=" + os.environ['VPS_ROOT'],
    "",
]
open(out + '/portabletranscribe.env', 'w').write("\n".join(env))
PY

"${SSH[@]}" 'mkdir -p /etc/caddy/sites.d'
"${SCP[@]}" -q "$TMPDIR_LOCAL/portabletranscribe.caddy" "$VPS_TARGET:/etc/caddy/sites.d/portabletranscribe.caddy"
"${SCP[@]}" -q "$TMPDIR_LOCAL/portabletranscribe.env" "$VPS_TARGET:/etc/portabletranscribe.env"
rm -rf "$TMPDIR_LOCAL"

echo "== Caddy validieren + neu laden =="
"${SSH[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
chmod 600 /etc/portabletranscribe.env
chmod 644 /etc/caddy/sites.d/portabletranscribe.caddy
if ! grep -q 'sites.d' /etc/caddy/Caddyfile 2>/dev/null; then
  if [ -s /etc/caddy/Caddyfile ]; then cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"; fi
  printf '# Sammeldatei (Automatik). Sites liegen unter /etc/caddy/sites.d/*.caddy\nimport /etc/caddy/sites.d/*.caddy\n' > /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1
systemctl reload caddy
sleep 2
echo "Caddy: $(systemctl is-active caddy)"
REMOTE

echo "== Smoke-Test =="
curl -s -o /dev/null -w "  ohne Auth: %{http_code} (401 erwartet)\n" "https://$VPS_HOSTNAME/" || true
if [ -n "$AUTH_HASH" ]; then
  curl -s -o /dev/null -u "transcribe:$(cat "$PW_FILE")" -w "  mit Auth:  %{http_code} (200 erwartet)\n" "https://$VPS_HOSTNAME/" || true
fi
echo "Fertig. Spiel/App: https://$VPS_HOSTNAME/"
