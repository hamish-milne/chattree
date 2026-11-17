# ADR 13: The transcript holds the agent's state; `harness.yml` holds only the outside world

Status: accepted

## Context

A conversation can change model, tools and instructions over time, and forks and subagents need to know what each branch was.

## Decision

What the agent is (model, settings, tools, instructions, skills, MCP, the price table it is costed under) is the fold of `agent_setup` entries on its branch. `harness.yml` holds the machine setup (providers, environment variable names, host wiring) and the harness's disposition (limits, approvals). Its history is its Git history. There is no `config_changed` entry.

## Why

The state must be reproducible from history at any commit, and a fork inherits the folded setup without needing an entry. A subagent has a fresh context and writes its own complete first `agent_setup`.

## Notes

Sections of `agent_setup` are optional deltas (`set`/`remove` for maps); the first entry of a flow is complete. `assistant` entries are slim: the model settings are not repeated per entry.
