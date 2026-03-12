# EmbedderCrux

GPU-accelerated embedding server in a box. HuggingFace TEI + a thin gateway + Tailscale mesh networking, single `docker compose up`.

EmbedderCrux is a self-contained Docker appliance that turns any NVIDIA GPU into a private embedding endpoint on your Tailscale network. It pairs HuggingFace Text Embeddings Inference (TEI) with a small HTTP gateway and a Tailscale sidecar so your infrastructure can call it like any internal service: no public ports, no API keys to rotate, no vendor lock-in.

Built to power the embedding pipeline for [VaultCrux](https://vaultcrux.com), but useful for anyone who wants fast, private, provider-independent embeddings without sending data to a third-party API.

The stack publishes the gateway locally (`127.0.0.1:8080` by default). `/embed` remains TEI-compatible. `/embed/sequence` is available for Engine late-chunking; by default it returns `501` so Engine can fall back to per-chunk embeddings unless sequence mode is explicitly enabled.

## Why This Exists

Hosted embedding APIs are convenient, but they bill per token and can deprecate models with little notice. Running embeddings locally is usually faster and removes per-token costs, yet securely exposing a GPU endpoint to remote infrastructure is where most teams get stuck. EmbedderCrux solves that network problem by combining TEI with Tailscale mesh networking, so your GPU appears as a private internal service on your tailnet.

## Prerequisites

- NVIDIA GPU with CUDA support
- NVIDIA Container Toolkit installed (`nvidia-ctk`)
- Docker Engine + Docker Compose v2
- Tailscale account (free tier works)
- HashiCorp Vault access to a KVv2 path
- `curl` + `jq` on the host (used by `scripts/compose-up-from-vault.sh`)

## Quick Start

1. Clone the repo:

   ```bash
   git clone https://github.com/CueCrux/EmbedderCrux.git
   cd EmbedderCrux
   ```

2. Create a Tailscale OAuth client: <https://login.tailscale.com/admin/settings/oauth>
   - Define `tag:embedder` in your ACL `tagOwners` first.
   - Create an OAuth client scoped for tag-based node auth.

3. Write OAuth creds to Vault KV:

   ```bash
   vault kv put kv/app/embeddercrux/prod \
     ts_client_id="your-client-id" \
     ts_client_secret="your-client-secret"
   ```

4. Create your runtime config:

   ```bash
   cp .env.example .env
   ```

5. Start the appliance:

   ```bash
   ./scripts/compose-up-from-vault.sh
   ```

   The launcher starts GPU TEI first and only falls back to CPU TEI if GPU startup/health fails.

6. Verify service health and embeddings:

   ```bash
   ./healthcheck.sh
   curl http://localhost:8080/embed \
     -X POST \
     -H 'Content-Type: application/json' \
     -d '{"inputs":["Hello world"]}'
   curl http://embedder:8080/embed \
     -X POST \
     -H 'Content-Type: application/json' \
     -d '{"inputs":["Hello world"]}'
   ```

## Configuration Reference

| Variable | Description | Default |
| --- | --- | --- |
| `TS_HOSTNAME` | Hostname shown for this node in Tailscale | `embedder` |
| `TS_TAG` | ACL tag name used for `--advertise-tags=tag:<value>` | `embedder` |
| `VAULT_ADDR` | Vault API address used by launcher script | `https://100.76.91.69:8200` |
| `VAULT_SKIP_VERIFY` | Set `true` to skip TLS verification when using self-signed certs | `true` |
| `VAULT_TOKEN_FILE` | File containing Vault token (used when `VAULT_TOKEN` is unset) | `${HOME}/.vault-token` |
| `VAULT_SECRET_PATH` | KVv2 path containing `ts_client_id` and `ts_client_secret` | `kv/app/embeddercrux/prod` |
| `MODEL_ID` | HuggingFace embedding model ID | `nomic-ai/nomic-embed-text-v1.5` |
| `TEI_IMAGE_TAG` | GPU TEI image variant for your accelerator architecture | `cuda-1.9` |
| `TEI_CPU_IMAGE_TAG` | CPU TEI image used only for fallback startup path | `cpu-1.9` |
| `ALLOW_CPU_FALLBACK` | If `true`, launcher switches to CPU TEI when GPU health fails | `true` |
| `TEI_HEALTH_TIMEOUT_SECONDS` | Health-check timeout before GPU is treated as failed startup | `300` |
| `MAX_BATCH_TOKENS` | TEI max tokens per dynamic batch | `16384` |
| `MAX_CLIENT_BATCH_SIZE` | Max input strings accepted per `/embed` request | `64` |
| `MAX_CONCURRENT_REQUESTS` | TEI max in-flight requests | `512` |
| `EMBEDDER_LOCAL_BIND` | Host/IP bind for optional local port publishing | `127.0.0.1` |
| `EMBEDDER_HOST_PORT` | Host port mapped to TEI `:8080` | `8080` |
| `EMBEDDER_SEQUENCE_MODE` | `/embed/sequence` mode: `disabled` or `synthetic` | `disabled` |
| `EMBEDDER_SEQUENCE_MAX_TOKENS` | Max tokens allowed for synthetic `/embed/sequence` | `384` |
| `EMBEDDER_TOKEN_BATCH_SIZE` | Batch size for synthetic token embedding calls | `64` |

## Tailscale ACL Policy

Use a least-privilege ACL so only infrastructure nodes can call the embedding endpoint:

```json
{
  "tagOwners": {
    "tag:embedder": ["autogroup:admin"],
    "tag:infra": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:infra"],
      "dst": ["tag:embedder:8080"]
    }
  ]
}
```

With this policy, only nodes tagged `tag:infra` can reach `tag:embedder` on port `8080`.

## Choosing Your TEI Image

| GPU Family | Examples | TEI Image Tag |
| --- | --- | --- |
| Broad CUDA default | Mixed/unknown modern NVIDIA fleets | `cuda-1.9` |
| Ada Lovelace | RTX 4000 Ada, RTX 4090, L4 | `89-1.9` |
| Ampere | A10G, A100, RTX 3090 | `86-1.9` (A10G / SM86) or `1.9` (A100 / SM80) |
| Blackwell / Hopper | RTX PRO 6000, B100, H100 | `cuda-1.9` |
| Turing | T4, RTX 2080 | `turing-1.9` |
| CPU (testing) | Any | `cpu-1.9` |

Compatibility note: older TEI examples often used `86-1.9` as the default for Ada and Ampere cards. This repo defaults to `cuda-1.9` for wider compatibility; if you want architecture-specific builds, set `TEI_IMAGE_TAG` explicitly (for example `89-1.9` or `86-1.9`).

CPU fallback note: CPU TEI is profile-gated and only activated by the launcher fallback path (or by explicitly starting `tei-cpu`). When GPU startup succeeds, the launcher removes any stale CPU fallback container.

## Running Multiple Instances

Run another node by cloning a second copy (or a separate checkout), then changing at least:

- `TS_HOSTNAME` (must be unique)
- `MODEL_ID` (optional, if you want a different embedding model)
- `VAULT_SECRET_PATH` (or credentials at that path) for that node identity

Then launch as normal with `./scripts/compose-up-from-vault.sh`. Each instance joins the tailnet as a separate tagged node.

## Calling the Endpoint

Gateway `/embed` request fields used most often:

- `inputs`: array of text strings
- `truncate`: optional boolean

Response shape: array of float arrays (one embedding vector per input string).

Gateway `/embed/sequence` request fields:

- `text`: one document window to embed
- `model`: optional model label echoed in the response

Response shape when enabled:

- `embedding` / `pooled_embedding`: pooled document vector
- `token_embeddings`: per-token vectors
- `token_offsets`: `{ start, end }` character offsets
- `tokens`: token strings

Fallback behaviour:

- default mode is `EMBEDDER_SEQUENCE_MODE=disabled`
- disabled or oversized requests return `501`
- Engine is expected to catch `404`/`501` and fall back to per-chunk embeddings

### curl

```bash
curl http://embedder:8080/embed \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"inputs":["first text","second text"],"truncate":true}'

curl http://embedder:8080/embed/sequence \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"text":"One document window for late chunking."}'
```

### Python

```python
import requests

payload = {
    "inputs": ["first text", "second text"],
    "truncate": True,
}

resp = requests.post("http://embedder:8080/embed", json=payload, timeout=30)
resp.raise_for_status()
vectors = resp.json()
print(f"received {len(vectors)} embeddings")
```

## Monitoring

- TEI metrics: `http://embedder:8080/metrics`
- TEI health: `http://embedder:8080/health`
- Tailscale status:

  ```bash
  docker exec embedder-ts tailscale status
  ```

## Troubleshooting

- **GPU not detected**
  - Run `nvidia-smi` on the host.
  - Confirm NVIDIA Container Toolkit is installed and configured.
  - Verify Docker can access GPU devices.
  - If GPU startup still fails, launcher can temporarily fall back to `TEI_CPU_IMAGE_TAG` when `ALLOW_CPU_FALLBACK=true`.
- **Tailscale not connecting**
  - Confirm Vault secret path contains valid `ts_client_id` and `ts_client_secret`.
  - Confirm `VAULT_ADDR`, `VAULT_TOKEN`/`VAULT_TOKEN_FILE`, and `VAULT_SECRET_PATH` are correct.
  - Confirm `tag:embedder` exists in ACL `tagOwners`.
  - Check logs: `docker logs embedder-ts`.
- **Slow first startup**
  - Expected on first boot while model weights download (about 500 MB for `nomic-embed-text-v1.5`).
  - Subsequent starts use the persisted `tei-data` volume.
- **Remote node gets connection refused**
  - Confirm ACL allows `tag:infra` (or your source tag) to `tag:embedder:8080`.
  - Confirm destination node is healthy (`./healthcheck.sh` and `docker ps`).

## Performance (Quick Reference)

| GPU | Est. Throughput (TEI) | 1M Tokens | Notes |
| --- | --- | --- | --- |
| RTX 4000 Ada (20 GB) | ~22,000 tok/s | ~45 sec | Single-slot, 130 W |
| RTX 4090 (24 GB) | ~35,000 tok/s | ~29 sec | Consumer, 450 W |
| A10G (24 GB) | ~33,000 tok/s | ~30 sec | Common cloud GPU |
| RTX PRO 6000 Blackwell (96 GB) | ~130,000+ tok/s | ~8 sec | Datacentre class |
| CPU only | ~500-1,000 tok/s | ~17-33 min | Testing only |

Throughput varies by model size, sequence length, and batching configuration. These estimates are for roughly 137M-parameter embedding models and default batch settings.

## License

MIT (see [LICENSE](./LICENSE)).

## Links

- [HuggingFace TEI documentation](https://huggingface.co/docs/text-embeddings-inference)
- [Tailscale Docker guide](https://tailscale.com/kb/1282/docker)
- [VaultCrux](https://vaultcrux.com)
