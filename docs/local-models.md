# Local models: the model host

Status: **planned** (2026-11-04). Nothing here is built. The aim is to host local models ourselves: download them, run them, and, once we control the server, control what the model is shown (chat templates, tool schemas: section 9).

## 1. Decisions

- **Engine: llama-swap**, behind an `Engine` interface. llama-server's own router mode (`--models-preset`, `--models-dir`, `--models-max`, autoload, LRU unloading by memory margin) is the alternative and has caught up on eviction, though it has no per-model idle TTL that we know of; both are checked in the spike (section 8, step 0).
- **A detached daemon** (`chattree models serve`) owns the host. Sessions find it, start it if needed, and never stop it. `chattree models stop` does.
- **Sampling** resolved from settings values and (when there are none) the model's own metadata, passed to llama-server as server defaults *and* copied into a thread's agent setup when it chooses the model, so history records what was used.
- **Model id in history** is `name@hash8` (the first 8 hex digits of the GGUF's SHA-256), so a changed file under the same name shows as a model change.
- Installing a downloaded binary is a consent step (tag, URL, size, hash) under the dependency policy (docs/dependencies.md); `-y` skips it. Hashes are recorded on first fetch in a lock file and checked at every start. No implicit "latest".

## 2. What was found (the spike, 2026-11-04)

Everything marked **checked** was run in the sandbox: llama-swap built with `go install github.com/mostlygeek/llama-swap@main` (`@latest` resolves to a very old pre-v1 tag: use `@main` or a commit), llama.cpp (the `vendor/llama.cpp` of the `llama-cpp-python` 0.3.36 sdist, "0.5.0-dev", Oct 2026) built from source with cmake (about 15 minutes on 2 CPUs), and `unsloth/Qwen3-0.6B-GGUF` Q4_K_M (397 MB) as the model. **Not checked:** the release asset names of either project (`github.com` and `api.github.com` are still blocked here, so the installer's asset selection is designed from the READMEs and must be confirmed against the releases page).

**llama-swap** (flags and behaviour checked on `main`):
- Flags: `-config`, `-config-dir` (additive `*.yml`), `-listen` (default `:8080`), `-watch-config` (**default off** in the binary; on in the Docker image), `-validate` (parse the config and exit: "config is valid: 2 model(s)"), `-version`, TLS flags.
- A request for an unloaded model starts it, and by default only one model runs (the previous one is stopped). `ttl` unloads after idle (checked). A model's alias is accepted and the request body goes through unchanged (`model: "a"` reaches the upstream as `a`) unless `useModelName` is set.
- `-watch-config`: editing the file adds and removes models within about two seconds (checked); **an invalid file keeps the old configuration** and logs `failed to reload config: ...` (checked).
- Endpoints (checked): `GET /v1/models` (each entry has `status.value`: `unloaded`, `ready`, ... and `meta.llamaswap.aliases`), `GET /running` (`state`, `cmd`, `proxy`, `ttl`), `POST /api/models/unload` (`{"msg":"ok"}`), `/upstream/<id>/<path>` (reaches the upstream's own `/props`), `/health`, logs at `/logs`, `/logs/stream[/{model_id}]`.
- With llama-server as the upstream: first request including model load took 1.7 s (0.6B model). The response's `model` field is llama-server's own name for the model (its file path), not the llama-swap id.

**llama-server** (checked):
- `GET /props`: `default_generation_settings.n_ctx` and `.params` (the sampling defaults actually in force), `total_slots`, `model_path`, `modalities` (`vision`, `video`, `audio`), `chat_template`, `chat_template_caps` (`supports_tools`, `supports_tool_calls`, `supports_parallel_tool_calls`, `supports_system_role`, `supports_preserve_reasoning`, ...), `bos_token`, `eos_token`, `build_info`, `is_sleeping`. This is the catalog's source for context size, tool support and vision.
- `GET /v1/models` adds `meta.n_ctx`, `n_ctx_train`, `n_params`, `size`, `vocab_type`.
- `/health` is 200 `{"status":"ok"}` once the model is ready.
- A tool call through `/v1/chat/completions` worked (Qwen3-0.6B with the model's own template, `--jinja` on by default): `finish_reason: tool_calls`, the reasoning in `reasoning_content`, `usage` with `prompt_tokens_details.cached_tokens`, and `timings`. About 20 tokens/s on 2 CPUs.
- **Sampling metadata is applied, under different key names than the proposal in the llama.cpp discussion:** the source reads `general.sampling.{temp,top_k,top_p,min_p,xtc_probability,xtc_threshold,penalty_last_n,sequence,...}`, not `general.default_sampling.*`. A copy of the model with `general.sampling.temp=0.123`, `top_k=7`, `top_p=0.77` and no flags showed exactly those in `/props` (checked). Flags override (`--temp 0.6 --top-k 20` showed in `/props`). The common GGUFs do not carry the keys: the Unsloth Qwen3 file has none (and no `general.base_model`).
- **Router mode works** (`--models-preset file.ini`, checked): `[*]` is shared settings (`ctx-size`, `threads`, ...), a `[name]` section is a model (`model = /path.gguf`, any long CLI option without the dashes, `temp`, `sleep-idle-seconds`, `stop-timeout`, `load-on-startup`, `tags`, aliases); `--models-max N` evicts the least recently used model on the next request (checked with N=1); `GET /v1/models` shows `status.value` (`unloaded`, `loading`, `loaded`, `sleeping`) with each model's resolved `args` and `preset`; `POST /models/load` and `/models/unload` (`{"model": "..."}`, answers `{"success":true}`); `GET /models/sse` streams status changes; `sleep-idle-seconds` per model made an idle model go to `sleeping`. The INI is **not watched**: `GET /models?reload=1` re-reads it and adds the new models (checked). The router warns "do not expose to untrusted environments"; each model is a child process on a random port.
- `--sleep-idle-seconds` exists for a single server too.

**Hugging Face** (checked):
- `HEAD https://huggingface.co/<repo>/resolve/main/<file>` answers a 302 with `x-linked-etag` (the file's SHA-256, equal to `sha256sum` of the download), `x-linked-size`, `x-repo-commit`, `accept-ranges: bytes`; the redirect goes to `us.aws.cdn.hf.co` (the xet bridge), which also takes ranges. A 397 MB download took seconds from here.
- `GET /api/models/<repo>` for a GGUF repo returns `gguf` (`total`, `architecture`, `context_length`, `chat_template`), `tags` including `base_model:Qwen/Qwen3-0.6B`, `cardData.base_model` and the file list (`siblings`). A repository that does not exist answers 401, not 404.
- The base repo's `generation_config.json` carries the recommended sampling (Qwen/Qwen3-0.6B: `temperature 0.6, top_k 20, top_p 0.95`); the GGUF repo has none. So the lookup of section 5 works through the API's `base_model`, not through the GGUF header.

**Engine choice, in the light of this.** Router mode is a real alternative: one binary, status and per-model arguments visible, an SSE stream of state changes, LRU eviction and per-model idle sleep, a settings file we generate in INI. llama-swap adds backends other than llama.cpp, groups, aliases and its own proxy and logs. The decision stands (llama-swap first, an `Engine` interface), but router mode could become the default later, since it removes a download; the cost of adding it is mostly the INI writer and the status mapping.

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

1. `sampling` in the settings. 2. `general.sampling.*` read from the GGUF header with a small Range request (parsed by us; llama-server applies these itself, so this is to show and pin them). 3. `generation_config.json` of the base model's repository, found through the Hugging Face API's `base_model` (`cardData.base_model` or the `base_model:` tag): `temperature`, `top_k`, `top_p`. 4. Nothing. `chattree models info <name>` shows the values and where each came from, and offers to write them into the settings.

## 6. Risks

Disk space; gated repositories; GPU backend detection (`auto` falls back to CPU, visibly); model swapping when subagents use different local models (`groups` and `ttl` per model entry); nothing here has run on a real GPU machine.

## 7. Embeddings

A model entry may say `embeddings: true` (llama-server `--embeddings`); that is what the parked semantic search (docs/tools.md, 4.4) would use.

## 8. Build order

0. **Spike: done** (section 2). Left over: the release asset names of llama-swap and llama.cpp (blocked here), and a first real GPU run.
1. Settings schema, `data_dir`, and the pure functions: settings to download list, llama-server flags and llama-swap config (unit tests).
2. Downloader and installer against a fake HTTP server (resume, hash mismatch, multi-part).
3. `LocalModelHost`: state machine, supervisor, settings watcher, tested against a fake llama-swap script.
4. Daemon, control API, discovery and lock, the verbs, Windows detached start.
5. `local-models` adapter, catalog, `init --provider local-models`, engine hook and progress output.
6. Sampling resolution and `models info`.
7. Section 9.

## 9. After the host: our own templates

With the server ours, a model entry can carry a `chat_template` (llama-server `--chat-template-file`), and the reserved `text` and `raw` tool conventions (docs/tools.md, 3.7) become buildable: our own rendering of tool schemas, either through a template of ours or a pre-rendered prompt sent to the completion endpoint. That gets its own plan once step 5 works.
