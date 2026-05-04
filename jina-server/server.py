import json
import os
import threading
import time
import uuid
from concurrent.futures import Future
from typing import Any, Dict, List, Literal, Optional, Tuple, Union

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModel

MODEL_ID = os.environ.get("JINA_MODEL_ID", "jinaai/jina-embeddings-v4")
DEFAULT_TASK = os.environ.get("JINA_DEFAULT_TASK", "retrieval")
DEFAULT_DIM = int(os.environ.get("JINA_DEFAULT_DIM", "2048"))
DEFAULT_MAX_TOKENS = int(os.environ.get("JINA_MAX_TOKENS", "512"))
MATRYOSHKA_DIMS = (128, 256, 512, 1024, 2048)


def snap_matryoshka(dim: int) -> int:
    for step in MATRYOSHKA_DIMS:
        if step >= dim:
            return step
    return MATRYOSHKA_DIMS[-1]
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
DTYPE = os.environ.get("JINA_DTYPE", "float16")
DEVICE = os.environ.get("JINA_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")

# M3 (jina-embedder-serialization-fix-2026-05-03.md) — dynamic batching knobs.
# When `JINA_DYN_BATCH=true` (default), `/embed` routes through `DynamicBatcher`
# which coalesces concurrent HTTP requests into one GPU forward pass. The
# existing per-process GPU lock stays in place inside the batcher (so VRAM
# safety is preserved); only the batching primitive in front of it changes.
DYN_BATCH = os.environ.get("JINA_DYN_BATCH", "true").lower() != "false"
DYN_BATCH_MAX_SIZE = int(os.environ.get("JINA_DYN_BATCH_MAX_SIZE", "128"))
DYN_BATCH_MAX_WAIT_MS = int(os.environ.get("JINA_DYN_BATCH_MAX_WAIT_MS", "20"))
DYN_BATCH_REQ_TIMEOUT_S = int(os.environ.get("JINA_DYN_BATCH_REQ_TIMEOUT_S", "120"))
TIMING_LOG = os.environ.get("JINA_TIMING_LOG", "true").lower() != "false"

_torch_dtype = {"float16": torch.float16, "bfloat16": torch.bfloat16, "float32": torch.float32}[DTYPE]

app = FastAPI(title="Jina v4 Embedder", version="0.2.0")
_model = None
_gpu_lock = threading.Lock()
_load_time_s: Optional[float] = None
_batcher: Optional["DynamicBatcher"] = None
_batch_metrics = {
    "batches_flushed": 0,
    "items_processed": 0,
    "max_batch_size_seen": 0,
    "errors": 0,
}
_batch_metrics_lock = threading.Lock()


def get_model():
    global _model, _load_time_s
    if _model is None:
        t0 = time.time()
        _model = AutoModel.from_pretrained(
            MODEL_ID,
            trust_remote_code=True,
            torch_dtype=_torch_dtype,
        ).to(DEVICE).eval()
        _load_time_s = time.time() - t0
    return _model


# ── M3: DynamicBatcher ──────────────────────────────────────────────────────


