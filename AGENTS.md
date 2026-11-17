# Agent instructions

chattree is a model-neutral agent harness whose conversation history lives in Git (TypeScript, Node 22.18+, run directly with no build step).

Read these before changing anything:

- [docs/map/index.md](docs/map/index.md): how the project is put together, where each thing lives, and which files to change to implement a feature. One page per subsystem.
- [docs/conventions.md](docs/conventions.md): how to work here (process, code rules, tests, comments, docs). Follow it.

Look up when relevant:

- [docs/adr/](docs/adr/README.md): the decisions already made and why. Check before reversing or re-deciding something.
- [docs/parking-lot.md](docs/parking-lot.md): what was deliberately left out, with a first step for each.
- [docs/guide/](docs/guide/README.md) and [docs/extending/](docs/extending/README.md): the user and extension guides. Update them when behaviour they describe changes.

The gates before any commit: `npm run typecheck`, `pnpm format:check`, `pnpm lint`, `npm test`.
