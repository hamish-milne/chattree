# `hosts/`: host implementations

**Purpose.** The code that implements the core's `Host` seam for a particular machine, plus fetchers for helper programs. `hosts/node.ts` is the only code in the repository that imports Node's process and file APIs for the seam.

| File | Role |
|---|---|
| `node.ts` | The local-machine `Host` over `node:child_process` and `node:fs`. Programs are never run through a shell. `createExclusive` publishes a file atomically by hard link; a filesystem without hard links falls back to a non-atomic create (see the code comment: a concurrent reader can then see an empty lock file). |
| `busybox.ts` | `busybox.exe` for Windows, fetched on first use for the `run` and `script` tools: pinned URL and SHA-256, kept in `vendor/busybox/` (git-ignored), checked to answer `--list`. GPL-2.0, not part of the repository. |
| `ffmpeg.ts` | ffmpeg for the audio probes and benches and (later) codecs; fetched on Windows from a pinned build, hash-checked. Never reached by the model. |

**Invariants.** A host takes argv arrays only. `signal` must kill the process and its children. Downloaded helpers are used only if their hash matches the pinned one.

**To change X.** *A new kind of host (container, remote):* implement `Host` from `src/host.ts` and run `test/hosts/` against it; see [Extending: hosts](../extending/hosts.md). *A new helper program:* follow `busybox.ts` (pin, hash-check, vendor directory) and note it in [dependencies.md](dependencies.md); downloads need the user's approval.