class DynamicBatcher:
    """Cross-request batching shim. Collects pending /embed requests for up to
    ``max_wait_ms`` (or until ``max_batch_size`` items are queued), then runs
    one GPU forward pass for the whole batch (still gated by the existing
    `_gpu_lock` for VRAM safety) and demuxes results back to each caller.

    Requests are grouped by (task, prompt_name, max_tokens, snapped_dim) so
    a single forward serves only requests whose model parameters match. The
    common case — corecruxd's seal-time `build_ccxe_companion` — uses a single
    parameter shape, so all in-flight requests collapse into one group.
    """

    def __init__(self, max_batch_size: int = 128, max_wait_ms: int = 20):
        self.max_batch_size = max_batch_size
        self.max_wait_ms = max_wait_ms
        self._queue: List[Tuple[List[str], Dict[str, Any], Future]] = []
        self._lock = threading.Lock()
        self._flush_event = threading.Event()
        self._stop = threading.Event()
        self._worker = threading.Thread(target=self._run, daemon=True, name="DynamicBatcher")
        self._worker.start()

    def submit(self, inputs: List[str], params: Dict[str, Any]) -> Future:
        fut: Future = Future()
        with self._lock:
            self._queue.append((inputs, params, fut))
            total = sum(len(i) for i, _, _ in self._queue)
            if total >= self.max_batch_size:
                self._flush_event.set()
        return fut

    def queue_depth(self) -> int:
        with self._lock:
            return sum(len(i) for i, _, _ in self._queue)

    def _run(self) -> None:
        while not self._stop.is_set():
            triggered = self._flush_event.wait(timeout=self.max_wait_ms / 1000.0)
            with self._lock:
                if not self._queue:
                    self._flush_event.clear()
                    continue
                batch = self._queue
                self._queue = []
                self._flush_event.clear()
            self._process_batch(batch, triggered_by_size=triggered)

    def _process_batch(
        self,
        batch: List[Tuple[List[str], Dict[str, Any], Future]],
        triggered_by_size: bool,
    ) -> None:
        # Group by encode params so a single forward serves matching requests.
        groups: Dict[Tuple[str, str, int, int], List[Tuple[List[str], Dict[str, Any], Future]]] = {}
        for inputs, params, fut in batch:
            key = (
                params["task"],
                params["prompt_name"],
                int(params["max_tokens"]),
                int(snap_matryoshka(int(params["dim"]))),
            )
            groups.setdefault(key, []).append((inputs, params, fut))

        for key, items in groups.items():
            task, prompt_name, max_tokens, snapped_dim = key
            all_inputs: List[str] = []
            lengths: List[int] = []
            futures: List[Future] = []
            params_list: List[Dict[str, Any]] = []
            for inputs, params, fut in items:
                all_inputs.extend(inputs)
                lengths.append(len(inputs))
                futures.append(fut)
                params_list.append(params)

            try:
                t0 = time.perf_counter()
                model = get_model()
                SUB_BATCH = int(os.environ.get("JINA_SUB_BATCH", "8"))
                parts = []
                with _gpu_lock, torch.inference_mode():
                    for i in range(0, len(all_inputs), SUB_BATCH):
                        chunk = all_inputs[i : i + SUB_BATCH]
                        # batch_size: Jina v4's encode_text default is 8 (the
                        # internal forward-pass mini-batch). At the dim+VRAM
                        # we run, 32-64 fits and is ~4-8× faster.
                        out = model.encode_text(
                            texts=chunk,
                            task=task,
                            prompt_name=prompt_name,
                            return_multivector=False,
                            max_length=max_tokens,
                            truncate_dim=snapped_dim,
                            batch_size=SUB_BATCH,
                        )
                        if isinstance(out, list):
                            out = torch.stack([torch.as_tensor(e) for e in out])
                        elif not torch.is_tensor(out):
                            out = torch.as_tensor(out)
                        parts.append(out.detach().to("cpu"))
                        torch.cuda.empty_cache()
                embeddings = torch.cat(parts, dim=0) if len(parts) > 1 else parts[0]
                forward_ms = (time.perf_counter() - t0) * 1000

                # Demux per-request
                offset = 0
                for n, fut, params in zip(lengths, futures, params_list):
                    req_emb = embeddings[offset : offset + n]
                    offset += n
                    if int(params["dim"]) < snapped_dim:
                        req_emb = req_emb[..., : int(params["dim"])]
                    if params.get("normalize", True):
                        req_emb = torch.nn.functional.normalize(req_emb, p=2, dim=-1)
                    result = req_emb.detach().to("cpu", dtype=torch.float32).tolist()
                    if not fut.done():
                        fut.set_result(result)

                with _batch_metrics_lock:
                    _batch_metrics["batches_flushed"] += 1
                    _batch_metrics["items_processed"] += len(all_inputs)
                    if len(all_inputs) > _batch_metrics["max_batch_size_seen"]:
                        _batch_metrics["max_batch_size_seen"] = len(all_inputs)

                if TIMING_LOG:
                    print(
                        json.dumps(
                            {
                                "evt": "batch_flushed",
                                "n_requests": len(items),
                                "n_inputs_total": len(all_inputs),
                                "snapped_dim": snapped_dim,
                                "task": task,
                                "prompt_name": prompt_name,
                                "max_tokens": max_tokens,
                                "forward_ms": round(forward_ms, 2),
                                "trigger": "size" if triggered_by_size else "timer",
                            }
                        ),
                        flush=True,
                    )
            except Exception as e:
                with _batch_metrics_lock:
                    _batch_metrics["errors"] += 1
                for fut in futures:
                    if not fut.done():
                        fut.set_exception(e)


# ── pydantic models (unchanged) ─────────────────────────────────────────────


class EmbedRequest(BaseModel):
    inputs: Union[str, List[str]]
    task: Literal["retrieval", "text-matching", "code"] = Field(default=DEFAULT_TASK)
    prompt_name: Literal["query", "passage"] = Field(default="passage")
    dim: int = Field(default=DEFAULT_DIM, ge=128, le=2048)
    max_tokens: int = Field(default=DEFAULT_MAX_TOKENS, ge=8, le=32768)
    normalize: bool = True


class MultiVectorRequest(BaseModel):
    inputs: Union[str, List[str]]
    task: Literal["retrieval", "text-matching", "code"] = Field(default=DEFAULT_TASK)
    prompt_name: Literal["query", "passage"] = Field(default="passage")
    dim: int = Field(default=128, ge=64, le=2048)
    max_tokens: int = Field(default=512, ge=8, le=32768)


