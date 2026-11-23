/**
 * The smoke test of the extension in a real VS Code (wdio-vscode-service downloads the editor and its driver on first run and
 * caches them). It opens a folder that holds a conversation, shows the two views and checks they draw what the real controller
 * sent; then a git repository with no conversation, for the quick start (ADR 40), and the same repository moved and renamed. It needs
 * `CHATTREE_E2E_NO_SANDBOX=1` as root, and no agent proxy variables in the environment. `pnpm --filter chattree-vscode test:e2e`; CI runs it under xvfb. Not part of `pnpm test`: it needs the download.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");

// A folder with a conversation and no provider yet: the chat's banner asks for one. Settings go in a file of their own, so the
// run never reads or writes the machine's.
// The config is evaluated again in every worker, so what it makes is made once, and the workers find it through the environment.
const first = process.env["CHATTREE_E2E_SCRATCH"] === undefined;
const scratch = process.env["CHATTREE_E2E_SCRATCH"] ?? mkdtempSync(join(tmpdir(), "chattree-vscode-"));
process.env["CHATTREE_E2E_SCRATCH"] = scratch;
const folder = join(scratch, "project");
const settings = join(scratch, "settings.yml");
process.env["CHATTREE_SETTINGS"] = settings;
process.env["CHATTREE_ENVIRONMENT"] = "off";
process.env["CHATTREE_DATA"] = join(scratch, "data");

// A git repository with no conversation, for the quick start: its conversation is made in the run's own data directory, and the
// repository is then moved, so the third session opens it at a new path (`beforeSession` below, which runs before the editor starts).
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "inherit" });
export const quickStartFolder = join(scratch, "work", "code-repo");
export const movedFolder = join(scratch, "moved", "renamed-repo");

if (first) {
  mkdirSync(folder);
  execFileSync(process.execPath, ["--no-warnings", join(repo, "cli", "chattree.ts"), "init", folder, "--provider", "none"], {
    stdio: "inherit",
    env: process.env,
  });
  mkdirSync(quickStartFolder, { recursive: true });
  git(quickStartFolder, "init", "-b", "main");
  writeFileSync(join(quickStartFolder, "a.txt"), "one\n");
  git(quickStartFolder, "add", ".");
  git(quickStartFolder, "commit", "-m", "first");
}

// An editor run as root (a container) needs the sandbox off.
const vscodeArgs = process.env["CHATTREE_E2E_NO_SANDBOX"] === undefined ? {} : { vscodeArgs: { "no-sandbox": true, "disable-gpu": true } };
const userSettings = { "window.dialogStyle": "custom", "workbench.startupEditor": "none", "security.workspace.trust.enabled": false };

export const config = {
  runner: "local",
  maxInstances: 1,
  capabilities: [
    {
      browserName: "vscode",
      browserVersion: "stable",
      specs: [join(root, "e2e", "smoke.test.mts")],
      "wdio:vscodeOptions": { extensionPath: root, workspacePath: folder, userSettings, ...vscodeArgs },
    },
    {
      browserName: "vscode",
      browserVersion: "stable",
      specs: [join(root, "e2e", "quick-start.test.mts")],
      "wdio:vscodeOptions": { extensionPath: root, workspacePath: quickStartFolder, userSettings, ...vscodeArgs },
    },
    {
      browserName: "vscode",
      browserVersion: "stable",
      specs: [join(root, "e2e", "quick-start-moved.test.mts")],
      "wdio:vscodeOptions": { extensionPath: root, workspacePath: movedFolder, userSettings, ...vscodeArgs },
    },
  ],
  services: ["vscode"],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 120_000 },
  logLevel: "warn",
  // The third session opens the repository the second one started a conversation for, after it has been moved and renamed.
  beforeSession(_config: unknown, _caps: unknown, specs: string[]) {
    if (specs.some((f) => f.endsWith("quick-start-moved.test.mts")) && existsSync(quickStartFolder) && !existsSync(movedFolder)) {
      mkdirSync(dirname(movedFolder), { recursive: true });
      renameSync(quickStartFolder, movedFolder);
    }
  },
};
