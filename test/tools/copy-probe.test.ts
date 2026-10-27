import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Completed, ProviderAdapter } from "../../providers/types.ts";
import { distance, formatProbeReport, judge, makeItems, nonAscii, parseProbeArgs, place, runProbe, type NativeChat } from "../../tools/copy-probe.ts";

const usage = { input_tokens: 1, output_tokens: 1 };
const reply = (blocks: Completed["blocks"], stop = "end_turn"): Completed => ({ blocks, stop_reason: stop, usage, observed: { model: "m" }, ext: {} });

describe("judging a copy", () => {
  test("distance counts single edits", () => {
    assert.equal(distance("PELICAN", "PELICAN"), 0);
    assert.equal(distance("PELICAN", "PELIPCAN"), 1);
    assert.equal(distance("abc", ""), 3);
    assert.equal(distance("kitten", "sitting"), 3);
  });

  test("exact is the whole string as a token; a typo within two edits is near; a case change is near; anything else is other", () => {
    assert.deepEqual(judge("PELICAN", "PELICAN"), { kind: "exact" });
    assert.deepEqual(judge("The code word is `PELICAN`.", "PELICAN"), { kind: "exact" });
    assert.deepEqual(judge("PELIPCAN  \n", "PELICAN"), { kind: "near", got: "PELIPCAN", distance: 1 });
    assert.deepEqual(judge("pelican", "PELICAN"), { kind: "near", got: "pelican", distance: 1 });
    assert.deepEqual(judge("1f08cd1", "1f08cd1f"), { kind: "near", got: "1f08cd1", distance: 1 });
    assert.deepEqual(judge("I could not find it.", "PELICAN"), { kind: "other" });
    assert.deepEqual(judge("", "PELICAN"), { kind: "other" });
  });

  test("invisible characters inside the string are a verdict of their own, with the code points; elsewhere they are only listed", () => {
    // The two answers found in the logs: PEL, ZWSP, IC, ZWSP, AN, space, 4417 and PEL, ZWSP, ICAN, NBSP, 4417.
    const a15 = Buffer.from("50454CE2808B4943E2808B414E20343431 37".replace(" ", ""), "hex").toString("utf8");
    const a18 = Buffer.from("50454CE2808B4943414EC2A0 34343137".replace(" ", ""), "hex").toString("utf8");
    assert.deepEqual(judge(a15, "PELICAN"), { kind: "hidden", chars: ["U+200B"] });
    assert.deepEqual(judge(a18, "PELICAN"), { kind: "hidden", chars: ["U+200B", "U+00A0"] });
    assert.deepEqual(judge("PELICAN\u00a04417", "PELICAN"), { kind: "exact" }, "a no-break space between words does not change the copy");
    assert.deepEqual(nonAscii("PELICAN\u00a04417\u202f"), ["U+00A0", "U+202F"]);
    assert.deepEqual(nonAscii("plain ASCII\n\ttext"), []);
    assert.deepEqual(judge("PEL\u200bIPCAN", "PELICAN"), { kind: "near", got: "PELIPCAN", distance: 1 }, "the typo is still found once the invisible character is taken out");
  });

  test("a wrong copy is placed by what the reasoning holds", () => {
    assert.equal(place("", "PELICAN", "PELIPCAN"), "no reasoning captured");
    assert.equal(place("it says PELIPCAN", "PELICAN", "PELIPCAN"), "already wrong in the reasoning");
    assert.equal(place("it says PELICAN", "PELICAN", "PELIPCAN"), "right in the reasoning, wrong in the answer");
    assert.equal(place("hmm", "PELICAN", "PELIPCAN"), "the reasoning has neither");
  });
});

describe("the items", () => {
  test("are the same every time, in the kinds the report groups by, and none repeats", () => {
    const a = makeItems();
    assert.deepEqual(a, makeItems());
    assert.deepEqual([...new Set(a.map((i) => i.kind))], ["caps word", "lower word", "identifier", "hex8", "random caps"]);
    assert.equal(new Set(a.map((i) => i.text)).size, a.length);
    assert.ok(a.filter((i) => i.kind === "random caps").every((i) => /^[A-Z]{8}$/.test(i.text)));
  });
});

