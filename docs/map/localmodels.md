# `localmodels/`: the local model host

**Purpose.** Runs models on the user's machine without the user operating `llama-server` by hand: installs llama.cpp, downloads models, writes the server's preset file, starts and supervises the server, and exposes a control API. A detached *daemon* owns the host so it outlives sessions. Reasons: ADR 32.

**Depends on:** `src/` (validation, locks, host seam). **Used by:** `cli/models.ts` (the `chattree models` verbs), `app/providers.ts` and `providers/local-models.ts` (the provider's catalog and address come from here at runtime). The user-facing settings are described in [Local models](../guide/local-models.md).

## How it fits together

Settings (`config.ts`) go through `plan.ts` to the files to have and the preset that starts llama-server in router mode. `host.ts` installs the program (`install.ts`, `release.ts`), fetches the models (`store.ts`, `download.ts`, `hf.ts`), starts the engine (`engine.ts`), restarts it if it dies, and applies a changed settings section without stopping the server when it can. `daemon.ts` wraps the host in a process with a control API (`control.ts`); sessions find it through `daemon-files.ts` and talk to it with `client.ts`.

## Files

| File | Role |
|---|---|
| `config.ts` | The `local_models` settings schema (strict): llama.cpp release, server, defaults, per-model entries with their rules. Pure data. |
| `catalog.ts` | The settings seen as a provider catalog and agent setup; resolves a name or alias to a model. Pure. |
| `plan.ts` | From settings to the files to have, the preset and the server arguments. Deterministic, so the host can tell whether a change needs a restart. |
| `host.ts` | The host: settings in, a running server out. Installs, fetches, writes the preset, starts, supervises, applies changes. |
| `engine.ts` | The engine seam; the first engine is llama-server's router mode, written against an interface so another can be added. |
| `install.ts`, `release.ts`, `gpu.ts` | Fetch and unpack llama.cpp (with a consent step: tag, files, sizes, hashes), choose the file for this machine, detect a GPU for `backend: auto`. |
| `store.ts`, `download.ts`, `hf.ts`, `net.ts` | Model files: resolve Hugging Face quantisations, download resumably with size and SHA-256 checks, fetch by hand-followed redirects so a token only reaches its own host. |
| `lock.ts` | The record of what was fetched (hash and size on first arrival); a changed hash on a recorded program is refused. |
| `inventory.ts` | What is on disk for each configured model, from settings and lock alone; removing and pruning files. |
| `sampling.ts` | Where a model's sampling comes from when settings do not say: GGUF header, then the base model's generation config. |
| `daemon.ts`, `control.ts`, `daemon-files.ts`, `client.ts` | The daemon process, its token-authenticated loopback control API, how sessions find it, and the client (every answer is validated; the daemon may be another build). |
| `typed.ts` | Small typed helpers. |

## Invariants

- Nothing half-written is ever at a model file's destination (`.part`, then rename after the checks).
- A recorded program or file is trusted from the lock without asking the network, so the host starts offline; an unexpected hash change is an error, not a silent update. There is no implicit "latest".
- A token is sent only to the host it was meant for.
- `plan.ts` is pure and deterministic.
- Sessions never stop the daemon; `chattree models stop` does.

## To change X

- *Add a setting:* `config.ts` (strict schema and rules), `plan.ts` if it changes the preset, `app/settings.ts` template if it needs an example, and the [local models guide](../guide/local-models.md).
- *Support another engine:* implement the interface in `engine.ts` and select it by `engine` in the settings.
- *Change how a model is chosen or described to the provider:* `catalog.ts`.
- *Add a `chattree models` verb:* a control API route in `control.ts`, a method on `client.ts`, and the verb in `cli/models.ts`.
