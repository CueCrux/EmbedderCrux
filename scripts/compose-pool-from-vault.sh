#!/usr/bin/env bash
# Starts the EmbedderCrux Pool Router with Tailscale OAuth credentials from Vault.
# Deploy on the same host as Engine (e.g. CueCrux-Data-1).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.pool}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

: "${VAULT_ADDR:?missing VAULT_ADDR}"
: "${VAULT_SECRET_PATH:=kv/app/embeddercrux/prod}"
: "${POOL_HOST_PORT:=8079}"
: "${POOL_HEALTH_WAIT_SECONDS:=15}"

if [[ "$VAULT_SECRET_PATH" != */* ]]; then
  echo "VAULT_SECRET_PATH must be <mount>/<path>, got: $VAULT_SECRET_PATH" >&2
  exit 1
fi

# ── Resolve Vault token ───────────────────────────────────────────────

if [[ -z "${VAULT_TOKEN:-}" ]]; then
  : "${VAULT_TOKEN_FILE:=${HOME}/.vault-token}"
  if [[ ! -f "$VAULT_TOKEN_FILE" ]]; then
    echo "missing VAULT_TOKEN and token file: $VAULT_TOKEN_FILE" >&2
    exit 1
  fi
  VAULT_TOKEN="$(tr -d '\r\n' < "$VAULT_TOKEN_FILE")"
fi

# ── Fetch Tailscale OAuth creds from Vault ────────────────────────────

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

# ── Start pool router ─────────────────────────────────────────────────

compose_with_secrets() {
  TS_CLIENT_ID="$ts_client_id" TS_CLIENT_SECRET="$ts_client_secret" \
    docker compose -f docker-compose.pool.yml "$@"
}

cd "$ROOT_DIR"

echo "[pool-router] starting pool router (port=${POOL_HOST_PORT})"
compose_with_secrets up -d --build

# Wait for pool router to become healthy
echo "[pool-router] waiting for health check..."
deadline=$((SECONDS + POOL_HEALTH_WAIT_SECONDS))
healthy=false
while (( SECONDS < deadline )); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${POOL_HOST_PORT}/healthz" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" == "true" ]]; then
  pool_status="$(curl -sS "http://127.0.0.1:${POOL_HOST_PORT}/pool/status" 2>/dev/null || echo '{}')"
  echo "[pool-router] healthy on :${POOL_HOST_PORT}"
  echo "[pool-router] pool status: ${pool_status}"
  exit 0
fi

echo "[pool-router] WARNING: pool router did not become healthy within ${POOL_HEALTH_WAIT_SECONDS}s" >&2
echo "[pool-router] this may be normal if no embedder backends are available yet" >&2
echo "[pool-router] check: curl http://127.0.0.1:${POOL_HOST_PORT}/pool/status" >&2
exit 0