/** A model that copies the word right except for PELICAN, which it writes with a P in it on every second request, with its reasoning right or wrong as told. */
function pretend(wrongInReasoning: boolean): { adapter: ProviderAdapter; native: NativeChat } {
  let n = 0;
  const copy = (word: string): { answer: string; thought: string } => {
    const typo = word === "PELICAN" && ++n % 2 === 0;
    return { answer: typo ? "PELIPCAN" : word, thought: typo && wrongInReasoning ? "the word is PELIPCAN" : `the word is ${word}` };
  };
  const wordIn = (t: string): string => /code word is (\S+)/.exec(t)?.[1] ?? "?";
  const adapter: ProviderAdapter = {
    $tag: "pretend",
    // eslint-disable-next-line require-yield
    async *stream(req: { context: { turns: { role: string; parts?: { text: string }[]; results?: { content: string }[] }[] } }) {
      const turns = req.context.turns;
      const toolResult = turns.find((t) => t.role === "tool_results")?.results?.[0]?.content;
      if (toolResult === undefined && turns[0]?.parts?.[0]?.text.includes("note.txt") && !turns[0].parts[0].text.includes("Here is")) return reply([{ type: "tool_call", call_id: "r", name: "read", args: { path: "note.txt" } }], "tool_use");
      const c = copy(wordIn(toolResult ?? turns[0]?.parts?.[0]?.text ?? ""));
      return reply([{ type: "reasoning", provider: "p", payload: "{}", visible: c.thought }, { type: "text", text: c.answer }]);
    },
    retrieve: async () => undefined,
  } as unknown as ProviderAdapter;
  const native: NativeChat = async ({ prompt }) => {
    const c = copy(wordIn(prompt));
    return { content: c.answer, thinking: c.thought };
  };
  return { adapter, native };
}

const one = [{ kind: "caps word", text: "PELICAN" }, { kind: "hex8", text: "1f08cd1f" }];

