# Dependencies

What the project depends on, why, and the policy for keeping it current. Reviewed 2026-11-04; every package was used and current.

## Packages

| Package | Kind | Why it is here | Decision |
|---|---|---|---|
| `typebox` | runtime | The one schema library: JSON Schema builder with type inference, and the validator (`typebox/compile`) behind `src/validate.ts` (settings, `harness.yml`, price tables, provider config and settings, transcript entries, session files) and `harness/tool-schema.ts` (the arguments of any tool, against the JSON Schema it declares) | Added 2026-11-17. Replaced `zod` and `ajv` (with `ajv-formats`), removed the same day |
| `yaml` | runtime | Reads `harness.yml` and edits it with comments kept (`src/config.ts`) | Keep. No other YAML library keeps comments on edit |
| `file-type` | runtime | Tells which media format a file is by its content (`harness/formats.ts`): png, jpeg, webp, wav, mp3, flac, ogg, m4a, bmp, tiff and the rest of the table. Pinned to an exact version; only its result for formats in our table is used, and only the first 8 MiB of a file is given to it | Added 2026-11-14. The platform has nothing; a hand-kept signature table would need the RIFF, `ftyp`, Ogg-codec and MP3-sync refinements it already has. It brings `strtok3`, `token-types`, `uint8array-extras`, `ieee754`, `debug` and `ms` |
| `@preact/signals-core` | runtime | Signals and `createModel` for the UI core's state models (`ui/model/`); DOM-free, so the models run in a webview and in tests. Pinned exact | Added 2026-11-18 (ADR 35). The platform has no reactive state; the models are the view logic and are tested without a browser |
| `preact` | extension | Draws the views (`extensions/vscode/`); about 4 kB in a bundle. Pinned exact | Added 2026-11-18. Transcript and graph are state-heavy; no framework would mean writing a renderer |
| `@preact/signals` | extension | Re-renders a component when a signal it read changes. Pinned exact | Added 2026-11-18. Its own copy of the signals core is the same package as the root's (pnpm shares it); a test checks the bundle has one |
| `marked` | extension | Renders assistant Markdown in the chat. Pinned exact | Added 2026-11-18. Output will be sanitised and shown under a strict content security policy. Used by `webview/markdown.tsx` |
| `esbuild` | extension, dev | Bundles webviews and the extension; its install script is not run (`allowBuilds` in `pnpm-workspace.yaml`), the launcher works without it. Pinned exact | Added 2026-11-18. A VSIX has to be bundled; Node cannot run `.tsx` |
| `@types/vscode` | extension, dev | Types for the VS Code extension API. Pinned exact | Added 2026-11-18. Types only. Not yet used |
| `typescript` | dev | Typecheck only; Node runs the `.ts` files directly | Keep |
| `@types/node` | dev | Node types for the tests | Stay on the major of the lowest supported Node (22, see `engines`); Dependabot ignores its major bumps |

## Policy

- **Package manager:** pnpm, pinned by `packageManager` in `package.json` (12.18.0 since 2026-11-14; a workspace that was set up with a different major refuses to link, so reinstall with `pnpm install` after a change). CI reads the version from there. pnpm 12 refuses a package published less than a day ago (`minimumReleaseAge`): resolve with pnpm 12 itself, as a lockfile made by an older pnpm can hold such a version.
- **Lockfile:** `pnpm-lock.yaml` is committed and CI installs with `--frozen-lockfile`.
- **Node:** `engines` is `>=22.18` (the first release that runs TypeScript without a flag). CI tests Node 22 on Ubuntu and Windows.
- **Updates:** Dependabot (`.github/dependabot.yml`) proposes npm and GitHub Actions updates weekly; development dependencies are grouped.
- **GitHub Actions:** referenced by major tag (`@v6`). The install steps live in one composite action, `.github/actions/setup`, so a bump is one edit.
- **Adding a dependency:** say here what it does that the platform or an existing dependency cannot.
