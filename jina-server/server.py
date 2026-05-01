import os
import time
from typing import List, Literal, Optional, Union

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

_torch_dtype = {"float16": torch.float16, "bfloat16": torch.bfloat16, "float32": torch.float32}[DTYPE]

app = FastAPI(title="Jina v4 Embedder", version="0.1.0")
_model = None
_load_time_s: Optional[float] = None


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
    get_model()


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
    }


@app.get("/healthz")
def healthz():
    return health()


@app.post("/embed")
def embed(req: EmbedRequest):
    model = get_model()
    inputs = [req.inputs] if isinstance(req.inputs, str) else req.inputs
    if not inputs:
        raise HTTPException(400, "inputs is empty")

    snapped = snap_matryoshka(req.dim)
    with torch.inference_mode():
        embeddings = model.encode_text(
            texts=inputs,
            task=req.task,
            prompt_name=req.prompt_name,
            return_multivector=False,
            max_length=req.max_tokens,
            truncate_dim=snapped,
        )

    if isinstance(embeddings, list):
        embeddings = torch.stack([torch.as_tensor(e) for e in embeddings])
    elif not torch.is_tensor(embeddings):
        embeddings = torch.as_tensor(embeddings)
    if req.dim < snapped:
        embeddings = embeddings[..., : req.dim]
    if req.normalize:
        embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=-1)

    return embeddings.detach().to("cpu", dtype=torch.float32).tolist()


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
