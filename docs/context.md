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
- **Skills** (done): the Agent Skills layout (a directory with `SKILL.md`, `name` and `description` in the frontmatter, other keys kept as
  metadata), searched in the user's directory (`CHATTREE_SKILLS_DIR`, else `chattree/skills` under the config directory), then `.agents/skills`
  and `.chattree/skills` of the project root; a later one wins a name, so a project's skill replaces the user's. The pinned unit is the whole
  `SKILL.md`: a value `{name, description, body, meta?, dir?}` in canonical JSON, kind `skill`, blob-stored, so the hash covers the body, the description and
  the directory. A one-line catalog (name and description, one line each, at most 50 lines of at most 200 characters) follows the instructions
  in the prefix. It lists what the *prefix* shows (`AgentSetup.prefix.skills`), not the current setup, and only when the `skill` tool is pinned
  (a catalog of what the model cannot read would only mislead). The `skill` tool takes a name and returns the body as a tool result, from the
  current setup; `/skill <name> [what to do]` records the body as a user message and runs a request; `/skills` lists them. A skill from a directory
  has the directory in the result, so `read` and `run` can reach bundled files (`read` cannot open `.chattree/` or paths outside the workspace);
  a skill with no directory has no bundled files, which is a limit. The loader treats a skill as untrusted data: it reads at most 64 KiB, a link
  that leaves the skill's directory is not followed, frontmatter is bounded and parsed with the config rules (no anchors, aliases or tags), the
  name must be lowercase letters, digits and hyphens and equal its directory name, and a skill that fails any of this is skipped and reported,
  never a failed scan.
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
| Skill added, changed or removed | append | A notice at that point lists what was added and changed (name and description) and what was removed; the `skill` tool serves the new body and refuses a removed one. The old catalog line stays until a rebuild. |
| Tools or MCP tool list changed | rebuild | The tools array is in the prefix: a cache break is unavoidable. |
| Model, renderer changed | rebuild | As before. |

Rules, as built:

- **Nothing is cached before the first request**, so a change then goes straight into the prefix and is not appended.
- A change that loses the cache anyway (a model, tool or renderer change, or whatever an adapter calls `cache_break`) also folds any
  lagging instructions and skills into the prefix, for free. A change that keeps the cache (a `max_output_tokens` edit) leaves it lagging.
- **A compaction is a rebuild**: it rewrites the history, so every append before it is folded into the prefix and its notice is dropped.
- `/rebuild` (`Conversation.rebuildPrefix`) folds lagging changes in on request; it is a `cache_break` the user must allow, and does nothing
  when the prefix already shows everything.
- A change to nothing but instructions and skills is an append whatever mix it is; a skills difference is classified as `instructions_changed` (the
  catalog rides with the instructions in the prefix), MCP stays `tools_changed`.
- Entries from before 2.4 have no `apply`: one that changes the instructions or skills always rewrote the prefix, and still does.
- A fork inherits the entries, so it inherits the lag. A subagent (fresh context) writes a complete first setup, which is a rebuild.
- Adapters classify an append as if the instructions had not changed, so it needs no flags; a rebuild is classified as before.

## 4. Build order and status

1. **Format 2.4 and the append/rebuild fold. Done.** `agent_setup.apply`, `injection` entries (`Conversation.inject`), `AgentSetup.prefix`,
   `pendingAppends`, `rebasesPrefix`, `hasRequested`, `loadDefinitions().prefixInstructions`, the builder's `instructionUpdates`, renderer methods
   `instructionsUpdated` and `injection`, `Conversation.rebuildPrefix`, `/rebuild`. Injection entries are skipped when reading what a thread is
   waiting for, like approvals.
2. **Injection framework**: the hook API, config rules, the near-limit built-in. Can run in parallel with 3.
3. **Skills. Done.** `harness/skills.ts` (loader, pinned value, drift, `syncSkills`, catalog, notices), `harness/skill-tool.ts`, renderer methods `skillCatalog` and
   `skillsUpdated`, the builder's `skillUpdates`, `/skills` and `/skill`. Skills are appendable like instructions (an entry changing both is one append).
   Following the disk is a per-kind policy in `harness.yml`: `skills: { follow: ask | auto | off }` (default `ask`): `ask` reports `N skills changed on disk` once
   (and in the status line) and `/skills sync` takes it, `auto` records an `append` at the start of the next request, `off` never looks. Instructions edits still ask.
   Decisions: a removed skill is announced and refused by the tool, and its catalog line stays until `/rebuild`; a skill whose file turns unreadable stays pinned as it
   was (not treated as removed); the catalog placement is the instructions string handed to the builder (`withCatalog`); the first sync is an ordinary change (nothing
   is pinned automatically under `ask`, a new thread must `/skills sync` once). Subagents inherit skills through `copySetupTo`, which now passes `skills` and `mcp` as
   deltas (they were silently dropped before); their tools are pinned by the subagent tool from the child registry, which includes `skill`. Left out: following
   the disk during a running tool loop (it looks at the start of a request), and a host hook for other sources (the loader takes a list of roots).
4. **MCP**: client, registry integration, pinning, approvals.
