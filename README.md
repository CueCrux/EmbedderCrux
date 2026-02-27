# EmbedderCrux

GPU-accelerated embedding server in a box. HuggingFace TEI + Tailscale mesh networking, single `docker compose up`.

EmbedderCrux is a self-contained Docker appliance that turns any NVIDIA GPU into a private embedding endpoint on your Tailscale network. It pairs HuggingFace Text Embeddings Inference (TEI) with a Tailscale sidecar so your infrastructure can call it like any internal service: no public ports, no API keys to rotate, no vendor lock-in.

Built to power the embedding pipeline for [VaultCrux](https://vaultcrux.com), but useful for anyone who wants fast, private, provider-independent embeddings without sending data to a third-party API.

## Why This Exists

Hosted embedding APIs are convenient, but they bill per token and can deprecate models with little notice. Running embeddings locally is usually faster and removes per-token costs, yet securely exposing a GPU endpoint to remote infrastructure is where most teams get stuck. EmbedderCrux solves that network problem by combining TEI with Tailscale mesh networking, so your GPU appears as a private internal service on your tailnet.

## Prerequisites

- NVIDIA GPU with CUDA support
- NVIDIA Container Toolkit installed (`nvidia-ctk`)
- Docker Engine + Docker Compose v2
- Tailscale account (free tier works)

## Quick Start

1. Clone the repo:

   ```bash
   git clone https://github.com/CueCrux/EmbedderCrux.git
   cd EmbedderCrux
   ```

2. Create a Tailscale OAuth client: <https://login.tailscale.com/admin/settings/oauth>
   - Define `tag:embedder` in your ACL `tagOwners` first.
   - Create an OAuth client scoped for tag-based node auth.

3. Create local secret files:

   ```bash
   mkdir -p secrets
   echo "your-client-id" > secrets/ts_client_id
   echo "your-client-secret" > secrets/ts_client_secret
   chmod 600 secrets/ts_client_id secrets/ts_client_secret
   ```

4. Create your runtime config:

   ```bash
   cp .env.example .env
   ```

5. Start the appliance:

   ```bash
   docker compose up -d
   ```

6. Verify service health and embeddings:

   ```bash
   ./healthcheck.sh
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
| `MODEL_ID` | HuggingFace embedding model ID | `nomic-ai/nomic-embed-text-v1.5` |
| `TEI_IMAGE_TAG` | TEI image variant for your GPU architecture | `89-1.9` |
| `MAX_BATCH_TOKENS` | TEI max tokens per dynamic batch | `16384` |
| `MAX_CONCURRENT_REQUESTS` | TEI max in-flight requests | `512` |

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
| Ada Lovelace | RTX 4000 Ada, RTX 4090, L4 | `89-1.9` |
| Ampere | A10G, A100, RTX 3090 | `86-1.9` (A10G / SM86) or `1.9` (A100 / SM80) |
| Blackwell / Hopper | RTX PRO 6000, B100, H100 | `cuda-1.9` |
| Turing | T4, RTX 2080 | `turing-1.9` |
| CPU (testing) | Any | `cpu-1.9` |

Compatibility note: older TEI examples often used `86-1.9` as the default for Ada and Ampere cards. This repo defaults to `89-1.9`; if your card needs SM86 builds, set `TEI_IMAGE_TAG=86-1.9` in `.env`.

## Running Multiple Instances

Run another node by cloning a second copy (or a separate checkout), then changing at least:

- `TS_HOSTNAME` (must be unique)
- `MODEL_ID` (optional, if you want a different embedding model)
- secret files (`secrets/ts_client_id`, `secrets/ts_client_secret`) for that node identity

Then launch as normal with `docker compose up -d`. Each instance joins the tailnet as a separate tagged node.

## Calling the Endpoint

TEI `/embed` request fields used most often:

- `inputs`: array of text strings
- `truncate`: optional boolean

Response shape: array of float arrays (one embedding vector per input string).

### curl

```bash
curl http://embedder:8080/embed \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"inputs":["first text","second text"],"truncate":true}'
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
- **Tailscale not connecting**
  - Confirm `secrets/ts_client_id` and `secrets/ts_client_secret` exist and are valid.
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
