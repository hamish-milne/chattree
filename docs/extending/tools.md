# Tools

A tool is something the model can ask the harness to do: read a file, run a command, search the history, call an MCP server. A tool is a *definition* the model sees plus an `execute` function the harness runs. The loop that calls tools is `harness/loop.ts`; the tool type is in `harness/tools.ts`; the built-in file and command tools are in `harness/starter/`.

## The shape of a tool

```ts
interface Tool {
  definition: ToolDefinition;       // name, description, input_schema (JSON Schema for an object)
  execute(args, ctx): Promise<ToolOutput | StartedJob>;
  // optional behaviour:
  timeout?, normalize?, allowKeys?, covers?, validateKey?, background?, resumable?, waitingOn?
}
```

- **Definition.** `name` is letters, digits, `_` and `-`, starting with a letter, at most 64 characters, and unique in the registry. `description` is required and is what the model reads to decide when to call the tool, so say what it does, when to use it, and what it returns. `input_schema` is a JSON Schema object; the harness checks every call's arguments against it before `execute` runs, so `execute` receives arguments that already fit. A schema the validator cannot use (an unresolved `$ref`, a bad `pattern`) is refused when you register the tool.
- **`execute(args, ctx)`** returns a `ToolOutput`: `content` (text for the model), optionally `is_error`, and `media` (images, sound or documents, for models that can take them). `ctx` gives the host and workspace, the thread, an abort signal, and the blob store. Respect the abort signal: stopping a call must stop its work.
- **Errors.** A failure the model can act on (a missing file, a bad path) is an `is_error` output with a message that says what and why. Throw only for a bug; a throw becomes an error result too, but it hides the reason from the model.
- **Pure and stateless.** Anything a tool must remember between calls belongs in the workspace or the transcript, not in module state, because threads fork and processes restart.
- **Never trust arguments beyond the schema.** Paths go through `resolveInWorkspace` (`harness/starter/workspace.ts`), which refuses anything outside the workspace.

## Approvals

Calls ask the user before they run unless an approval covers them. A tool controls this with three optional functions:

- `allowKeys(args, ctx)` returns the keys a grant for this call would add to the tool's `allow` map in `harness.yml` (for example a command name). Return `null` (the default) when a call can only be allowed once.
- `covers(keys, args, ctx)` says whether the live keys cover a call. Be conservative: answer `undefined` for anything you cannot be sure of, and never let a stored key widen beyond what `allowKeys` could have offered.
- `validateKey(key)` says why a key someone typed is unusable.

## Background and long-running tools

- `background: true` lets the model start the tool with `background: true` in its arguments (add that property to the schema). `execute` then returns a `StartedJob` at once with a one-line summary, a `done` promise that never rejects, and a `stop()`. The `lease` says how long it may run (it is how long the job holds the thread's run lease); leave it out for a job with no time limit (a server or watcher), which holds no lease and so does not keep the thread busy. Optional too: `name` (what the model called it, shown to the person) and `log`, a `JobLog` the tool fills as it prints (`ctx.output(channel, text)` is the tool's way to write to it): the jobs popup shows it live, and `job_output` reads it while the job runs. The result arrives as a `job_event` entry.
- `timeout(args)` sets the seconds a call may take (default `limits.max_tool_seconds`).
- `resumable: true` says a call that was interrupted by a crash may be executed again when the loop restarts, instead of being answered "did not run". Only do this if `execute` can find what its first run did from the call id.

## Registering a tool

Put tools in a `ToolRegistry` (`registry.add(tool)`; it validates the definition and refuses duplicates). The CLI and the extension build their registry in `app/toolset.ts` (`buildToolSet`), which is where a new built-in tool is added to the list, together with its entry in the tool set's configuration if it needs one. The definitions are pinned into the thread's `agent_setup` by hash, so changing a tool's description or schema is a visible change to the thread (and breaks the provider's prompt cache).

## Testing

Test `execute` directly with a temporary workspace and the Node host (`test/support/hosts.ts`), and the loop behaviour with the toy adapter (`test/support/toy-adapter.ts`). Cover the error paths the model will meet, and abort during a call. See `test/harness/` for tests of the built-in tools.
