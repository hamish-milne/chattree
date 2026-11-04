# Dependencies

What the project depends on, why, and the policy for keeping it current. Reviewed 2026-11-04; every package was used and current.

## Packages

| Package | Kind | Why it is here | Decision |
|---|---|---|---|
| `zod` | runtime | Schemas for the config, the transcript entries, every provider's wire format and the CLI session; the codecs speak Standard Schema | Keep. Was misfiled under `devDependencies`; fixed |
| `ajv`, `ajv-formats` | runtime | Validates tool arguments against the full JSON Schema a tool declares (`harness/tool-schema.ts`) | Keep. Zod cannot take an arbitrary schema from an MCP server |
| `yaml` | runtime | Reads `harness.yml` and edits it with comments kept (`src/config.ts`) | Keep. No other YAML library keeps comments on edit |
| `typescript` | dev | Typecheck only; Node runs the `.ts` files directly | Keep |
| `@types/node` | dev | Node types for the tests | Stay on the major of the lowest supported Node (22, see `engines`); Dependabot ignores its major bumps |

## Policy

- **Package manager:** pnpm, pinned by `packageManager` in `package.json`. CI reads the version from there.
- **Lockfile:** `pnpm-lock.yaml` is committed and CI installs with `--frozen-lockfile`.
- **Node:** `engines` is `>=22.18` (the first release that runs TypeScript without a flag). CI tests Node 22 on Ubuntu and Windows.
- **Updates:** Dependabot (`.github/dependabot.yml`) proposes npm and GitHub Actions updates weekly; development dependencies are grouped.
- **GitHub Actions:** referenced by major tag (`@v6`). The install steps live in one composite action, `.github/actions/setup`, so a bump is one edit.
- **Adding a dependency:** say here what it does that the platform or an existing dependency cannot.
