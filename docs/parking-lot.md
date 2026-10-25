# Parking lot

Things deliberately left out of the MVP, with enough context to pick them up later. Each entry says what it is,
why it waited, and what a first step would be. Nothing here is needed for correctness today.

## 1. Merge policy per environment, file or hunk (the main one)

**Today.** Merging a subagent or a fork (D6, `finishSubagent`, `mergeFork`) has one policy: *trunk wins, per
file*. Files only the child changed come across; a file both sides changed keeps the trunk's version whole, and
the merge entry records exactly what happened (`files.changed/added/discarded`, `merge.conflicts`). That is safe
and predictable, and it is the right default for code, but it is too blunt for other kinds of work.

**The idea.** The workspace an agent works in is an *environment*, and different environments want different
rules. Examples:

| Environment | What it wants |
| --- | --- |
| Source code | Hunk-level merge; on a true conflict of hunks, trunk wins (or ask). |
| Prose and docs | Hunk-level merge; on conflict keep both with a marker for a human or a follow-up turn. |
| Data files, logs, append-only | `union`: keep both sides' additions. |
| Lockfiles, generated output | Take neither: drop both sides and regenerate (run a command after the merge). |
| Binary assets | File-level only; child wins if the trunk did not touch it, otherwise trunk. |
| Notes the agent owns (`notes.md`) | Child wins: the subagent was *asked* to update it. |

Two independent choices make up a policy:

- **Granularity**: `file` (what we have) or `hunk`.
- **Resolution** for what cannot be merged cleanly: `trunk`, `child`, `union`, `ask` (leave the branch unmerged
  and tell the model what is in the way), or `regenerate` (drop both, run a command).

**Where it is configured.** In `harness.yml`, so it is versioned with the repository (there is no `config_changed` entry any more):

```yaml
merge:
  default: { granularity: file, resolution: trunk }   # today's behaviour
  rules:                                              # first match wins
    - { paths: ["src/**", "test/**"], granularity: hunk, resolution: trunk }
    - { paths: ["docs/**", "*.md"],   granularity: hunk, resolution: union }
    - { paths: ["*.lock"],            resolution: regenerate, command: "pnpm install" }
    - { paths: ["data/**/*.jsonl"],   resolution: union }
```

The policy used is the one recorded in the *receiving* branch's configuration at merge time, and the merge
entry records which rule applied to each path, so a later reader never has to guess.

**How hunk-level could be done.** `git merge-tree --write-tree` (which we already use, git ≥ 2.38) reports
conflicted paths but does not itself offer per-hunk resolution at our minimum version. Two routes:

1. For each conflicted path, run `git merge-file -p --ours|--theirs|--union <current> <base> <other>` on the three
   versions (read through `catFile`) and write the result into the merge tree with `rewriteTree`. `merge-file`
   has existed for a very long time, resolves conflicting *hunks* (not whole files) by the chosen side, and
   needs no new git version. Binary files must be detected first and kept at file level.
2. Use `merge-tree -X ours|theirs` if and when the minimum version is raised to one that has it (to be checked
   before relying on it; we avoided depending on it in step 4).

**Format impact.** The merge report grows: per path, the rule that applied, the granularity, and for hunk merges
the number of hunks taken from each side. That is an additive format change (minor 1.3); `policy: "trunk"` stays
valid and is simply the default rule.

**Open questions.**

- `ask`: does the merge refuse and leave both branches as they are, or does it merge everything else and report
  the unresolved paths? Either way the model needs a way to resolve and retry; a "resolve" turn on the child
  branch is the natural shape.
- `union` on prose can produce duplicated or contradictory paragraphs; is it only for line-oriented data?
- Is `regenerate` a merge feature at all, or a post-merge hook the environment owns?
- Determinism: resolution must depend only on committed state (the three versions and the recorded config), never
  on timing or on a model call inside the merge, so a merge can be re-verified from the history alone.
- Interaction with the production layout (item 3): a merge across the code submodule and the chat repository.

**First step.** Put the policy type and rule matching (pure, no git) behind the existing merge code, keep the
default identical to today's, and add hunk granularity with `merge-file` behind it, with a test per row of the
table above.

## 2. Repository maintenance

`gc.auto` is off so git never rewrites the repository behind a running conversation. Loose objects (every
commit writes a few) accumulate. A `maintain()` that runs `git gc` or `git repack` under all branch locks, from
an explicit call or an idle moment, is the missing piece. History is never rewritten by the library; blob GC
(`gcBlobs`) only changes the current tree.

## 3. Production workspace split (D8)

The MVP keeps chat and project files in one repository. The production shape keeps the project in a submodule
with the pointer tracked in the chat repository (plus branch name and a saved diff of uncommitted changes). This
also lets one agent flow work across several repositories. It touches snapshots, forks, merges and verification.

## 4. A persistent `fast-import` process

Considered and parked on measurement. An append costs two short git processes (stage, commit), about 12 ms; the
floor is git's own index and commit work. A long-lived `fast-import` would need `checkpoint`/`get-mark` round
trips for the hash, would leave the index behind the commit (needing `reset` anyway), and would add a process to
supervise on every handle. `appendMany` already makes bulk writes constant-cost. Revisit only if profiling a real
agent loop shows process start-up dominating.

