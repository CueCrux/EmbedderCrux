# EmbedderCrux
EmbedderCrux is a self-contained Docker appliance that turns any NVIDIA GPU into a private embedding endpoint on your Tailscale network. It pairs HuggingFace Text Embeddings Inference with a Tailscale sidecar so your infrastructure can call it like any internal service — no public ports, no API keys to rotate, no vendor lock-in.
Built to power the embedding pipeline for VaultCrux, but useful for anyone who wants fast, private, provider-independent embeddings without sending their data to a third-party API.
