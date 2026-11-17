# ADR 14: Anything that costs money or breaks a cache changes through an explicit mutation

Status: accepted

## Context

A model switch, a tool change or an instruction edit can multiply cost or discard a provider's cached prefix.

## Decision

`Conversation.setupChange(change, { allow })` classifies what a change would do through the adapter (`model_changed`, `cache_break`, `cost_increase`, `context_overflow`, `reasoning_dropped`, `capability_loss`, `mid_loop`, `tools_changed`, `instructions_changed`, `pricing_changed`, ...). Any kind not in `allow` throws `ChangeNotAllowed { changes, allowWith }`; the host asks the user and retries with the accepted flags, which are recorded in the entry. A limit is a limit: a host that wants to bypass one edits the configuration.

## Why

Classification differs per provider and model, so it belongs to the adapter. A thrown error that says what and why lets any host (CLI, UI) build its own dialog.

## Notes

Provider-observed changes (the response reports another model or tier) are facts: `agent_setup` with `reason: provider` is written before the `assistant` entry in one `appendMany`, and the next request is gated until the change is acknowledged. Aliases are pinned: the first response's resolved model id is written (`reason: resolved`) and sent from then on.
