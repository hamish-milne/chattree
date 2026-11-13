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
    await assert.rejects(readSpeech(dir), /b\.txt/);
  });

  test("the report counts right answers by kind and lists the wrong ones", () => {
    const text = report([
      { id: "beeps-1", kind: "beeps", expected: "3", answer: "3", right: true, ms: 1 },
      { id: "pitch-1", kind: "pitch", expected: "first", answer: "second", right: false, ms: 1, stop: "max_tokens", tokens: { in: 1, out: 9 } },
    ]);
    assert.match(text, /\| beeps \| 1 \| 1 \|[\s\S]*\| pitch \| 0 \| 1 \|[\s\S]*\| all \| 1 \| 2 \|/);
    assert.match(text, /pitch-1: expected first; answered "second" \[max_tokens\] \(9 tokens out\)/);
  });
});
