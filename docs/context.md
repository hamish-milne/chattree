# Context and tool management: instructions, skills, MCP, injections

How the text and tools in front of the model are managed, and how they change during a conversation without
rewriting the cached prefix. Builds on P10 in providers.md (pinned definitions). Decisions are recorded here as they were agreed.

## 1. Principle

The context is a fold over history on every request, so rebuilding it costs no CPU. What costs money is changing the
bytes of the provider's cached prefix (tools, system, instructions, the early turns). Drift handling is therefore about
which changes can be made as **deltas at the tail** of the conversation instead of edits to the prefix.

## 2. The pieces

- **Static instructions** (done): one pinned text per thread, edited with `/instructions`. The host composes it from layers
  when it sets a thread up (user level, project `AGENTS.md`, thread text); `/instructions reload` takes a new snapshot.
- **Skills**: the Agent Skills layout (a directory with `SKILL.md`, `name` and `description` in the frontmatter, other keys kept as
  metadata), searched in `.agents/skills`, `.chattree/skills` and a user-level directory. The pinned unit is the whole `SKILL.md`.
  A one-line catalog (name and description, length-capped) sits in the prefix after the instructions; a `skill` tool takes a name
  and returns the body as a tool result; `/skill <name>` records the body as a user-side entry. A bundled-files skill gets its
  directory named in the tool result, so `read` and `run` can reach them; a blob-pinned skill has no directory, which is a limit.
- **MCP**: the pinned unit is the server's config (command or URL, never secrets) plus the hash of the tool list it presents.
  Its tools join the registry as `mcp__<server>__<tool>` (so the loop, approvals and limits apply unchanged; asked by default).
  A changed tool list or description is drift the user must accept, which also covers a description swapped after approval.
  Tools only, over stdio and streamable HTTP. Native tools, not a gateway tool (parked: a gateway keeps the prefix stable but
  weakens schema adherence).
- **Injections**: a rule is a pure function of (entries, folded context, config, clock) that returns zero or more `{key, text}`;
  it runs before each request. Each result is **recorded** as an `injection` entry (format 2.4), not generated at request time, so
  the context is identical on every later request, replays exactly, and is costed and audited like any message. A rule's state
  comes from the history ("every N turns" finds the last entry with its key). Sources: config rules in `harness.yml`, built-ins
  (near-limit and context-window warnings, today only shown to the user), and a TypeScript API. Injections cause no drift: their
  output is appended history, and the rules sit outside the transcript like the clock.

## 3. Drift: tail deltas by default

`agent_setup.apply` (format 2.4) is `append` or `rebuild`. The **prefix** is what the model's cached prefix shows for the instructions
and skills; it lags the setup after an `append` until something rewrites it (`AgentSetup.prefix`, folded from the entries).

| Change | Default | How |
|---|---|---|
| Instructions edited | append | The prefix keeps the old text; an "instructions were updated" message with the new text stands where the change was made (after the results of an open turn, like a queued message). |
| Skill added, changed or removed | append (step 3) | A notice at that point; the `skill` tool serves the new body or refuses a removed one. The old catalog line stays until a rebuild. |
| Tools or MCP tool list changed | rebuild | The tools array is in the prefix: a cache break is unavoidable. |
| Model, renderer changed | rebuild | As before. |

Rules, as built:

- **Nothing is cached before the first request**, so a change then goes straight into the prefix and is not appended.
- A change that loses the cache anyway (a model, tool or renderer change, or whatever an adapter calls `cache_break`) also folds any
  lagging instructions into the prefix, for free. A change that keeps the cache (a `max_output_tokens` edit) leaves it lagging.
- **A compaction is a rebuild**: it rewrites the history, so every append before it is folded into the prefix and its notice is dropped.
- `/rebuild` (`Conversation.rebuildPrefix`) folds lagging changes in on request; it is a `cache_break` the user must allow, and does nothing
  when the prefix already shows everything.
- Entries from before 2.4 have no `apply`: one that changes the instructions or skills always rewrote the prefix, and still does.
- A fork inherits the entries, so it inherits the lag. A subagent (fresh context) writes a complete first setup, which is a rebuild.
- Adapters classify an append as if the instructions had not changed, so it needs no flags; a rebuild is classified as before.

## 4. Build order and status

1. **Format 2.4 and the append/rebuild fold. Done.** `agent_setup.apply`, `injection` entries (`Conversation.inject`), `AgentSetup.prefix`,
   `pendingAppends`, `rebasesPrefix`, `hasRequested`, `loadDefinitions().prefixInstructions`, the builder's `instructionUpdates`, renderer methods
   `instructionsUpdated` and `injection`, `Conversation.rebuildPrefix`, `/rebuild`. Injection entries are skipped when reading what a thread is
   waiting for, like approvals. Skills are not yet appendable (their catalog is not shown), so a skills change is a rebuild for now.
2. **Injection framework**: the hook API, config rules, the near-limit built-in. Can run in parallel with 3.
3. **Skills**: loader, catalog, `skill` tool, `/skill`, following on-disk changes (a per-kind policy, `auto` or `ask`, so skills can follow the
   disk while instruction edits still ask).
4. **MCP**: client, registry integration, pinning, approvals.
