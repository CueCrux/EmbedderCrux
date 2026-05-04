FROM cgr.dev/chainguard/python:latest-dev AS builder

USER root
WORKDIR /app

COPY requirements.txt .
RUN python -m venv /venv \
 && /venv/bin/pip install --no-cache-dir -r requirements.txt \
 && /venv/bin/python -m spacy download en_core_web_sm

FROM cgr.dev/chainguard/python:latest

USER root
WORKDIR /app

COPY --from=builder /venv /venv
COPY server.py ./

ENV PATH="/venv/bin:$PATH" \
    NER_MODEL=en_core_web_sm \
    NER_PORT=8091 \
    NER_HOST=0.0.0.0

EXPOSE 8091

ENTRYPOINT ["/venv/bin/python", "server.py"]
