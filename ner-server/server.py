"""Classical NER sidecar — non-LLM entity extraction at chunk-seal time.

Runs spaCy's `en_core_web_sm` (or a configurable model) over batches of
chunk text and returns entity spans + types + confidence. Same shape as
the SPLADE / BGE-M3 TEI sidecars: POST `/extract` with
`{"inputs": [text, ...]}` → list of `{"entities": [...]}` per input.

Operator constraint: no LLM. spaCy is CPU-only and runs at ~5-10K
chunks/sec at batch=64.

Endpoints:
  GET  /health       — readiness
  POST /extract      — batch entity extraction

ENV:
  NER_MODEL          (default "en_core_web_sm")
  NER_PORT           (default 8091)
  NER_HOST           (default 0.0.0.0)
  NER_KEEP_TYPES     (default "PERSON,ORG,GPE,LOC,PRODUCT,EVENT,WORK_OF_ART,FAC,DATE,TIME,MONEY")
                     comma-list of spaCy entity types to surface
  NER_MIN_LEN        (default 3) — drop entities shorter than this many chars
  NER_BATCH_SIZE     (default 64) — passed to spacy nlp.pipe
  NER_N_PROCESS      (default 1)  — spacy multi-process flag
"""
from __future__ import annotations

import os
import time
from typing import List

import spacy
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

MODEL = os.environ.get("NER_MODEL", "en_core_web_sm")
PORT = int(os.environ.get("NER_PORT", "8091"))
HOST = os.environ.get("NER_HOST", "0.0.0.0")
KEEP_TYPES = set(
    t.strip()
    for t in os.environ.get(
        "NER_KEEP_TYPES",
        "PERSON,ORG,GPE,LOC,PRODUCT,EVENT,WORK_OF_ART,FAC,DATE,TIME,MONEY",
    ).split(",")
    if t.strip()
)
MIN_LEN = int(os.environ.get("NER_MIN_LEN", "3"))
BATCH_SIZE = int(os.environ.get("NER_BATCH_SIZE", "64"))
N_PROCESS = int(os.environ.get("NER_N_PROCESS", "1"))


print(f"[ner-server] loading spaCy model: {MODEL}")
NLP = spacy.load(MODEL, disable=["parser", "lemmatizer"])
print(f"[ner-server] model loaded; pipeline={NLP.pipe_names}")
print(f"[ner-server] keep_types={sorted(KEEP_TYPES)} min_len={MIN_LEN}")

app = FastAPI(title="ner-server", version="0.1.0")


class ExtractRequest(BaseModel):
    inputs: List[str]


class EntityOut(BaseModel):
    text: str
    type: str
    start: int
    end: int
    confidence: float


class DocOut(BaseModel):
    entities: List[EntityOut]


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "keep_types": sorted(KEEP_TYPES)}


@app.post("/extract", response_model=List[DocOut])
def extract(req: ExtractRequest):
    """Extract entities from each input chunk.

    spaCy doesn't expose well-calibrated probabilities for the rule-based
    NER pipeline; we report a fixed heuristic confidence (0.7) to keep the
    schema stable. Downstream consumers can raise it for entities with
    type-specific evidence (e.g. dates parsed by a date-aware lane).
    """
    if not req.inputs:
        return []

    started = time.time()
    out: List[DocOut] = []
    # nlp.pipe is the fast path — avoids per-call setup, supports batching.
    for doc in NLP.pipe(req.inputs, batch_size=BATCH_SIZE, n_process=N_PROCESS):
        ents: List[EntityOut] = []
        for ent in doc.ents:
            if ent.label_ not in KEEP_TYPES:
                continue
            text = ent.text.strip()
            if len(text) < MIN_LEN:
                continue
            ents.append(
                EntityOut(
                    text=text,
                    type=ent.label_,
                    start=ent.start_char,
                    end=ent.end_char,
                    confidence=0.7,
                )
            )
        out.append(DocOut(entities=ents))

    wall_ms = int((time.time() - started) * 1000)
    if len(req.inputs) >= 16:
        print(
            f"[ner-server] extracted from {len(req.inputs)} inputs in {wall_ms} ms "
            f"(batch_size={BATCH_SIZE})"
        )
    return out


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
