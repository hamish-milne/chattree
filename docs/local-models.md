# Local models: the model host

Status: **planned** (2026-11-04). Nothing here is built. The aim is to host local models ourselves: download them, run them, and, once we control the server, control what the model is shown (chat templates, tool schemas: section 9).

## 1. Decisions

- **Engine: llama-swap**, behind an `Engine` interface. llama-server's own router mode (`--models-preset`, `--models-dir`, `--models-max`, autoload) is the alternative; as last read it was experimental, with no idle unload. Both are checked in the spike (section 8, step 0).
- **A detached daemon** (`chattree models serve`) owns the host. Sessions find it, start it if needed, and never stop it. `chattree models stop` does.
- **Sampling** resolved from settings values and (when there are none) the model's own metadata, passed to llama-server as server defaults *and* copied into a thread's agent setup when it chooses the model, so history records what was used.
- **Model id in history** is `name@hash8` (the first 8 hex digits of the GGUF's SHA-256), so a changed file under the same name shows as a model change.
- Installing a downloaded binary is a consent step (tag, URL, size, hash) under the dependency policy (docs/dependencies.md); `-y` skips it. Hashes are recorded on first fetch in a lock file and checked at every start. No implicit "latest".

## 2. What was found (unverified parts marked)

- llama-swap model keys: `cmd` (with `${PORT}`), `proxy`, `ttl`, `aliases`, `env`, `checkEndpoint`, `filters.strip_params`, `unlisted`, `useModelName`, `cmdStop`, `name`, `description`, `concurrencyLimit`; top level `healthCheckTimeout` (default 120), `startPort`, `macros`, `groups` (`swap`, `exclusive`, `persistent`, `members`), `hooks.on_startup.preload`. Its command-line flags, release assets and `/running` / `/unload` endpoints: **unverified** (the sandbox could not read the README).
- llama-server downloads from Hugging Face by itself with `-hf repo:quant` into `LLAMA_CACHE`; we download ourselves instead (progress events, resume, hash check).
- `general.default_sampling.*` keys in GGUF metadata were merged into llama.cpp in Nov 2025; a March 2026 report says llama-server still ignored them (`/props` showed built-in defaults). Not relied on.

## 3. Components

- **`LocalModelHost`** (library, no CLI): state machine `idle → installing → downloading → starting → loading <model> → ready | error`, typed events.
  - *Installer*: release assets by tag, platform, arch and backend; unpacked with `tar`; hash lock.
  - *ModelStore*: Range-resumed downloads, atomic rename, multi-part GGUF, optional `mmproj`; the hash from Hugging Face's `x-linked-etag` is verified; a token from `hf_token_env` for gated repos; free space checked first.
  - *Planner*: settings to downloads, llama-server flags and a deterministic llama-swap `config.yaml`; a reload only when the generated config changed.
  - *Supervisor*: llama-swap as a child with restart and backoff, a log ring buffer, polling for which model is loading or loaded.
- **Daemon**: loopback HTTP control API with a token and server-sent events (`status`, `events`, `apply`, `pull`, `stop`), separate from the model API (llama-swap's port). A state file (pid, ports, token, settings hash; mode 0600) and a lock make discovery and single start. It watches `settings.yml`; a file that fails validation keeps the old state and reports the error. Optional `idle_exit_minutes`, off by default. Detached without a console window on Windows.
- **Provider `local-models`**: `harness.yml` stays portable (`$tag: local-models`, a model name); at connect time the adapter asks the host for the base URL and the catalog (names, context window from settings or `/props`, tool convention, price zero), then reuses the openai-compatible mapper with `--jinja` on.
- **CLI**: the first request needing a local model (or session start when the thread's model is local) ensures the host; output shows installing, downloading (bytes, rate), starting and loading; `say` and `run` print the same to stderr. Verbs and slash commands: `models` (status), `start`, `stop`, `restart`, `list`, `pull [name]`, `logs [-f]`, `update`, `rm`, `info <name>`.
- **GUI**: the control API and event schema are the contract; the library can also be embedded; a GUI edits `settings.yml` and the host reacts.

## 4. Settings (draft)

```yaml
data_dir: ~/.local/share/chattree        # top level (the parked data-directory item)
local_models:
  llama_swap: { tag: vNNN }              # or path: for your own binary
  llama_cpp:  { tag: bNNNN, backend: auto|cuda|vulkan|metal|cpu, path: }
  server: { port: auto, health_timeout: 300, ttl: 600, idle_exit_minutes: }
  defaults: { ctx_size: 32768, ngl: 99, flash_attn: true, jinja: true, args: [] }
  hf_token_env: HF_TOKEN
  models:
    qwen3-4b:
      url: https://huggingface.co/.../resolve/main/x-Q4_K_M.gguf   # or hf: org/repo:Q4_K_M
      sha256:
      ctx_size: 16384
      sampling: { temperature: 0.6, top_p: 0.95, top_k: 20 }
      tool_convention: flat | full
      chat_template: path                # reserved for section 9
      embeddings: false
      args: []
```

## 5. Sampling, in this order, never applied silently

1. `sampling` in the settings. 2. `general.default_sampling.*` read from the GGUF header with a small Range request (parsed by us). 3. `generation_config.json` of the base model's repository (found through the GGUF's `general.base_model` metadata), if there is one. 4. Nothing. `chattree models info <name>` shows the values and where each came from, and offers to write them into the settings.

## 6. Risks

Disk space; gated repositories; GPU backend detection (`auto` falls back to CPU, visibly); model swapping when subagents use different local models (`groups` and `ttl` per model entry); nothing here has run on a real GPU machine.

## 7. Embeddings

A model entry may say `embeddings: true` (llama-server `--embeddings`); that is what the parked semantic search (docs/tools.md, 4.4) would use.

## 8. Build order

0. **Spike** (needs approval for downloads): llama-swap flags, reload behaviour, release assets and `/running`; router mode as the alternative; `/props`; the sampling-metadata bug; a GGUF header parse. Update this document with the facts.
1. Settings schema, `data_dir`, and the pure functions: settings to download list, llama-server flags and llama-swap config (unit tests).
2. Downloader and installer against a fake HTTP server (resume, hash mismatch, multi-part).
3. `LocalModelHost`: state machine, supervisor, settings watcher, tested against a fake llama-swap script.
4. Daemon, control API, discovery and lock, the verbs, Windows detached start.
5. `local-models` adapter, catalog, `init --provider local-models`, engine hook and progress output.
6. Sampling resolution and `models info`.
7. Section 9.

## 9. After the host: our own templates

With the server ours, a model entry can carry a `chat_template` (llama-server `--chat-template-file`), and the reserved `text` and `raw` tool conventions (docs/tools.md, 3.7) become buildable: our own rendering of tool schemas, either through a template of ours or a pre-rendered prompt sent to the completion endpoint. That gets its own plan once step 5 works.
