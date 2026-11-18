# Architecture decision records

Short records of the decisions that shaped chattree: the choice made, and why. They exist so a future developer (or agent) can tell *why* something is the way it is without wading through design history. The contemporary description of how things work is in `docs/map/`, and the rules to follow are in `docs/conventions.md`.

Format: context, decision, why, notes. A record is not edited when a decision changes: a new record is added and the old one's status becomes `superseded by N`. The status of everything here is `accepted` unless it says otherwise. The records were written together on 2026-11-17 from the earlier design documents, so their numbers follow topic, not date. The earlier design documents they were drawn from (build orders, spike results, per-step notes) are in Git history: see `docs/` at commit 903b272.

- [1](0001-git-driven-through-the-command-line.md) Drive Git through its command line
- [2](0002-host-seam-and-runtime-independent-core.md) A `Host` seam; only one file imports Node
- [3](0003-mutations-are-transactions.md) Every mutation is a locked transaction
- [4](0004-commit-trailers-and-byte-prefix-history.md) Commit trailers record the entry and the file offset
- [5](0005-crash-safety-by-ordering-and-recovery.md) Crash safety: append, fsync, commit, then recover on open
- [6](0006-subagent-merge-takes-the-trunk.md) A subagent merge takes the trunk on conflict and reports it
- [7](0007-minimum-git-2-38.md) Minimum Git version is 2.38
- [8](0008-single-repository-workspace.md) One repository holds transcript, config, blobs and workspace files
- [9](0009-format-version-is-reader-state.md) The format version is the state of a read; no forward compatibility
- [10](0010-canonical-yaml-subset-transcript.md) The transcript is a strict, canonical YAML subset that only chattree writes
- [11](0011-typebox-single-schema-source.md) TypeBox is the single source of truth for schemas and validation
- [12](0012-no-forward-compatibility-strict-entries.md) Entries are strict on read and write
- [13](0013-transcript-holds-agent-state.md) The transcript holds the agent's state; `harness.yml` holds only the outside world
- [14](0014-explicit-mutations-for-cost-and-cache.md) Anything that costs money or breaks a cache changes through an explicit mutation
- [15](0015-stateless-adapters-neutral-event-stream.md) Provider adapters are stateless functions from context to an event stream
- [16](0016-shared-http-base.md) A shared, replaceable HTTP base; a provider is three small functions
- [17](0017-replay-always-possible.md) Server-side state is an optimisation, never the only copy
- [18](0018-journal-beside-the-repository.md) Streaming is journalled beside the repository, not committed
- [19](0019-secrets-names-in-config.md) Config stores names of secrets; values come from a source that cannot be committed
- [20](0020-pinned-pricing-and-limits.md) Pricing is normalised and pinned by hash; limits are enforced
- [21](0021-pinned-definitions.md) Tools, instructions, skills and MCP are pinned by hash
- [22](0022-tail-deltas-for-drift.md) Instruction and skill edits are appended at the tail by default
- [23](0023-injections-are-recorded.md) Injections are recorded as entries, not generated at request time
- [24](0024-mcp-tools-opt-in-and-pinned.md) MCP: tools only, nothing starts until accepted, every call asks
- [25](0025-tool-schema-projection.md) A tool keeps the schema its author wrote; each model is shown a projection
- [26](0026-tool-loop-design.md) The tool loop: one result per commit, ordered, did-not-run on recovery
- [27](0027-run-without-a-shell.md) `run` takes a bash-like command line that we parse; no shell
- [28](0028-background-jobs-as-entries.md) Background jobs report through `job_event` entries
- [29](0029-child-cost-counts-to-parent.md) A subagent's cost counts toward the parent's turn limit
- [30](0030-cli-library-split.md) The CLI is a thin host over the library
- [31](0031-compaction-trim-and-summary.md) Compaction is explicit, readable and provider-independent
- [32](0032-local-models-daemon.md) Local models: a detached daemon over llama-server's router mode
- [33](0033-dialects-over-completion.md) Dialects: our own prompt rendering and parsing for local models
- [34](0034-dependency-policy.md) Dependencies are few, justified and pinned
- [35](0035-ui-architecture.md) The UI is a controller over the harness, with views that only draw
