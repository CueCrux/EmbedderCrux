# Chainguard has no CUDA-runtime Python base (per CueCrux/CLAUDE.md §9 fallback rule).
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/data/hf \
    HUGGINGFACE_HUB_CACHE=/data/hf/hub \
    TRANSFORMERS_CACHE=/data/hf/transformers

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install -r /app/requirements.txt

COPY server.py /app/server.py

EXPOSE 8080

CMD ["python", "/app/server.py"]
