/**
 * Runs the completions probe (`probe/`) in a real VS Code and writes what it found to `$CHATTREE_PROBE_DIR` (default `probe-runs/<time>` here):
 * `report.json`, the probe's own log and a screenshot per mode. It is a question put to the editor, not a test of chattree, so it is not in CI.
 *
 *   CHATTREE_E2E_NO_SANDBOX=1 env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy -u NODE_USE_ENV_PROXY \
 *     xvfb-run -a pnpm probe:inline        (the first two are for running as root, behind an agent proxy)
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const first = process.env["CHATTREE_PROBE_SCRATCH"] === undefined;
const scratch = process.env["CHATTREE_PROBE_SCRATCH"] ?? mkdtempSync(join(tmpdir(), "chattree-probe-"));
process.env["CHATTREE_PROBE_SCRATCH"] = scratch;
const out = process.env["CHATTREE_PROBE_DIR"] ?? join(root, "probe-runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
process.env["CHATTREE_PROBE_DIR"] = out;
process.env["CHATTREE_PROBE_OUT"] = join(out, "probe-log.json");
export const folder = join(scratch, "project");
if (first) {
  mkdirSync(folder, { recursive: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(folder, "probe.txt"), "first line of the file\nsecond line\nhello");
}

const stableOnly = process.env["CHATTREE_PROBE_PROPOSED"] === "0";
// The proposed API is only given to an extension that is named in `--enable-proposed-api`; `CHATTREE_PROBE_PROPOSED=0` leaves it out, to see what the editor does without.
const proposed = stableOnly ? {} : { "enable-proposed-api": "chattree-probe.completions-probe" };
// Without the proposal: the same extension with the proposal taken out of its manifest, as one in the Marketplace would have to be.
const extensionPath = join(scratch, "probe-stable");
if (first && stableOnly) {
  mkdirSync(extensionPath, { recursive: true });
  const parsed: unknown = JSON.parse(readFileSync(join(root, "probe", "package.json"), "utf8"));
  const { enabledApiProposals: _proposals, ...rest } =
    typeof parsed === "object" && parsed !== null ? { enabledApiProposals: undefined, ...parsed } : {};
  writeFileSync(join(extensionPath, "package.json"), JSON.stringify({ ...rest, main: "./extension.js" }, null, 2));
  copyFileSync(join(root, "probe", "dist", "extension.js"), join(extensionPath, "extension.js"));
}

const vscodeArgs = {
  vscodeArgs: { ...proposed, ...(process.env["CHATTREE_E2E_NO_SANDBOX"] === undefined ? {} : { "no-sandbox": true, "disable-gpu": true }) },
};
const userSettings = {
  "window.dialogStyle": "custom",
  "workbench.startupEditor": "none",
  "security.workspace.trust.enabled": false,
  "editor.inlineSuggest.enabled": true,
};

export const config = {
  runner: "local",
  maxInstances: 1,
  capabilities: [
    {
      browserName: "vscode",
      browserVersion: "stable",
      specs: [join(root, "e2e", "probe.test.mts")],
      "wdio:vscodeOptions": {
        extensionPath: stableOnly ? extensionPath : join(root, "probe"),
        workspacePath: folder,
        userSettings,
        ...vscodeArgs,
      },
    },
  ],
  services: ["vscode"],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 240_000 },
  logLevel: "warn",
};
