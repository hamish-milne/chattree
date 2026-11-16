import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { runLiveChecks } from "../../tools/live-check.ts";
import { scenarios } from "../../tools/vision-scenarios.ts";
import { FakeServer, type Reply, type Seen } from "../support/fake-server.ts";

const have = spawnSync("ffmpeg", ["-version"]).status === 0;
const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ id: "c1", model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const say = (t: string): Reply => ({ acts: [chunk({ content: t }), chunk({}, "stop"), `data: ${JSON.stringify({ id: "c1", model: "fake", choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`, "data: [DONE]\n\n"] });
const expected = (seed: number, n: number): string[] => scenarios({ kinds: ["shape"], count: n, seed }).map((s) => s.expected);

/** A pretend model that can see: it answers each picture it is sent, in order, with what the scenario made it hold. */
function sighted(answers: string[], opts: { blind?: boolean } = {}) {
  let n = 0;
  return (_n: number, seen: Seen): Reply => {
    const body = JSON.parse(seen.body) as { messages: { role: string; content?: unknown }[]; tools?: unknown[] };
    const all = JSON.stringify(body.messages);
    if (all.includes("image_url")) {
      if (opts.blind === true) return { status: 400, acts: [JSON.stringify({ error: { message: "image input is not supported by this model", type: "invalid_request_error" } })] };
      return say(answers[n++] ?? "nothing");
    }
    if (body.tools !== undefined && !all.includes('"role":"tool"')) return { acts: [chunk({ tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "show_picture", arguments: "{}" } }] }), chunk({}, "tool_calls"), "data: [DONE]\n\n"] };
    return say("pong");
  };
}
const run = async (script: ReturnType<typeof sighted>, only: string[]) => {
  const server = await FakeServer.start(script);
  try {
    return Object.fromEntries((await runLiveChecks({ flavor: "openai-compatible", baseUrl: `${server.url}/v1`, model: "fake", only })).map((r) => [r.name, r]));
  } finally {
    await server.close();
  }
};

describe("live-check picture scenarios", () => {
  test("vision passes for a model that reads the pictures", async () => {
    const r = await run(sighted(expected(11, 3)), ["vision"]);
    assert.equal(r["vision"]?.status, "pass", r["vision"]?.detail);
    assert.match(r["vision"]?.detail ?? "", /^3\/3 right/);
  });

  test("vision fails for a model that answers wrongly, and skips for one that takes no pictures", async () => {
    assert.equal((await run(sighted(["nothing", "nothing", "nothing"]), ["vision"]))["vision"]?.status, "fail");
    assert.equal((await run(sighted([], { blind: true }), ["vision"]))["vision"]?.status, "skip");
  });

  test("tool-result-picture sends the picture after the tool call", async () => {
    const r = await run(sighted(expected(13, 1)), ["tool-result-picture"]);
    assert.equal(r["tool-result-picture"]?.status, "pass", r["tool-result-picture"]?.detail);
  });

  test("vision-convert makes a BMP of the picture and the sink gets a PNG", { skip: !have && "no ffmpeg" }, async () => {
    const r = await run(sighted(expected(12, 2)), ["vision-convert"]);
    assert.equal(r["vision-convert"]?.status, "pass", r["vision-convert"]?.detail);
    assert.match(r["vision-convert"]?.detail ?? "", /image\/bmp -> image\/png/);
  });
});
