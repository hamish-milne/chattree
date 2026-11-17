# Embedding the library

The command line (`cli/`) is one host over the library. A UI, a service or a script can use the same pieces. The public entry point for the core is `src/index.ts` (the transcript codec, schemas and the `Host` seam); the harness modules in `harness/` are what you build a host from.

## What a host does

1. **Open a conversation.** `Conversation.create` / `open` (`harness/conversation.ts`) over a `Host`. A conversation is a git repository; open checks the format version, recovers from a crash and returns a handle for one branch (a thread).
2. **Choose providers.** `defaultRegistry()` in `providers/index.ts`, or a registry with your own adapters; pass it as the `providers` option. Secrets come from a `SecretSource` you supply.
3. **Run a turn.** `harness/loop.ts` runs the tool loop and yields events (the request's stream events, plus `tool.start`, `tool.approval`, `tool.result`). `harness/turn.ts` runs one request and journals it. Your host renders the events.
4. **Answer the questions the library asks.** A change that costs money or breaks a cache throws `ChangeNotAllowed` (show the changes, ask, retry with the accepted `allow` flags). A limit stops a request with `LimitExceeded` (the user edits `harness.yml`). A tool call that needs approval asks through a callback you pass to the loop.
5. **Follow other processes.** Several processes may use one repository: the lock and lease files, the journal and the `watch` events let a host see what others add.

## Where the CLI's own pieces are

`cli/engine.ts` holds a session (tool set, drafts, notices, staged files) with no terminal in it, `cli/commands/` registers the commands, and `cli/terminal.ts` is the only code that reads keys. A UI that wants the same operations can follow that split.

## Stability

The library is at a development stage and its interfaces change. The transcript format is versioned (see the project map); the TypeScript interfaces are not yet.
