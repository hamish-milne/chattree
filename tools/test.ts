/**
 * The test groups, as one portable command (an env var in a package.json script does not work on Windows):
 *   node tools/test.ts          the quick group (what `pnpm test` runs)
 *   node tools/test.ts slow     only the [slow] suites (see test/support/slow.ts)
 *   node tools/test.ts all      both
 */
import { spawnSync } from "node:child_process";

const group = process.argv[2] ?? "quick";
if (!["quick", "slow", "all"].includes(group)) {
  console.error("usage: node tools/test.ts [quick|slow|all]");
  process.exit(2);
}
const args = ["--no-warnings", "--test", ...(group === "slow" ? ["--test-name-pattern=\\[slow\\]"] : []), "test/**/*.test.ts"];
const r = spawnSync(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...(group === "quick" ? {} : { CHATTREE_SLOW: "1" }) } });
process.exit(r.status ?? 1);
