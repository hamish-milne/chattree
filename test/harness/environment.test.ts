import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChatEntry } from "../../harness/entries.ts";
import { ENVIRONMENT_KEY, SYSTEM_PROMPT, environmentRule, environmentText, type EnvironmentFacts } from "../../harness/environment.ts";
import type { InjectionContext } from "../../harness/injections.ts";

const facts: EnvironmentFacts = { os: "Linux 6.1", platform: "posix", utilities: "`run` takes a command.", timeZone: "Europe/London", thread: "main", workspace: "/work/p" };
const at = (iso: string): number => Date.parse(iso);
const ctx = (now: number, entries: ChatEntry[] = []): InjectionContext => ({ now, entries, turns: 0, since: () => undefined, prepared: {} as never });
const said = (text: string): ChatEntry => ({ $tag: "injection", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", key: ENVIRONMENT_KEY, text });

describe("the environment note", () => {
  test("names the system, the time zone and the day in that zone, the thread and the workspace", () => {
    const t = environmentText(facts, at("2026-11-04T15:00:00Z"));
    assert.match(t, /Linux 6\.1 \(POSIX\)/);
    assert.match(t, /Time zone Europe\/London; today is Wednesday 2026-11-04/);
    assert.match(t, /Thread: main\. Workspace: \/work\/p/);
    assert.match(t, /Commands: `run` takes a command\./);
  });

  test("the day is the one in the time zone, not in UTC", () => {
    const late = at("2026-11-04T23:30:00Z");
    assert.match(environmentText({ ...facts, timeZone: "Asia/Tokyo" }, late), /Thursday 2026-11-05/);
    assert.match(environmentText(facts, late), /Wednesday 2026-11-04/);
  });

  test("it is said on the first request, not again the same day, and again on a new day, in a fork, or when a fact changes", () => {
    const rule = environmentRule(facts);
    const first = rule(ctx(at("2026-11-04T09:00:00Z"))) as { key: string; text: string };
    assert.equal(first.key, ENVIRONMENT_KEY);
    const history = [said(first.text)];
    assert.equal(rule(ctx(at("2026-11-04T21:00:00Z"), history)), undefined, "the same day");
    assert.ok(rule(ctx(at("2026-11-05T09:00:00Z"), history)), "a new day");
    assert.ok(environmentRule({ ...facts, thread: "fork/1" })(ctx(at("2026-11-04T09:00:00Z"), history)), "a fork has its own thread name");
    assert.ok(environmentRule({ ...facts, workspace: "/elsewhere" })(ctx(at("2026-11-04T09:00:00Z"), history)));
  });

  test("the system prompt says what chattree is and ends with its version", () => {
    for (const word of ["thread", "fork", "subagent", "approval", "[Note from the harness]"]) assert.ok(SYSTEM_PROMPT.includes(word), word);
    assert.match(SYSTEM_PROMPT, /\(chattree system prompt, version 2\)$/);
  });
});
