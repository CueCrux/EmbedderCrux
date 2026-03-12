#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

: "${VAULT_ADDR:?missing VAULT_ADDR}"
: "${VAULT_SECRET_PATH:=kv/app/embeddercrux/prod}"
: "${TEI_IMAGE_TAG:=cuda-1.9}"
: "${TEI_CPU_IMAGE_TAG:=cpu-1.9}"
: "${ALLOW_CPU_FALLBACK:=true}"
: "${TEI_HEALTH_TIMEOUT_SECONDS:=180}"
: "${EMBEDDER_HOST_PORT:=8080}"

if [[ "$VAULT_SECRET_PATH" != */* ]]; then
  echo "VAULT_SECRET_PATH must be <mount>/<path>, got: $VAULT_SECRET_PATH" >&2
  exit 1
fi

if [[ -z "${VAULT_TOKEN:-}" ]]; then
  : "${VAULT_TOKEN_FILE:=${HOME}/.vault-token}"
  if [[ ! -f "$VAULT_TOKEN_FILE" ]]; then
    echo "missing VAULT_TOKEN and token file: $VAULT_TOKEN_FILE" >&2
    exit 1
  fi
  VAULT_TOKEN="$(tr -d '\r\n' < "$VAULT_TOKEN_FILE")"
fi

kv_mount="${VAULT_SECRET_PATH%%/*}"
kv_path="${VAULT_SECRET_PATH#*/}"
api_url="${VAULT_ADDR%/}/v1/${kv_mount}/data/${kv_path}"

curl_opts=(-fsS)
if [[ "${VAULT_SKIP_VERIFY:-}" == "true" || "${VAULT_SKIP_VERIFY:-}" == "1" ]]; then
  curl_opts+=(-k)
fi

headers=(-H "X-Vault-Token: ${VAULT_TOKEN}")
if [[ -n "${VAULT_NAMESPACE:-}" ]]; then
  headers+=(-H "X-Vault-Namespace: ${VAULT_NAMESPACE}")
fi

payload="$(curl "${curl_opts[@]}" "${headers[@]}" "$api_url")"
ts_client_id="$(echo "$payload" | jq -er '.data.data.ts_client_id')"
ts_client_secret="$(echo "$payload" | jq -er '.data.data.ts_client_secret')"

if [[ -z "$ts_client_id" || -z "$ts_client_secret" ]]; then
  echo "vault secret at $VAULT_SECRET_PATH is missing ts_client_id or ts_client_secret" >&2
  exit 1
fi

is_true() {
  local value
  value="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [[ "$value" == "1" || "$value" == "true" || "$value" == "yes" || "$value" == "on" ]]
}

compose_with_secrets() {
  TS_CLIENT_ID="$ts_client_id" TS_CLIENT_SECRET="$ts_client_secret" docker compose "$@"
}

wait_for_tei_health() {
  local timeout_seconds="$1"
  local health_url="http://127.0.0.1:${EMBEDDER_HOST_PORT}/health"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 2 "$health_url" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cd "$ROOT_DIR"

# Ensure stale CPU fallback is never left active when attempting GPU startup.
compose_with_secrets --profile cpu-fallback rm -sf tei-cpu >/dev/null 2>&1 || true
compose_with_secrets rm -sf gateway >/dev/null 2>&1 || true

echo "[embeddercrux] starting GPU TEI (tag=${TEI_IMAGE_TAG})"
gpu_up_ok=true
if (( $# > 0 )); then
  if ! TEI_BACKEND_SERVICE=tei compose_with_secrets up -d "$@" gateway; then
    gpu_up_ok=false
  fi
else
  if ! TEI_BACKEND_SERVICE=tei compose_with_secrets up -d tailscale tei gateway; then
    gpu_up_ok=false
  fi
fi

if [[ "$gpu_up_ok" == "true" ]] && wait_for_tei_health "${TEI_HEALTH_TIMEOUT_SECONDS}"; then
  compose_with_secrets --profile cpu-fallback rm -sf tei-cpu >/dev/null 2>&1 || true
  running_image="$(docker inspect --format '{{.Config.Image}}' embedder-tei 2>/dev/null || true)"
  echo "[embeddercrux] GPU TEI healthy on :${EMBEDDER_HOST_PORT} (image=${running_image:-unknown}). CPU fallback disabled."
  exit 0
fi

if [[ "$gpu_up_ok" == "false" ]]; then
  echo "[embeddercrux] GPU TEI failed to start."
else
  echo "[embeddercrux] GPU TEI did not become healthy within ${TEI_HEALTH_TIMEOUT_SECONDS}s."
fi
if ! is_true "${ALLOW_CPU_FALLBACK}"; then
  echo "[embeddercrux] CPU fallback disabled (ALLOW_CPU_FALLBACK=${ALLOW_CPU_FALLBACK})." >&2
  exit 1
fi

echo "[embeddercrux] switching to CPU fallback (tag=${TEI_CPU_IMAGE_TAG})"
compose_with_secrets rm -sf tei >/dev/null 2>&1 || true
TEI_CPU_IMAGE_TAG="$TEI_CPU_IMAGE_TAG" TEI_BACKEND_SERVICE=tei-cpu compose_with_secrets --profile cpu-fallback up -d tailscale tei-cpu gateway

if wait_for_tei_health "${TEI_HEALTH_TIMEOUT_SECONDS}"; then
  running_image="$(docker inspect --format '{{.Config.Image}}' embedder-tei-cpu 2>/dev/null || true)"
  echo "[embeddercrux] CPU fallback TEI healthy on :${EMBEDDER_HOST_PORT} (image=${running_image:-unknown})."
  exit 0
fi

echo "[embeddercrux] CPU fallback also failed health check." >&2
exit 1
