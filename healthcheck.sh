#!/usr/bin/env bash
set -euo pipefail

if ! curl -sf http://localhost:8080/healthz >/dev/null; then
  echo "Embedder gateway health check failed: http://localhost:8080/healthz is unreachable."
  exit 1
fi

if ! docker exec embedder-ts tailscale status --json >/dev/null; then
  echo "Tailscale health check failed: could not read tailnet status from embedder-ts."
  exit 1
fi

echo "OK: gateway, backend, and Tailscale are healthy."
