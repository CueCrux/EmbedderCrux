#!/usr/bin/env bash
set -euo pipefail

if ! curl -sf http://localhost:8080/health >/dev/null; then
  echo "TEI health check failed: http://localhost:8080/health is unreachable."
  exit 1
fi

if ! docker exec embedder-ts tailscale status --json >/dev/null; then
  echo "Tailscale health check failed: could not read tailnet status from embedder-ts."
  exit 1
fi

echo "OK: TEI and Tailscale are healthy."
