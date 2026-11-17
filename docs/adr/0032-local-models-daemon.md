# ADR 32: Local models: a detached daemon over llama-server's router mode

Status: accepted

## Context

We want local models without making users operate llama-server by hand.

## Decision

Engine: llama-server router mode (`--models-preset` INI we generate, `--models-max`) behind an `Engine` interface. A detached daemon (`chattree models serve`) owns the host; sessions find it, start it if needed and never stop it. Sampling comes from settings, else the model's own metadata, passed as server defaults and copied into the thread's agent setup so history records what was used. The model id in history is `name@hash8` (first 8 hex digits of the GGUF's SHA-256). Installing a downloaded binary is a consent step (tag, URL, size, hash); hashes are recorded on first fetch in a lock file and checked at every start. No implicit "latest".

## Why

Chosen after a spike: one binary, per-model status and arguments visible, SSE state changes, LRU eviction, per-model idle sleep. A changed file under the same name shows as a model change.

## Notes

llama-swap can be a second engine later.
