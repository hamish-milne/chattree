/**
 * Record one real provider response as a test fixture.
 *
 *   node tools/record-fixture.ts request.json out.fixture.json
 *
 * `request.json`: { "url": "...", "method": "POST", "headers": { "x-api-key": "${ANTHROPIC_API_KEY}" }, "body": { ... } }
 * `${NAME}` is replaced from the environment, and every value substituted this way is scrubbed from the
 * fixture, along with headers that identify the account or request. Read the fixture before committing it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { recordingFetch, type Fixture } from "../providers/fixtures.ts";

export interface RecordSpec {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Expand `${NAME}` from `env`; returns the text and the values that were substituted (the secrets). */
export function expand(text: string, env: Record<string, string | undefined>): { text: string; secrets: string[] } {
  const secrets: string[] = [];
  const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") throw new Error(`the environment variable ${name} is not set`);
    secrets.push(v);
    return v;
  });
  return { text: out, secrets };
}

export async function record(spec: RecordSpec, env: Record<string, string | undefined>, doFetch: typeof fetch = fetch): Promise<Fixture> {
  const { text, secrets } = expand(JSON.stringify(spec), env);
  const expanded = JSON.parse(text) as RecordSpec;
  let captured: Fixture | undefined;
  const wrapped = recordingFetch(doFetch, (f) => void (captured = f), secrets);
  const res = await wrapped(expanded.url, {
    method: expanded.method ?? "POST",
    headers: expanded.headers ?? {},
    ...(expanded.body === undefined ? {} : { body: typeof expanded.body === "string" ? expanded.body : JSON.stringify(expanded.body) }),
  });
  await res.arrayBuffer(); // read it all, so the recorder sees the end
  for (let i = 0; i < 100 && captured === undefined; i++) await new Promise((r) => setTimeout(r, 10));
  if (captured === undefined) throw new Error("the response was not recorded");
  return captured;
}

if (import.meta.main) {
  const [specPath, outPath] = process.argv.slice(2);
  if (specPath === undefined || outPath === undefined) {
    console.error("usage: node tools/record-fixture.ts request.json out.fixture.json");
    process.exit(2);
  }
  const fixture = await record(JSON.parse(await readFile(specPath, "utf8")) as RecordSpec, process.env);
  await writeFile(outPath, JSON.stringify(fixture, null, 2) + "\n");
  console.error(`recorded ${fixture.response.status}, ${fixture.response.body.length} characters, to ${outPath}`);
}
