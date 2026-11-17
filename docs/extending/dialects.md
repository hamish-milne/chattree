# Dialects

A dialect replaces a server's chat template for one local model: it renders the conversation into a single prompt string and parses the text the model writes back into reasoning, text and tool calls. The server only runs the model on the string, through llama-server's `/completion`. Use one when a model's own template mishandles tools or drops reasoning between calls. The built-in dialects are in `providers/dialects/`; the interface is in `providers/dialect.ts`.

A dialect is not a *renderer* (`harness/renderer.ts`), which turns entries that have no provider equivalent (a compaction, a fork's result) into text. A dialect works below that, on turns that are already text and blocks.

## The contract

```ts
interface Dialect {
  id: string;                                  // recorded in the setup; never changes meaning once released
  render(input): { prompt: string; stop: string[] };
  parser(options, tools, prompt): Parser;      // push(text) -> events, end(why) -> blocks and stop reason
  markers?: readonly string[];                 // special tokens the parser looks for, as text
}
```

- `render` receives the folded context (turns, tools, system text), the model's info and the dialect options, and returns the prompt and the stop strings. It must be deterministic: the same context renders the same bytes, because prompt caching depends on it.
- `parser` is given the text as it streams and says what it has seen (`text`, `reasoning`, `call.start`, `call.args`, `call.end`). If a tool call cannot be read without guessing, it reports an error and the call is kept as the model wrote it, so the model is told. The prompt tells it whether the model starts inside its thinking.
- `markers` matter when a server gives a special token no text: the transport finds the token ids with `/tokenize` and puts the text back.
- The `id` is how a thread's model settings name the dialect (`dialect: harmony`), and an id must always mean the same dialect: a change in behaviour is a new id.

## Registering and choosing

Built-in dialects are listed in `providers/dialects/index.ts` and registered by the local-model provider. A thread's model settings name one (`dialect`, with `dialect_options`), for example `/set dialect harmony`; because it is part of the agent setup, history records what was used, and changing it is a cache break. `chattree init` pins `dialect: gemma` for Gemma models.

## Testing and measuring

Unit-test `render` and `parser` against recorded model output, with the text split at arbitrary points (a parser must not depend on how the stream was chunked). To compare a dialect with the server's template on a real model, use `tools/dialect-bench.ts` and `tools/template-compare.ts`, which the user runs and reports on.
