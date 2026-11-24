// Run in a child process by `exec-suite.ts`: reads {source, entry, tests, timeout} as JSON on stdin, runs the tests against the source in a fresh
// context (which has the language's own objects and nothing else: no process, no require, no fetch) and writes one line of JSON.
import vm from "node:vm";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const p = JSON.parse(input);

const code =
  "(function () {\n" +
  p.source +
  "\n;const __t = " +
  p.tests +
  ";const __o = [];" +
  "for (const a of __t) { try { const r = " +
  p.entry +
  '(...a); __o.push(JSON.stringify(r) ?? "undefined"); } catch (e) { __o.push("throws " + (e && e.name)); } }' +
  "return JSON.stringify(__o);})()";

const say = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
let script;
try {
  script = new vm.Script(code);
} catch (e) {
  say({ kind: "syntax", message: String(e?.message) });
  process.exit(0);
}
try {
  say({ kind: "ok", results: JSON.parse(script.runInNewContext({}, { timeout: p.timeout })) });
} catch (e) {
  say(e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? { kind: "timeout" } : { kind: "crash", message: String(e?.message) });
}
