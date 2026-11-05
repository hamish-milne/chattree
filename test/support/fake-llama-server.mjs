// A stand-in for llama-server in router mode, for host tests: reads the preset file, answers the model list, and loads and unloads.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv[i + 1];
};
const preset = arg("--models-preset");
const port = Number(arg("--port"));
const host = arg("--host", "127.0.0.1");
const max = Number(arg("--models-max", "0"));
const exitCode = arg("--fake-exit-code");
const delay = Number(arg("--fake-delay", "0"));
const crashAfter = Number(arg("--fake-crash-after", "0"));

if (exitCode !== undefined) {
  console.error("fake llama-server: boom");
  process.exit(Number(exitCode));
}

let state = new Map();
function readPreset() {
  const names = [...readFileSync(preset, "utf8").matchAll(/^\[([^\]*]+)\]/gm)].map((m) => m[1]);
  const next = new Map();
  for (const n of names) next.set(n, state.get(n) ?? "unloaded");
  state = next;
  console.log(`preset read: ${names.join(",")}`);
}
readPreset();

const list = () => ({ object: "list", data: [...state].map(([id, value]) => ({ id, object: "model", status: { value } })) });
const json = (res, body, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/v1/models") return json(res, list());
  if (req.method === "GET" && url.pathname === "/models") {
    if (url.searchParams.get("reload") === "1") readPreset();
    return json(res, list());
  }
  if (req.method === "POST" && (url.pathname === "/models/load" || url.pathname === "/models/unload")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { model } = JSON.parse(body);
      if (!state.has(model)) return json(res, { error: "no such model" }, 404);
      if (url.pathname === "/models/load") {
        state.set(model, "loaded");
        if (max > 0) {
          const others = [...state].filter(([k, v]) => k !== model && v === "loaded");
          for (const [k] of others.slice(0, Math.max(0, others.length + 1 - max))) state.set(k, "unloaded");
        }
      } else state.set(model, "unloaded");
      console.log(`${url.pathname} ${model}`);
      json(res, { success: true });
    });
    return;
  }
  json(res, { error: "not found" }, 404);
});

setTimeout(() => {
  server.listen(port, host, () => console.log(`listening on ${port}`));
  if (crashAfter > 0) setTimeout(() => process.exit(9), crashAfter);
}, delay);
process.on("SIGTERM", () => process.exit(0));