@app.on_event("startup")
def _warmup():
    global _batcher
    get_model()
    if DYN_BATCH:
        _batcher = DynamicBatcher(
            max_batch_size=DYN_BATCH_MAX_SIZE,
            max_wait_ms=DYN_BATCH_MAX_WAIT_MS,
        )
        print(
            json.dumps(
                {
                    "evt": "dyn_batcher_started",
                    "max_batch_size": DYN_BATCH_MAX_SIZE,
                    "max_wait_ms": DYN_BATCH_MAX_WAIT_MS,
                    "request_timeout_s": DYN_BATCH_REQ_TIMEOUT_S,
                }
            ),
            flush=True,
        )


@app.get("/health")
def health():
    if _model is None:
        return {"ok": False, "loaded": False}
    return {
        "ok": True,
        "loaded": True,
        "model": MODEL_ID,
        "device": DEVICE,
        "dtype": DTYPE,
        "load_time_s": _load_time_s,
        "dyn_batch": DYN_BATCH,
        "dyn_batch_max_size": DYN_BATCH_MAX_SIZE if DYN_BATCH else None,
        "dyn_batch_max_wait_ms": DYN_BATCH_MAX_WAIT_MS if DYN_BATCH else None,
        "queue_depth": _batcher.queue_depth() if _batcher is not None else 0,
        "metrics": dict(_batch_metrics),
    }


@app.get("/healthz")
def healthz():
    return health()


def _run_embed_direct(req: EmbedRequest) -> List[Any]:
    """Fallback path when DYN_BATCH is disabled — original lock-then-encode."""
    model = get_model()
    inputs = [req.inputs] if isinstance(req.inputs, str) else req.inputs
    if not inputs:
        raise HTTPException(400, "inputs is empty")

    snapped = snap_matryoshka(req.dim)
    SUB_BATCH = int(os.environ.get("JINA_SUB_BATCH", "8"))
    parts = []
    with _gpu_lock, torch.inference_mode():
        for i in range(0, len(inputs), SUB_BATCH):
            chunk = inputs[i : i + SUB_BATCH]
            out = model.encode_text(
                texts=chunk,
                task=req.task,
                prompt_name=req.prompt_name,
                return_multivector=False,
                max_length=req.max_tokens,
                truncate_dim=snapped,
                batch_size=SUB_BATCH,
            )
            if isinstance(out, list):
                out = torch.stack([torch.as_tensor(e) for e in out])
            elif not torch.is_tensor(out):
                out = torch.as_tensor(out)
            parts.append(out.detach().to("cpu"))
            torch.cuda.empty_cache()
    embeddings = torch.cat(parts, dim=0) if len(parts) > 1 else parts[0]
    if req.dim < snapped:
        embeddings = embeddings[..., : req.dim]
    if req.normalize:
        embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=-1)
    return embeddings.detach().to("cpu", dtype=torch.float32).tolist()


@app.post("/embed")
def embed(req: EmbedRequest):
    req_id = uuid.uuid4().hex[:8]
    t_received = time.perf_counter()
    inputs = [req.inputs] if isinstance(req.inputs, str) else req.inputs
    if not inputs:
        raise HTTPException(400, "inputs is empty")

    if _batcher is None:
        # Fallback: original direct path.
        result = _run_embed_direct(req)
        if TIMING_LOG:
            print(
                json.dumps(
                    {
                        "evt": "embed_timing_direct",
                        "req_id": req_id,
                        "n_inputs": len(inputs),
                        "t_total_ms": round((time.perf_counter() - t_received) * 1000, 2),
                    }
                ),
                flush=True,
            )
        return result

    fut = _batcher.submit(
        inputs,
        {
            "task": req.task,
            "prompt_name": req.prompt_name,
            "max_tokens": req.max_tokens,
            "dim": req.dim,
            "normalize": req.normalize,
        },
    )
    try:
        result = fut.result(timeout=DYN_BATCH_REQ_TIMEOUT_S)
    except Exception as e:
        raise HTTPException(503, f"batcher error: {e}")
    t_done = time.perf_counter()
    if TIMING_LOG:
        print(
            json.dumps(
                {
                    "evt": "embed_timing_batched",
                    "req_id": req_id,
                    "n_inputs": len(inputs),
                    "t_total_ms": round((t_done - t_received) * 1000, 2),
                }
            ),
            flush=True,
        )
    return result


@app.post("/embed/multi_vector")
def embed_multi_vector(req: MultiVectorRequest):
    model = get_model()
    inputs = [req.inputs] if isinstance(req.inputs, str) else req.inputs
    if not inputs:
        raise HTTPException(400, "inputs is empty")

    snapped = snap_matryoshka(req.dim)
    with torch.inference_mode():
        token_embeddings = model.encode_text(
            texts=inputs,
            task=req.task,
            prompt_name=req.prompt_name,
            return_multivector=True,
            max_length=req.max_tokens,
            truncate_dim=snapped,
        )

    out = []
    for vecs in token_embeddings:
        if not torch.is_tensor(vecs):
            vecs = torch.as_tensor(vecs)
        if req.dim < snapped:
            vecs = vecs[..., : req.dim]
        out.append(vecs.detach().to("cpu", dtype=torch.float32).tolist())
    return out


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
