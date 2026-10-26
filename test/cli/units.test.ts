import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { detectMime } from "../../cli/mime.ts";
import { Registry, parseCommand, tokenize, type Command } from "../../cli/registry.ts";

const cmd = (name: string, extra: Partial<Command> = {}): Command => ({ name, summary: "", usage: "", busy: "allowed", async *run() {}, ...extra });

describe("registry", () => {
  test("duplicate names and aliases are refused", () => {
    assert.throws(() => new Registry([cmd("a"), cmd("b", { aliases: ["a"] })]), /two commands are called \/a/);
  });
  test("a command that stages state needs its show and clear partners", () => {
    assert.throws(() => new Registry([cmd("attach", { stages: { show: "attachments", clear: "detach" } })]), /\/attachments must exist/);
    const ok = new Registry([cmd("attach", { stages: { show: "attachments", clear: "detach" } }), cmd("attachments"), cmd("detach")]);
    assert.deepEqual(ok.names(), ["attach", "attachments", "detach"]);
  });
});

describe("command lines", () => {
  test("parseCommand", () => {
    assert.deepEqual(parseCommand("/say hello  "), { name: "say", rest: "hello" });
    assert.deepEqual(parseCommand("/abort"), { name: "abort", rest: "" });
    assert.equal(parseCommand("//not a command"), undefined);
    assert.equal(parseCommand("plain"), undefined);
  });
  test("tokenize groups quotes and escapes like a shell", () => {
    assert.deepEqual(tokenize(`a "b c" d\\ e 'f g'`), ["a", "b c", "d e", "f g"]);
  });
});

describe("mime detection", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const text = (s: string) => new TextEncoder().encode(s);
  test("magic numbers beat the extension; extension and text check cover the rest", () => {
    assert.equal(detectMime("x.txt", png).mime, "image/png");
    assert.equal(detectMime("notes.md", text("hi")).mime, "text/markdown");
    assert.equal(detectMime("README", text("hi")).mime, "text/plain");
  });
  test("binary of unknown kind is refused unless --mime says; a bad override is refused", () => {
    assert.throws(() => detectMime("blob", new Uint8Array([0, 1, 2])), /looks binary/);
    assert.equal(detectMime("blob", new Uint8Array([0, 1, 2]), { mime: "application/x-thing" }).mime, "application/x-thing");
    assert.throws(() => detectMime("a", text("x"), { mime: "nonsense" }), /not a media type/);
  });
});
