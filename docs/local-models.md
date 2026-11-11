# Local models: the model host

Status: **planned** (2026-11-04). Nothing here is built. The aim is to host local models ourselves: download them, run them, and, once we control the server, control what the model is shown (chat templates, tool schemas: section 9).

## 1. Decisions

- **Engine: llama-server's router mode** (`--models-preset file.ini`, `--models-max`), behind an `Engine` interface. llama-swap can be a second engine later (it adds other backends, groups and its own proxy). Chosen after the spike (section 2): one binary, per-model status and arguments visible, SSE state changes, LRU eviction, per-model idle sleep, and a preset file we generate in INI.
- **A detached daemon** (`chattree models serve`) owns the host. Sessions find it, start it if needed, and never stop it. `chattree models stop` does.
- **Sampling** resolved from settings values and (when there are none) the model's own metadata, passed to llama-server as server defaults *and* copied into a thread's agent setup when it chooses the model, so history records what was used.
- **Model id in history** is `name@hash8` (the first 8 hex digits of the GGUF's SHA-256), so a changed file under the same name shows as a model change.
- Installing a downloaded binary is a consent step (tag, URL, size, hash) under the dependency policy (docs/dependencies.md); `-y` skips it. Hashes are recorded on first fetch in a lock file and checked at every start. No implicit "latest".

## 2. What was found (the spike, 2026-11-04)

Everything marked **checked** was run in the sandbox: llama-swap built with `go install github.com/mostlygeek/llama-swap@main` (`@latest` resolves to a very old pre-v1 tag: use `@main` or a commit), llama.cpp (the `vendor/llama.cpp` of the `llama-cpp-python` 0.3.36 sdist, "0.5.0-dev", Oct 2026) built from source with cmake (about 15 minutes on 2 CPUs), and `unsloth/Qwen3-0.6B-GGUF` Q4_K_M (397 MB) as the model. **Not checked here:** the release asset names (`github.com` is blocked in the sandbox); the llama.cpp names were later taken from the b12110 release page (section 4).

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

**Engine choice, in the light of this.** Router mode is a real alternative: one binary, status and per-model arguments visible, an SSE stream of state changes, LRU eviction and per-model idle sleep, a settings file we generate in INI. llama-swap adds backends other than llama.cpp, groups, aliases and its own proxy and logs. The decision after the spike: router mode first (it removes a download and a process), llama-swap possibly later behind the same `Engine` interface.

## 3. Components

- **`LocalModelHost`** (library, no CLI): state machine `idle → installing → downloading → starting → loading <model> → ready | error`, typed events.
  - *Installer*: release assets by tag, platform, arch and backend; unpacked with `tar`; hash lock.
  - *ModelStore*: Range-resumed downloads, atomic rename, multi-part GGUF, optional `mmproj`; the hash from Hugging Face's `x-linked-etag` is verified; a token from `hf_token_env` for gated repos; free space checked first.
  - *Planner*: settings to downloads, llama-server flags and a deterministic router preset (INI); the host restarts or reloads (`GET /models?reload=1`) only when the generated preset changed.
  - *Supervisor*: llama-server (router mode) as a child with restart and backoff, a log ring buffer, `GET /v1/models` and `/models/sse` for which model is loading or loaded.
- **Daemon**: loopback HTTP control API with a token and server-sent events (`status`, `events`, `apply`, `pull`, `stop`), separate from the model API (llama-server's port). A state file (pid, ports, token, settings hash; mode 0600) and a lock make discovery and single start. It watches `settings.yml`; a file that fails validation keeps the old state and reports the error. Optional `idle_exit_minutes`, off by default. Detached without a console window on Windows.
- **Provider `local-models`**: `harness.yml` stays portable (`$tag: local-models`, a model name); at connect time the adapter asks the host for the base URL and the catalog (names, context window from settings or `/props`, tool convention, price zero), then reuses the openai-compatible mapper with `--jinja` on.
- **CLI**: the first request needing a local model (or session start when the thread's model is local) ensures the host; output shows installing, downloading (bytes, rate), starting and loading; `say` and `run` print the same to stderr. Verbs and slash commands: `models` (status), `start`, `stop`, `restart`, `list`, `pull [name]`, `logs [-f]`, `update`, `rm`, `info <name>`.
- **GUI**: the control API and event schema are the contract; the library can also be embedded; a GUI edits `settings.yml` and the host reacts.

## 4. Settings (draft)

```yaml
data_dir: ~/.local/share/chattree        # top level
local_models:
  engine: router                         # the only one so far
  llama_cpp:
    tag: b12110                          # a build, or a version tag (v0.9.0) that links to one; none: no download
    backend: auto                        # auto | cpu | cuda | vulkan | rocm | sycl | openvino | metal
    cuda: "12.8"                         # optional preferred CUDA version
    path:                                # or your own llama-server
  server: { host: 127.0.0.1, port: auto, models_max: 1, idle_exit_minutes:, webui: false }
  defaults: { ctx_size: 32768, n_gpu_layers: auto, flash_attn: auto, jinja: true, options: { rope-scale: 2 } }
  hf_token_env: HF_TOKEN
  models:
    qwen3-4b:
      hf: unsloth/Qwen3-4B-GGUF:Q4_K_M   # or url: https://.../x-Q4_K_M.gguf, or hf + file
      sha256:
      mmproj: { file: mmproj-F16.gguf }  # or url
      ctx_size: 16384
      sampling: { temperature: 0.6, top_p: 0.95, top_k: 20 }
      aliases: []
      load_on_startup: false
      tool_convention: flat | full
      chat_template: path                # reserved for section 9
      embeddings: false
      options: {}                        # any llama-server option, long name without dashes
```

Implemented in `localmodels/config.ts` (schema, `modelSource`), `localmodels/release.ts` (assets, tags) and `localmodels/plan.ts` (`dataDir`, `downloadList`, `presetIni`, `routerArgs`). Aliases are resolved by the provider and are not written to the preset. `jinja: false` is written as `jinja = false`, which is not yet checked against a real server.

**Releases (llama.cpp).** A build tag (`b12110`) has the files, named `llama-<tag>-bin-<os>[-<backend>[-<cuda version>]]-<arch>.<tar.gz|zip>` (`os`: `win`, `ubuntu`, `macos`; macOS has no backend suffix and means Metal). A version tag (`v0.9.0`) has no files; its description links to the build (`releases/tag/bNNNN`), which the installer follows (`resolveVersionTag`, from the release's JSON; an error says to set a build tag when there is no link). The CUDA runtime is a separate file (`cudart-llama-bin-win-cuda-12.4-x64.zip`, with no tag on Windows; `cudart-llama-<tag>-bin-ubuntu-cuda-12.8-x64.tar.gz` on Linux), unpacked beside the program. GitHub shows a SHA-256 per file, which the hash lock records. `auto` means Metal on a Mac; elsewhere it runs `nvidia-smi -L` (`localmodels/gpu.ts`) and picks `cuda` if it lists a GPU, otherwise the CPU. Only NVIDIA is recognised: for an AMD or Intel card set `backend: vulkan` (guessing it would pick an integrated GPU slower than the CPU). The choice is never silent: `models start` and `models status` print the backend and why, and the CPU case says it is slow and loads every core. (Until this was added `auto` was the CPU on Windows and Linux whatever the machine had; a first real run on a GPU machine ran gpt-oss on the CPU.)

**Fetching (implemented in `localmodels/net.ts`, `download.ts`, `hf.ts`, `lock.ts`, `store.ts`, `install.ts`).**

- Redirects are followed by hand so a Hugging Face token goes only to the first host, never to the CDN it redirects to.
- A file is written to `<name>.part`, continued with a Range request, checked for size and SHA-256 while it streams, and renamed only when right. A server that ignores Range, or a part longer than the file, restarts the download once. A cut connection is an error that says running it again continues.
- `org/repo:QUANT` is resolved with the repository tree API (`lfs.oid` is the SHA-256). A quantisation matches as a whole word of the path (`Q4_K` is not `Q4_K_M`), a folder named for it counts, and a split model (`-00001-of-00003.gguf`) comes as all its parts, or an error if one is missing. An explicit `file:` or `url:` on Hugging Face gets its hash from the `x-linked-etag` of the redirect.
- `lock.json` in the data directory records the hash and size of every program archive and model file at first fetch, and what each quantisation resolved to. A recorded file that is present with its recorded size is used without asking the network, so the host starts offline. A program archive whose hash differs from the recorded one is refused. Updating a model whose upstream moved is a later explicit verb (`pull --force`), never a silent re-download.
- The llama.cpp installer reads the release from the GitHub API (the `digest` of each asset is the hash), tells the caller the tag, files, sizes and hashes before downloading (`confirm`; declining is `InstallDeclined`), unpacks with `tar` into a temporary directory, adds the CUDA runtime beside the program, runs `llama-server --version` and only then moves it to `<data>/llama.cpp/<build>-<backend>`. A program that does not start is removed and the error suggests another backend. No tag in the settings means no download.
- `name@hash8` is `modelId(name, fetched)`.

**The host (`localmodels/engine.ts`, `host.ts`).**

- `Engine` is the seam: `start(spec)` gives an `EngineProcess` (`baseUrl`, `exited`, `models()`, `reload()`, `load`, `unload`, `stop`). `RouterEngine` runs llama-server in router mode through a `SpawnFn` (replaced in tests) and waits for `GET /v1/models` to answer, within `server.health_timeout` seconds (default 60); if the program ends first, the error carries the last lines it printed.
- `LocalModelHost` takes the data directory, the settings section, platform and architecture, and gives `start()`, `stop()`, `apply(config)`, `load`, `unload`, `logs()`, `state` and `on(listener)`. Operations run one at a time. The state is `{phase, baseUrl, error, models, tag, restarts, ids}`; phases are `idle, installing, downloading, starting, ready, restarting, stopping, stopped, error`. Events: `state`, `install`, `store` (download progress), `models`, `log`. This is what the CLI will print and a GUI will show.
- Start: install (or the configured `path`), fetch every model (a model that cannot be fetched or a url that is not a `.gguf` stops the start with the reason), write `run/preset.ini`, pick a free port for `port: auto`, start, wait for the answer. `stop()` during a slow start cancels it.
- Supervisor: a server that exits unexpectedly is started again with exponential backoff (1 s, doubling to 30 s); one that ran a minute counts as healthy; after five failed starts in a row the phase is `error` with the reason and the last output.
- `apply(config)`: a change to `llama_cpp`, `server` (host, port, `models_max`, webui, timeout) or `engine` restarts the server. Any other change is fetched if needed, written to the preset, and read with `GET /models?reload=1`; models whose preset section changed (all loaded ones when `defaults` changed) are unloaded so the next request loads them with the new settings, and the rest are left alone. A change that fails (a download) leaves the old settings running and puts the reason in `state.error`. While stopped, the settings are kept for the next start.
- Model states are polled once a second while the server is up (the SSE stream, `/models/sse`, can replace the polling later).

**The daemon (`localmodels/daemon.ts`, `control.ts`, `client.ts`, `daemon-files.ts`; `cli/models.ts`).**

- `run/daemon.json` in the data directory holds the process id, the control port, a random token and the start time (mode 0600); `run/daemon.lock` is taken by the one daemon that runs (a lock of a dead process is taken over). `findDaemon` reads the file, checks the process and asks `/status`; a file whose process is gone is removed.
- The control API listens on `127.0.0.1` on a free port and wants `Authorization: Bearer <token>` on every request. A request with an `Origin` header, or with a `Host` other than `127.0.0.1:<port>` or `localhost:<port>`, is refused, so a web page cannot drive it (including by DNS rebinding). Routes: `GET /status`, `GET /events` (server-sent events: a status first, then host events, `consent` and `settings`), `GET /logs`, `POST /start {yes}` (answers at once; progress is in the events), `POST /stop` (stops the host and the process), `POST /reload` (read the settings again and apply them), `POST /consent {accept}`, `POST /models/load|unload {model}`. The model API itself is llama-server's own port, which `state.baseUrl` gives.
- Installing llama.cpp needs a yes. The daemon has no terminal, so it publishes the plan (`status.consent`, a `consent` event) and waits for `POST /consent`. `chattree models start` prints the plan (tag, files, sizes, URLs, hashes) and asks; `-y` answers yes in advance; without a terminal and without `-y` it declines and says to use `-y`. A GUI answers the same way.
- `chattree models start` finds the daemon or starts one detached (`node cli/chattree.ts models serve`, output to `run/daemon.log`, settings and data directory through the environment), then asks it to start and prints what happens (installing, download progress in tenths of each file, starting, ready with the address and models). Ctrl-C detaches: the host keeps working. `status` and `stop` say so when nothing runs; `stop` ends the daemon and the server. Two sessions starting at once end up with one daemon: the second process cannot take the lock and leaves.
- A settings file that fails to parse on a reload leaves the old settings running and shows the reason in `status.settingsError`.

**Step 4b.**

- **Watching the settings file.** The daemon watches the settings file's directory (editors replace files), waits 400 ms for the saves to settle, and applies the file only when its content hash changed. A valid file goes through the same `apply` as `models reload`; a broken one leaves the old settings running and shows in `status.settingsError`. A new `llama_cpp.tag` therefore restarts the server and asks before installing (the question waits in `status.consent` until `models start` or a GUI answers).
- **`list`, `info`, `pull`, `rm`** work from the settings and `lock.json` alone, with no host running (`list` and `info` also show live states when one is). `pull [name...]` fetches without starting the server (through the daemon when one runs, otherwise in the command itself, which starts no daemon); a pull trusts what the lock records, so a model whose file changed upstream is fetched again only with `--force`, which deletes it first. `--force` and `rm` need the server stopped, since a loaded model cannot be replaced. `rm` forgets the files, so the next start fetches them again while the model is in the settings.
- **`update`** asks GitHub for the newest llama.cpp release (a version release is followed to its build), and with a yes edits `local_models.llama_cpp.tag` in the settings file with comments kept. It never changes anything on its own.
- **`logs`** shows the server's output from the daemon's ring buffer (`-n`, `-f` to follow), or the end of `run/daemon.log` when no daemon runs.
- **`idle_exit_minutes`.** The daemon leaves when no model is loaded or loading, no event stream is attached, and no control request other than a status look has come for that long. A loaded model counts as use, and the daemon cannot see requests to llama-server's own port, so this works together with `sleep_idle_seconds` (a model that unloads itself after an idle spell lets the host leave).
- **Known limits.** On Windows the server is stopped with `taskkill /T /F` so the router's model processes go with it; the detached start (`detached`, `windowsHide`, output to a log file) has not been run on Windows here. If the daemon is killed hard (not stopped), a running llama-server can be left behind; the next daemon starts its own on another port.

**The provider (`providers/local-models.ts`, `localmodels/catalog.ts`, `cli/providers.ts`).**

- `$tag: local-models` has no address in `harness.yml` (the host picks its port): a provider entry is `local-models: { $tag: local-models }` plus the common fields (`max_concurrent`, `timeouts`, `models` overrides, ...). The adapter is built with a `LocalModelsRuntime` that the application supplies (`connect()`, `catalog()`, `resolve()`), so `providers/` knows nothing of the daemon. The CLI's runtime reads the settings file for the catalog and asks the running daemon for the address on every request, so a restart on a new port needs nothing from the session; a host that is restarting is waited for up to a minute, any other state is an error saying what to do. `cliRegistry(io)` is `defaultRegistry()` plus this adapter; a library user registers their own runtime.
- Requests are the OpenAI-compatible ones of llama-server (`/v1/chat/completions`) through the shared mapper. The `model` sent is the model's own name: an alias is resolved, and an `@hash8` suffix (what history records) is stripped. The model recorded as having served a request is `name@hash8` from the host's `ids`, so history says which file answered; if the file under a name changes, the next request shows up as a `resolved_model_changed` in the setup. Everything is free unless the provider's `pricing` says otherwise.
- The catalog is each model under its name and its aliases, with `context_window` (`ctx_size`, else `defaults.ctx_size`), `description` and `tool_convention` from the settings.
- `chattree init --provider local-models [--model <name or alias>]` writes the provider, takes the model from the settings (without `--model` it is the only one, or an error lists them) and pins the model's `sampling` in the agent setup as model settings (`temperature`, `top_p`, the rest under `extra`), as well as it being the server's default.
- **Starting the host from a session.** Before any request to a thread whose model's provider is `local-models` (every turn, and a pumped thread's loop), the engine does what `chattree models start` does: nothing when the host is ready, otherwise the same progress on stderr and the same question before installing llama.cpp (`say` and `run` have no terminal: they say to use `chattree models start -y`). Stopping the session leaves the host running; the next session finds it.

## 5. Sampling, in this order, never applied silently

1. `sampling` in the settings. 2. `general.sampling.*` read from the GGUF header with a small Range request (parsed by us; llama-server applies these itself, so this is to show and pin them). 3. `generation_config.json` of the base model's repository, found through the Hugging Face API's `base_model` (`cardData.base_model` or the `base_model:` tag): `temperature`, `top_k`, `top_p`. 4. Nothing. `chattree models info <name>` shows the values and where each came from, and offers to write them into the settings.

## 6. Risks

Disk space; gated repositories; GPU backends other than NVIDIA in `auto`; model swapping when subagents use different local models (`groups` and `ttl` per model entry); nothing here has run on a real GPU machine.

## 7. Embeddings

A model entry may say `embeddings: true` (llama-server `--embeddings`); that is what the parked semantic search (docs/tools.md, 4.4) would use.

## 8. Build order

0. **Spike: done** (section 2). Left over: a first real GPU run. The llama.cpp asset names are known (section 4).
1. Settings schema, `data_dir`, and the pure functions: settings to download list, llama-server flags and the router preset (unit tests): **done**.
2. Downloader and installer against a fake HTTP server (resume, hash mismatch, multi-part): **done**.
3. `LocalModelHost`: state machine, supervisor, applying changed settings, tested against a fake llama-server script: **done** (watching the settings *file* belongs to the daemon, step 4).
4. Daemon, control API, discovery and lock, the verbs, Windows detached start. Split: **4a done** (daemon, control API, discovery, `models start|stop|status|serve`); **4b done** (settings-file watcher, `restart|reload|list|info|pull|rm|logs|update`, `idle_exit_minutes`, a process-tree kill on Windows; the Windows detached start itself is written from the documented Node behaviour and not yet run on Windows).
5. `local-models` adapter, catalog, `init --provider local-models`, engine hook and progress output: **done**.
6. Sampling resolution and `models info`: **done** (`localmodels/sampling.ts`). Checkpoint: the tool benchmark through the local models (section 8.1).
7. Section 9.

### 8.1 The checkpoint: the tool benchmark through `local-models`

`tools/live-sample.ts --flavor local-models --model <name>` runs the benchmark tasks (`tools/tasks.ts`) through the host instead of Ollama. `--model` is a name from `local_models`; there is no `--base-url`. The host is started first (and the model downloaded, with the progress `chattree models start` shows; `--yes` agrees to installing llama.cpp), the model's sampling is looked up as `models info` does and sent with every request, and the report starts with the sampling used.

Settings for the three models of the earlier Ollama runs (the Hugging Face names are as given; `models pull` says at once if one has no such quantisation):

```yaml
local_models:
  server: { models_max: 1 }
  defaults: { ctx_size: 16384, n_gpu_layers: all }
  models:
    gpt-oss-20b: { hf: "unsloth/gpt-oss-20b-GGUF:Q4_K_M" }
    qwen3.5-9b:  { hf: "unsloth/Qwen3.5-9B-GGUF:Q6_K" }
    gemma4-12b:  { hf: "unsloth/gemma4-12b-it-GGUF:Q4_K_M" }
```

```
chattree models pull                       # fetch all three first
chattree models info qwen3.5-9b            # what sampling it will run with, and where that came from
node tools/live-sample.ts --flavor local-models --model qwen3.5-9b --repeat 10 --out qwen-local.json
```

For the numbers to be comparable, two things have to be the same as in the Ollama runs; neither can be known from here:

- **Sampling.** The Ollama runs sent no sampling, so Ollama applied each model's Modelfile (for qwen3.5: `presence_penalty 1.5, temperature 1, top_k 20, top_p 0.95`; `ollama show <model> --parameters` prints them for the others). A GGUF from Unsloth carries none of that, and the base repository's `generation_config.json` gives only `temperature`, `top_p` and `top_k`, so `models info` may show nothing or something different. Copy the Ollama values into `sampling:` in the settings; the report prints what was used.
- **Context.** Ollama's default context was used before; here it is `ctx_size`. 16384 is room for the longest task with its reasoning; a smaller one truncates silently in some servers and fails loudly in llama.cpp.

What a difference would mean: the chat template (llama.cpp's own Jinja against Ollama's Go renderer, which for gpt-oss prints nested schemas as `any[]`) and the quantisation file differ between the two, so a change in gpt-oss's results is possible either way; whether llama.cpp's template shows the full nested schema is not known yet (`GET /props` has `chat_template`). Section 9 is where that gets answered.

### 8.2 When the server rejects what the model wrote

llama-server parses a model's tool calls itself, and answers `server_error: The model produced output that does not match the expected peg-native format` (HTTP 500, or an error event in the stream) when the text is not in the model's own format. Ollama was more forgiving, so a model can look worse here than it did there. To see what the model wrote:

```
node tools/live-sample.ts --flavor local-models --model gpt-oss-20b --task "one line" --repeat 20 --wire-log wire.jsonl
node tools/llama-replay.ts --wire wire.jsonl --repeat 10 --out replay/
```

`--wire-log` records every chat request with the raw response. `llama-replay` takes the last failed one (or `--entry N`) and prints how often the same request fails when sent again, the template (`/props`), the prompt as the model sees it (`/apply-template`), and the raw text of the same prompt sent to `/completion`, with `stop_type` (`limit` means the token limit cut the model off mid-call; `--max-tokens` raises it). `--request replay/request.json` replays a saved request after a settings change, without sampling again. Step 4 runs under three samplers (as sent, greedy, OpenAI's recommendation for gpt-oss) and counts the answers that start as a well-formed harmony message, and prints the model's top candidates for the first tokens of the greedy answer.

First finding (gpt-oss-20b Q4_K_M, build b12110): the raw completion of a ~1800-token prompt began `<|channel|>comment` followed by junk tokens (`!`, `?`, `…`) in 10 of 10 samples, then recovered; the parser's 500 is the consequence. Not truncation (`--max-tokens` made no difference), and qwen3.5 on the same host was fine. Open: sampler, server flags (`parallel`, flash attention), or the quantisation. Unverified: that this llama-server build has these endpoints under these names, and that `/completion` shows special tokens (`special: true`); if the markers are missing from `raw-N.txt`, say so.

## 9. After the host: our own templates

With the server ours, a model entry can carry a `chat_template` (llama-server `--chat-template-file`), and the reserved `text` and `raw` tool conventions (docs/tools.md, 3.7) become buildable: our own rendering of tool schemas, either through a template of ours or a pre-rendered prompt sent to the completion endpoint. That gets its own plan once step 5 works.
