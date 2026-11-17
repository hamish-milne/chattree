# ADR 33: Dialects: our own prompt rendering and parsing for local models

Status: accepted

## Context

A server's chat template decides what a local model sees and how its tool calls and reasoning are read back. Templates differ, are sometimes wrong for tools, and drop reasoning between calls, which decided some bench tasks.

## Decision

A thread's model settings may name a *dialect* (`dialect`, with `dialect_options`) (`providers/dialects/`): a narrow component that renders a folded `ModelContext` into one raw prompt string and parses the text the model writes back into blocks and stream events. The server only runs the model on that string through llama-server's `/completion`. By default a model keeps the server's chat path (`--jinja`, its own or a patched template). `chattree init` pins `dialect: gemma` for a Gemma model and `replay_reasoning: "turn"` for other local models.

## Why

Measured with `tools/dialect-bench.ts` (10 samples per task and arm): on gpt-oss-20b and Qwen3.5-9B our dialect was shorter, faster and as often right as the template, and better than the template with reasoning replay on gpt-oss. Reasoning sent back between calls decided some tasks (a Gemma task went from 1/10 with the template to 10/10 with reasoning replayed). Owning the prompt also makes what the model saw part of our history.

## Notes

A dialect is below the *renderer* (`harness/renderer.ts`), which turns entries with no provider equivalent into text; a dialect receives turns that are already text and blocks. gpt-oss and Qwen keep the chat path with replay until a longer run on pinned settings says a dialect should be their default.
