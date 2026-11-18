import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

/**
 * The methods of a `createModel` model are actions: they run untracked, so a view that calls one while it draws is never told
 * when the answer changes (an expanded tool call that would not close again was exactly this). What a view reads has to be a
 * signal or a computed. This keeps a method that returns a value from slipping in; the ones listed take in an event or
 * report whether a gesture was accepted, and are called from handlers, never while drawing.
 */
const ALLOWED: Record<string, string[]> = {
  "chat-model": ["apply"],
  "config-model": ["apply"],
  "form-model": ["apply"],
  "graph-model": ["apply", "startDrag", "drop"],
};

describe("model methods", () => {
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    test(`${file}: no method that returns a value for a view to read`, async () => {
      const src = await readFile(new URL(`../../ui/model/${file}.ts`, import.meta.url), "utf8");
      const found = [...src.matchAll(/^ {4}(\w+)\([^)]*\): (?!void\b|Promise<void>)[^{]+\{$/gm)].map((m) => m[1] ?? "");
      assert.deepEqual(
        found.filter((n) => !allowed.includes(n)),
        [],
        "a view calling these would not be redrawn when the answer changes: expose a computed instead",
      );
    });
  }
});
