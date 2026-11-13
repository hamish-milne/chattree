import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { encodeWav, scenarios, speechScenario, tone } from "../../tools/audio-scenarios.ts";
import { readSpeech, report } from "../../tools/audio-probe.ts";

describe("audio scenarios", () => {
  test("a WAV has the header of 16-bit mono PCM and the samples it was given", () => {
    const wav = encodeWav(tone(440, 0.1));
    const text = (a: number, n: number): string => String.fromCharCode(...wav.subarray(a, a + n));
    assert.equal(text(0, 4), "RIFF");
    assert.equal(text(8, 8), "WAVEfmt ");
    assert.equal(text(36, 4), "data");
    const v = new DataView(wav.buffer);
    assert.equal(v.getUint32(24, true), 16000);
    assert.equal(v.getUint32(40, true), 1600 * 2);
    assert.equal(wav.length, 44 + 3200);
    assert.equal(v.getInt16(44, true), 0, "a tone starts at zero");
  });

  test("the same seed gives the same sounds, and the checks accept the answer and not its opposite", () => {
    const a = scenarios({ count: 4, seed: 3 });
    const b = scenarios({ count: 4, seed: 3 });
    assert.deepEqual(a.map((s) => [s.id, s.expected]), b.map((s) => [s.id, s.expected]));
    assert.deepEqual(a[0]?.wav, b[0]?.wav);
    assert.equal(a.length, 12);
    for (const s of a) {
      assert.ok(s.check(s.expected), s.id);
      if (s.kind === "beeps") {
        assert.ok(s.check(["", "one", "two", "three", "four", "five", "six"][Number(s.expected)] as string), "numbers as words");
        assert.equal(s.check(String(Number(s.expected) + 1)), false);
      } else assert.equal(s.check(s.expected === "first" ? "second" : "first"), false);
    }
    assert.equal(a.find((s) => s.kind === "pitch")?.check("the first, then the second"), false, "an answer that says both is not an answer");
    const lengths = new Set(a.filter((s) => s.kind === "beeps").map((s) => s.wav.length));
    assert.ok(lengths.size > 1, "different counts make sounds of different lengths");
  });

  test("padding makes a sound at least as long as asked, and leaves a longer one alone", () => {
    const [a] = scenarios({ kinds: ["pitch"], count: 1, seed: 1, pad: 10 });
    assert.equal(a?.wav.length, 44 + 10 * 16000 * 2);
    const [b] = scenarios({ kinds: ["pitch"], count: 1, seed: 1, pad: 1 });
    assert.equal(b?.wav.length, 44 + Math.round(2.0 * 16000) * 2);
  });

  test("speech is right when the words are in the answer, whatever the case and punctuation", async () => {
    const s = speechScenario("hello", new Uint8Array(), "Hello, World.");
    assert.ok(s.check("It says: hello world!"));
    assert.equal(s.check("hello there"), false);
    const dir = await mkdtemp(join(tmpdir(), "chattree-speech-"));
    await writeFile(join(dir, "a.wav"), new Uint8Array([1]));
    await writeFile(join(dir, "a.txt"), "one two\n");
    await writeFile(join(dir, "notes.md"), "ignored");
    assert.deepEqual((await readSpeech(dir)).map((x) => [x.id, x.expected]), [["speech-a", "one two"]]);
    await writeFile(join(dir, "b.wav"), new Uint8Array([2]));
    await writeFile(join(dir, "b.q"), "Yanny or Laurel?\n");
    const got = await readSpeech(dir);
    assert.deepEqual(got.map((x) => [x.id, x.kind, x.question]), [["speech-a", "speech", "What is said in this recording? Answer with just the words."], ["listen-b", "listen", "Yanny or Laurel?"]]);
    assert.equal(got[1]?.check("anything"), true);
  });

  test("the report counts right answers by kind and lists the wrong ones", () => {
    const text = report([
      { id: "beeps-1", kind: "beeps", expected: "3", answer: "3", right: true, ms: 1 },
      { id: "listen-x", kind: "listen", expected: "", answer: "hello there", right: true, ms: 1 },
      { id: "pitch-1", kind: "pitch", expected: "first", answer: "second", right: false, ms: 1, stop: "max_tokens", tokens: { in: 1, out: 9 } },
    ]);
    assert.match(text, /\| beeps \| 1 \| 1 \|[\s\S]*\| pitch \| 0 \| 1 \|[\s\S]*\| listen \(unscored\) \| - \| 1 \|[\s\S]*\| all scored \| 1 \| 2 \|/);
    assert.match(text, /Heard[\s\S]*listen-x: "hello there"/);
    assert.match(text, /pitch-1: expected first; answered "second" \[max_tokens\] \(9 tokens out\)/);
  });
});

describe("the speech sample set", () => {
  test("names are unique, the clips are short, and ffmpeg is told to cut from the Commons redirect with a user agent", async () => {
    const { SAMPLES, ffmpegArgs, sourceOf, sourceUrl, USER_AGENT } = await import("../../tools/audio-samples.ts");
    assert.equal(new Set(SAMPLES.map((s) => s.name)).size, SAMPLES.length);
    assert.ok(SAMPLES.every((s) => s.seconds <= 30 && /^[a-z-]+$/.test(s.name)));
    assert.equal(sourceUrl("Non-native English.ogg"), "https://commons.wikimedia.org/wiki/Special:FilePath/Non-native%20English.ogg");
    const args = ffmpegArgs(SAMPLES[1] as (typeof SAMPLES)[number], "out.wav");
    assert.deepEqual(args.slice(args.indexOf("-user_agent"), args.indexOf("-user_agent") + 2), ["-user_agent", USER_AGENT]);
    assert.equal(sourceOf("a b.ogg", "in", () => false), "https://commons.wikimedia.org/wiki/Special:FilePath/a%20b.ogg");
    const local = sourceOf("a.ogg", "in", () => true);
    assert.ok(local.endsWith("/in/a.ogg") && local.startsWith("/"), "a copy in the input folder is read in place of the URL");
    assert.ok(!ffmpegArgs(SAMPLES[1] as (typeof SAMPLES)[number], "o.wav", local).includes("-user_agent"), "no user agent for a file");
    assert.ok(args.includes("-ar") && args.at(-1) === "out.wav" && args[args.indexOf("-i") + 1]?.endsWith("Declaration_of_Independence_Part_1.ogg"));
  });
});

describe("spoken clips", () => {
  test("the same seed makes the same clips, with only words flite can say", async () => {
    const { speechClips, fliteArgs } = await import("../../tools/audio-speech.ts");
    const a = speechClips({ count: 4, seed: 3 });
    assert.deepEqual(a, speechClips({ count: 4, seed: 3 }));
    assert.notDeepEqual(a, speechClips({ count: 4, seed: 4 }));
    assert.equal(a.length, 8);
    for (const c of a) assert.match(c.text, /^[a-z]+( [a-z]+)*$/);
    const args = fliteArgs(a[0] as (typeof a)[number], "o.wav");
    assert.ok(args.includes(`flite=text='${a[0]?.text}':voice=${a[0]?.voice}`));
    assert.throws(() => fliteArgs({ text: "it's", voice: "slt" }, "o.wav"));
  });
});
