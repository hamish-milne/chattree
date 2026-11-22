# chattree

A model-neutral agent harness whose conversation history lives in Git. You talk to a model (hosted, or running on your own machine); it can read and edit files and run commands in a workspace; every message, tool call and result is a commit you can inspect, rewind, fork and merge.

```
pnpm install
pnpm chattree init        # start a conversation in this directory
pnpm chattree chat        # talk
```

Needs Node 22.18 or later (it runs the TypeScript directly, with no build step) and Git 2.40 or later.

## Documentation

| For | Start at |
|---|---|
| Using chattree | [docs/guide/](docs/guide/README.md): what it offers, getting started, commands, configuration |
| Adding an adapter, tool, skill or dialect | [docs/extending/](docs/extending/README.md) |
| Working on chattree itself | [docs/map/index.md](docs/map/index.md) (where everything is), [docs/conventions.md](docs/conventions.md) (how to change it), [docs/adr/](docs/adr/README.md) (why it is this way) |
| What is deliberately not done yet | [docs/parking-lot.md](docs/parking-lot.md) |

Coding agents: read [AGENTS.md](AGENTS.md).

## Development

```
pnpm test          # the quick group (about 5 minutes), one process per test file
pnpm test:slow     # the [slow] suites: exhaustive crash injection, random operations
pnpm test:perf     # timing of the views with a long conversation (run alone; needs Chromium)
pnpm test:all      # both
pnpm typecheck     # src is checked with no Node types; the rest with @types/node
pnpm lint          # oxlint, type-aware
pnpm format        # oxfmt (format:check to verify)
```

## License

MIT, see [LICENSE](./LICENSE).
