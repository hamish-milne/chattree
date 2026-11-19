/**
 * The smoke test of the extension in a real VS Code (wdio-vscode-service downloads the editor and its driver on first run and
 * caches them). It opens a folder that holds a conversation, shows the two views and checks they draw what the real controller
 * sent. `pnpm --filter chattree-vscode test:e2e`; CI runs it under xvfb. Not part of `pnpm test`: it needs the download.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");

// A folder with a conversation and no provider yet: the chat's banner asks for one. Settings go in a file of their own, so the
// run never reads or writes the machine's.
const scratch = mkdtempSync(join(tmpdir(), "chattree-vscode-"));
const folder = join(scratch, "project");
mkdirSync(folder);
const settings = join(scratch, "settings.yml");
process.env["CHATTREE_SETTINGS"] = settings;
process.env["CHATTREE_ENVIRONMENT"] = "off";
execFileSync(process.execPath, ["--no-warnings", join(repo, "cli", "chattree.ts"), "init", folder, "--provider", "none"], {
  stdio: "inherit",
  env: process.env,
});

export const config = {
  runner: "local",
  specs: [join(root, "e2e", "*.test.mts")],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "vscode",
      browserVersion: "stable",
      "wdio:vscodeOptions": {
        extensionPath: root,
        workspacePath: folder,
        userSettings: { "window.dialogStyle": "custom", "workbench.startupEditor": "none", "security.workspace.trust.enabled": false },
      },
    },
  ],
  services: ["vscode"],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 120_000 },
  logLevel: "warn",
};