## 5. Smaller items

- **Events are in memory.** `onEvent` is delivered after commit, but a crash between commit and delivery loses
  the event. Consumers that must not miss anything should rebuild from history (`index()`, the `recovery`
  event); an at-least-once persisted outbox is possible if needed.
- **Index cache assumption.** A cached index is extended when its tip is an ancestor of HEAD, which for a branch
  that has only ever advanced is also on its first-parent line. A branch reset to a sibling line that still
  contains the old tip would be indexed from a longer `git log`, not wrongly, but a first-parent check would
  make that explicit. `verifyHistory` never uses the cache.
- **Locks across machines.** Locks are files, which is right for one machine and for local-disk worktrees; a
  network file system with weak `link`/`rename` semantics is not supported.
- **Windows.** The `Host` seam keeps Node-specific code out of the core, and paths are built through
  `host.path`, but the suite has only been run on Linux.
- **A command-line verifier.** `verifyHistory` and `readCommitGraph` are library calls; a thin CLI over them
  (`chattree verify`, `chattree graph`) would make them usable on any conversation repository.
- **Context building for models.** `contextEntries` defines what is visible; turning `subagent_result` and
  `fork_merge` into prose for a model ("the user forked this conversation here, discussed X, and changed Y"),
  token counting, and provider adapters belong to the agent loop on top of this library.

## Provider adapters (from docs/providers.md v2)

- Live A/B of OpenAI stored (previous_response_id) versus stateless replay: cost, cached tokens, latency. Needs an API key.
- Verify Anthropic prompt caching (breakpoints, lifetimes, multipliers, tools/system/messages order) and price table.
- Probe llama-server: Chat Completions with --jinja tools, reasoning_content, context size from /props.
- VS Code helper that adds the `!tag` custom tags to settings (yaml.customTags).
- Do OpenAI hosted tools (web search, code interpreter) need server-side state?
- OpenAI WebSocket continuation cache.
- Anthropic equivalent of allowed_tools for restricting tools without changing the prefix.
- Attachments (images, files) in both adapters; they are refused today.
- OpenAI standalone compaction (`/responses/compact`), for compacting on demand rather than at a threshold.
- Verify against the real API (chaining and retrieval are verified): `context_management`, dropping items before a
  compaction item, the not-found error the chain fallback matches. Spend sparingly: the free tier is limited, so use
  `--only` to pick scenarios.
- Pricing and catalog: the bundled tables came from a summarising read of the pricing pages (check them against the
  pages, and add the older models once their API ids are confirmed); an API-backed catalog (`/models`, llama-server's
  `/props` for the context size); token-counting endpoints (Anthropic `count_tokens`, OpenAI input tokens) to replace the
  bytes-per-token estimate; calibrating the estimate from the last response's real usage; Anthropic's `inference_geo`
  1.1x multiplier and batch discounts; OpenAI's regional-processing uplift.
- Pricing data gaps (2026-10-25): `gpt-5.4-mini` and the long-context prices for OpenAI were not found by two automated
  reads of the pricing page (it has tabs and a Short/Long toggle that a text fetch does not bind); the tier tables are
  matched to tab names by position. Needs someone to read the tabs in a browser, or paste them. Which `service_tier`
  value selects "Fast" (the page says Priority was renamed Fast on 2026-07-30) is unknown. Bundled only: the gpt-6
  family and gpt-5.3-codex; `chat-latest` (an alias) and the restricted cyber and life-sciences models are left to
  overrides.
- Mixed cache lifetimes within one request (the docs allow it: longer ones first), for example the pinned prefix at 1h and
  the conversation at 5m; OpenAI's per-breakpoint `prompt_cache_breakpoint.ttl`. Today one `cache_ttl` covers every marker.
- A merge's rollup resolves tables the child pinned only from this conversation's providers and blobs, so a child that
  pinned a table which no longer exists here is counted as unpriced.
- Anthropic has no free API tier, so the Anthropic adapter is only checked against Ollama's compatible endpoint.
- A `chattree` command that creates `.chattree/env`, and a `secrets check` that lists which variables each provider needs.
- Run `tools/live-check.ts` against Ollama and record fixtures from it. Known Ollama caveats: no `cache_control` or
  `tool_choice`, in-stream errors are unreliable, small models may not call tools or reason (those scenarios skip).
- A Chat Completions flavor for the live check, once the `openai-compatible` adapter (step 8) exists.

## Renderers

- Verifying a renderer's output at runtime (a self-test with fixed inputs, output hash recorded in the setup).
  Decided: stability is part of the renderer interface contract (an id is immutable, renderers are pure), not
  something the harness defensively checks, at least for now. Revisit if host-supplied renderers cause drift.

- Ollama (gemma4:12b, live run 2026-10-25): its Anthropic `message_start` input count is provisional and is revised
  down in `message_delta` (fixed: start usage is no longer emitted). Reasoning arrives before text, so the abort check now
  triggers on either. OpenAI Responses passed all scenarios.
