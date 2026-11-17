# Local models

chattree can run models on your own machine through llama.cpp's `llama-server`. A background host starts the server, downloads models you name, and keeps the ones you use loaded. It is configured in the user settings file under `local_models`.

## The host

`chattree models start` starts a detached host that outlives your sessions; sessions find it, start it if needed, and never stop it. `chattree models stop` does. The first start offers to install llama.cpp: it shows the release tag, the download URL, the size and the hash, and installs only after you agree (`-y` agrees). Hashes are recorded on first fetch and checked at every start, so a binary that changes under you is noticed. There is no implicit "latest".

| Verb | Does |
|---|---|
| `start`, `restart`, `stop` | Control the host. |
| `status`, `logs` | What is running; the host's log. |
| `list`, `info <name>` | The models you configured; files, settings and the sampling a model will run with, and where each value came from. |
| `pull [name...]` | Download model files (`--force` fetches again). |
| `rm <name>`, `prune` | Delete a model's files; delete recorded files no configured model uses. |
| `update` | Look for a newer llama.cpp. |

## Configuring models

In the user settings file (`chattree settings edit`), under `local_models`:

```yaml
local_models:
  llama_cpp: { tag: b12110, backend: auto }     # the llama.cpp release to run; `chattree models update` picks the newest
  hf_token_env: HF_TOKEN                        # name of a variable holding a Hugging Face token, for repositories that need one
  server: { port: auto, models_max: 1 }         # how many models stay loaded at once (least recently used is evicted)
  defaults: { ctx_size: 16384 }                 # settings for every model
  models:
    qwen:
      hf: "Qwen/Qwen3-8B-GGUF:Q4_K_M"           # a Hugging Face repository and quantisation; or `url:` for a direct file
      ctx_size: 32768
      sampling: { temperature: 0.7, top_p: 0.8 }
```

A model gives exactly one of `hf` (with an optional `file` to name the exact file, and `revision`) or `url`. Optional keys include `sha256` (the file must match), `mmproj` (the projector for a vision model), `aliases`, `description`, `load_on_startup`, `chat_template` (a patched template file; a relative path is relative to the settings file), `tool_convention` (`full`, the default, or `flat` for a model that only copes with flat tool arguments), and the llama-server settings `ctx_size`, `n_gpu_layers`, `flash_attn`, `threads`, `parallel`, `jinja`, `cache_type_k`, `cache_type_v`, `sleep_idle_seconds` (unload after idling), `speculative` (speculative decoding; changes speed, not output), and `options` (any other llama-server option by its long name without dashes). `chattree models info <name>` shows what a model will run with.

## Using a model

Add a `local-models` provider to `harness.yml` and name a model from your settings. In the history a model is recorded as `name@hash8`, the first eight hex digits of its file's SHA-256, so a changed file under the same name shows up as a model change.

Sampling (temperature, top-p, and so on) comes from your settings, and where you give none, from the model's own metadata. It is copied into the thread's setup when the model is chosen, so the history records what was used.

## Prompt formats

Some models do better when chattree writes the prompt and reads the reply itself instead of using the server's chat template (reasoning between tool calls can decide whether a task succeeds). A thread can name a *dialect* for this in its model settings (`/set dialect gemma`; `harmony` and a Qwen format also exist, with `dialect_options` for tuning). `chattree init` pins `dialect: gemma` for Gemma models and replays reasoning for other local models. Changing the dialect changes the prompt the server sees, so it is a cache-breaking change and asks first. See [Dialects](../extending/dialects.md) if you want to write one.

Local models are free in the ledger (an explicit zero, not unknown).