describe("running the probe", () => {
  test("every arm copies the strings, and a typo is found, attributed to its arm, and placed from the reasoning", async () => {
    const { adapter, native } = pretend(true);
    const samples = await runProbe({ flavor: "anthropic", baseUrl: "http://x", model: "m", adapter, native, repeat: 4, items: one });
    assert.equal(samples.length, 3 * 2 * 4);
    assert.deepEqual([...new Set(samples.map((s) => s.arm))], ["tool", "plain", "native"]);
    assert.ok(samples.filter((s) => s.expected === "1f08cd1f").every((s) => s.verdict.kind === "exact"));
    const typos = samples.filter((s) => s.verdict.kind === "near");
    assert.equal(typos.length, 6, "two of every four PELICAN copies, in each arm");
    assert.ok(typos.every((s) => s.placed === "already wrong in the reasoning"));
    assert.ok(samples.every((s) => s.error === undefined), samples.find((s) => s.error)?.error);
    assert.ok(samples.every((s) => s.reasoning.length > 0), "the reasoning is kept");
    const report = formatProbeReport(samples, { flavor: "anthropic", model: "m", repeat: 4 });
    assert.match(report, /caps word\s+2\/4\s+2\/4\s+2\/4/);
    assert.match(report, /hex8\s+4\/4\s+4\/4\s+4\/4/);
    assert.match(report, /tool\s+PELICAN -> PELIPCAN\s+already wrong in the reasoning/);
    assert.match(report, /3  tool: already wrong in the reasoning|2  tool: already wrong in the reasoning/);
  });

  test("an answer with a zero-width space inside the word is reported as hidden characters, per arm, and not as a typo", async () => {
    const adapter = { $tag: "p", async *stream() { return reply([{ type: "text", text: "PEL\u200bICAN and 4417" }]); }, retrieve: async () => undefined } as unknown as ProviderAdapter;
    const native: NativeChat = async () => ({ content: "PELICAN and\u00a04417", thinking: "fine" });
    const samples = await runProbe({ flavor: "anthropic", baseUrl: "http://x", model: "m", adapter, native, repeat: 2, arms: ["plain", "native"], items: [one[0] as (typeof one)[0]] });
    assert.deepEqual(samples.map((s) => s.verdict.kind), ["hidden", "hidden", "exact", "exact"]);
    assert.deepEqual(samples.map((s) => s.hidden), [["U+200B"], ["U+200B"], ["U+00A0"], ["U+00A0"]]);
    const report = formatProbeReport(samples, { flavor: "anthropic", model: "m" });
    assert.match(report, /plain\s+answers with any: 2\/2 \(U\+200B in 2\); reasoning: none/);
    assert.match(report, /native\s+answers with any: 2\/2 \(U\+00A0 in 2\)/);
    assert.match(report, /2 answer\(s\) were the right string with those characters inside it/);
    assert.doesNotMatch(report, /near misses/);
  });

  test("a typo with the right reasoning is placed in the answer, and arms can be chosen", async () => {
    const { adapter, native } = pretend(false);
    const samples = await runProbe({ flavor: "anthropic", baseUrl: "http://x", model: "m", adapter, native, repeat: 2, arms: ["plain"], items: one });
    assert.deepEqual([...new Set(samples.map((s) => s.arm))], ["plain"]);
    assert.deepEqual(samples.filter((s) => s.verdict.kind === "near").map((s) => s.placed), ["right in the reasoning, wrong in the answer"]);
  });

  test("a model that never calls read, and a native call that fails, are reported as errors, not as copies", async () => {
    const adapter = { $tag: "p", async *stream() { return reply([{ type: "text", text: "PELICAN" }]); }, retrieve: async () => undefined } as unknown as ProviderAdapter;
    const native: NativeChat = async () => {
      throw new Error("ollama answered 500");
    };
    const samples = await runProbe({ flavor: "anthropic", baseUrl: "http://x", model: "m", adapter, native, repeat: 1, arms: ["tool", "native"], items: [one[0] as (typeof one)[0]] });
    assert.equal(samples[0]?.error, "the model did not call read");
    assert.equal(samples[1]?.error, "ollama answered 500");
    assert.match(formatProbeReport(samples, { flavor: "anthropic", model: "m" }), /2 sample\(s\) had an error/);
  });
});

describe("the flags", () => {
  test("are checked, and the settings you leave out are not set", () => {
    const { options } = parseProbeArgs(["--base-url", "http://h:11434", "--model", "m", "--arms", "plain,native", "--temperature", "0", "--reasoning-effort", "low", "--repeat", "3"], {});
    assert.deepEqual([options.arms, options.temperature, options.reasoningEffort, options.repeat], [["plain", "native"], 0, "low", 3]);
    assert.equal(parseProbeArgs(["--base-url", "u", "--model", "m", "--shape", "single"], {}).options.shape, "single");
    assert.throws(() => parseProbeArgs(["--base-url", "u", "--model", "m", "--shape", "triple"], {}), /--shape must be/);
    const bare = parseProbeArgs(["--base-url", "http://h", "--model", "m"], {}).options;
    assert.equal("temperature" in bare, false);
    assert.throws(() => parseProbeArgs(["--base-url", "u", "--model", "m", "--arms", "tool,fast"], {}), /--arms must be/);
    assert.throws(() => parseProbeArgs(["--base-url", "u", "--model", "m", "--temperature", "hot"], {}), /--temperature/);
    assert.throws(() => parseProbeArgs(["--base-url", "u", "--model", "m", "--reasoning-effort", "max"], {}), /low, medium or high/);
    assert.throws(() => parseProbeArgs(["--model", "m"], {}), /--base-url and --model are required/);
    assert.throws(() => parseProbeArgs(["--base-url", "u", "--model", "m", "--bogus", "1"], {}), /unknown flag/);
  });
});
