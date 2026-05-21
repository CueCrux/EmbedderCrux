# Builder: install spaCy + download model on a Debian-slim base so pre-built
# wheels for thinc/blis land cleanly. Chainguard python:latest-dev failed
# because its Python version had no pre-built wheels for spacy's native deps.
FROM python:3.12-slim AS builder

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python -m venv /venv \
 && /venv/bin/pip install --no-cache-dir -r requirements.txt \
 && /venv/bin/python -m spacy download en_core_web_sm

FROM python:3.12-slim

WORKDIR /app
COPY --from=builder /venv /venv
COPY server.py ./

ENV PATH="/venv/bin:$PATH" \
    NER_MODEL=en_core_web_sm \
    NER_PORT=8091 \
    NER_HOST=0.0.0.0

EXPOSE 8091

ENTRYPOINT ["/venv/bin/python", "server.py"]
