# Parking lot

Things deliberately left out, with enough context to pick them up later, grouped by priority:

- **High**: correctness. Left alone, it could lose data, show wrong output or block the user.
- **Medium**: features and support. Wider application or significant functionality, weighed against the cost.
- **Low**: small conveniences, unusual edge cases, minor performance gains.
- **Deferred**: pricing data that comes from external pages. It affects no other code, so it is cleaned up close to release.

Each entry says what it is and what a first step would be. Within a group, the order is the order of intent.

## High

- **Verify the Anthropic adapter against the real API.** No free tier, so today it is only checked against Ollama's
  compatible endpoint. From memory: the request shapes for `system` and `cache_control`, breakpoints, lifetimes and
  multipliers. If one is wrong, the paid provider's requests fail. Needs a key and a small spend.

## Medium

- **Attachments** (images, files): refused today by all three adapters.
- **Tool loop above `requestStream`**: the turn's deadline, `max_requests_per_turn`, tool results, and raising `cost`
  warnings as events from `Prepared.warnings`. The next layer rather than a gap in this phase.
- Merge policy per environment (below), and the production workspace split (below).
- **OpenAI compaction on the real API**: check `context_management`, dropping items before a compaction item, and the
  not-found error the chain fallback matches. Opt-in features. Spend sparingly: the free tier is limited, so use
  `--only` to pick scenarios.
- **API-backed model catalog**: `/models`, and llama-server's `/props` for the context size.
- **Check the `openai-compatible` adapter against a real llama-server** (`--jinja` tools, `reasoning_content`, the usage
  chunk; the list is in docs/providers.md step 8).
- **Windows**: the `Host` seam keeps Node-specific code out of the core, and paths go through `host.path`, but the suite has
  only been run on Linux.
- **A `chattree` command** that creates `.chattree/env`, with a `secrets check` that lists the variables each provider needs.
- **A command-line verifier**: `chattree verify` and `chattree graph` over `verifyHistory` and `readCommitGraph`, so they
  work on any conversation repository.

### Merge policy per environment, file or hunk (the main one)

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

### Production workspace split (D8)

The MVP keeps chat and project files in one repository. The production shape keeps the project in a submodule
with the pointer tracked in the chat repository (plus branch name and a saved diff of uncommitted changes). This
also lets one agent flow work across several repositories. It touches snapshots, forks, merges and verification.

## Low

- **Token counting, further**: llama-server `/tokenize` for the openai-compatible adapter (unverified), and calibrating the
  bytes-per-token estimate from the usage of earlier requests for providers with no counting endpoint.

- **Recovery that checks the owner is dead.** A journal that goes quiet is taken for dead after `journalStaleMs`; a suspended
  but living process is only caught by the commit-time ownership check (`RequestSuperseded`), after its work is wasted.
  A `Host` method that says whether a process is alive would let recovery on the same machine wait for it.
- **Journal extras**: keep a copy of the events of failed requests outside the repository for debugging; a `follow`
  helper so a second process can tail a request's journal (nothing reads it live yet); record the digest the adapter
  computed for the request so a recovered OpenAI response can still be chained from.
- **Usage as it arrives** on `openai-compatible`, not only at the end. A stream that dies mid-way reports no tokens,
  which matters only for a hosted Chat Completions provider. The alternative is to report running totals as events and
  let the result differ.
- **More Chat Completions settings**: `tool_choice`, `parallel_tool_calls`, JSON schema output; an `is_error` prefix for
  tool results (the API has no flag, so errors are plain text).
- **Cache and tool options**: mixed cache lifetimes within one request (the docs allow it, longer first: the pinned
  prefix at 1h and the conversation at 5m; OpenAI's per-breakpoint `prompt_cache_breakpoint.ttl`; today one
  `cache_ttl` covers every marker); an Anthropic equivalent of `allowed_tools` for restricting tools without changing the
  prefix; OpenAI standalone compaction (`/responses/compact`) for compacting on demand.
- **Pricing extras**: calibrate the estimate from the last response's real usage; Anthropic's `inference_geo` 1.1x
  multiplier and batch discounts; OpenAI's regional-processing uplift.
- **Provider checks and fixtures**: a live A/B of OpenAI stored (`previous_response_id`) versus stateless replay (cost,
  cached tokens, latency; needs a key); whether OpenAI hosted tools (web search, code interpreter) need server-side
  state; the OpenAI WebSocket continuation cache; record fixtures from `tools/live-check.ts --record` runs against
  Ollama (known caveats: no `cache_control` or `tool_choice`, in-stream errors are unreliable, small models may not call
  tools or reason, so those scenarios skip).
- **A merge's rollup** resolves tables the child pinned only from this conversation's providers and blobs, so a child that
  pinned a table which no longer exists here is counted as unpriced (the safe default: unknown is never zero).
- **Events are in memory.** `onEvent` is delivered after commit, but a crash between commit and delivery loses the event.
  Consumers that must not miss anything should rebuild from history (`index()`, the `recovery` event); an at-least-once
  persisted outbox is possible if needed.
- **Index cache assumption.** A cached index is extended when its tip is an ancestor of HEAD, which for a branch that has
  only ever advanced is also on its first-parent line. A branch reset to a sibling line that still contains the old tip
  would be indexed from a longer `git log`, not wrongly, but a first-parent check would make that explicit.
  `verifyHistory` never uses the cache.
- **Locks across machines.** Locks are files, which is right for one machine and for local-disk worktrees; a network file
  system with weak `link`/`rename` semantics is not supported.
- **A persistent `fast-import` process.** Considered and parked on measurement. An append costs two short git processes
  (stage, commit), about 12 ms; the floor is git's own index and commit work. A long-lived `fast-import` would need
  `checkpoint`/`get-mark` round trips for the hash, would leave the index behind the commit (needing `reset` anyway), and
  would add a process to supervise on every handle. `appendMany` already makes bulk writes constant-cost. Revisit only if
  profiling a real agent loop shows process start-up dominating.
- **Renderers**: verifying a renderer's output at runtime (a self-test with fixed inputs, output hash recorded in the
  setup). Decided: stability is part of the renderer interface contract (an id is immutable, renderers are pure), not
  something the harness defensively checks, at least for now. Revisit if host-supplied renderers cause drift.
- **A VS Code helper** that adds the `!tag` custom tags to settings (`yaml.customTags`).

## Deferred: pricing data

Prices come from external pages and affect no other code. Accuracy matters for the cost shown and for limits, so clean
these up together before release.

- **OpenAI**: the long-context threshold is not stated on the page (272k is assumed, from earlier GPT-5.x models); which
  `service_tier` value selects "Fast" (Priority was renamed Fast on 2026-07-30) is unverified; `gpt-6-luna` has no Ultrafast
  price; `gpt-5.4-mini` and other smaller models are no longer on the page; `chat-latest` (an alias) and the cyber
  (`gpt-5.6-sol`, `gpt-5.6-cyber`) and life-sciences models are left to overrides. The tier-to-table binding is
  confirmed (the page's URL carries `latest-pricing=standard|batch|fast|ultrafast`; our `flex` is the page's "Flex/Batch").
- **Anthropic**: the table came from a summarising read of the pricing page; read it in a browser as was done for OpenAI,
  and add the older models once their API ids are confirmed.
- **Prompt caching prices and multipliers** for Anthropic (lifetimes, write multipliers) are verified together with the
  adapter's request shapes (High).
