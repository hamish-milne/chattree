import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { configFixture } from "../../ui/fixtures/config.ts";
import { MockController } from "../../ui/fixtures/mock-controller.ts";
import { validateMock } from "../../ui/fixtures/mock-validate.ts";
import { ConfigModel } from "../../ui/model/config-model.ts";
import {
  ADAPTERS,
  enabledModels,
  estimateTokens,
  modelKey,
  splitModelKey,
  FOREVER,
  addGrant,
  grantState,
  grants,
  issueCounts,
  mcpTransport,
  newProvider,
  newProviderName,
  pageOf,
  removeGrant,
  renameGrant,
  setGrantUntil,
} from "../../ui/model/config-sheet.ts";
import { formFields } from "../../ui/model/form-model.ts";
import { parseEvent, type UiEvent, type UiIntent } from "../../ui/model/protocol.ts";

const NOW = new Date("2026-11-18T12:00:00Z");
const fixture = () => configFixture(NOW);

describe("the harness.yml fixture", () => {
  test("is a valid file for the harness's own schema, except for the one rule the mock adds", () => {
    const spec = fixture();
    assert.deepEqual(validateMock(spec.schema, spec.value), []);
  });

  test("the checker catches what the real schema would", () => {
    const { schema, value } = fixture();
    const issues = (v: Record<string, unknown>): string[] => validateMock(schema, v).map((i) => i.path);
    assert.deepEqual(issues({ limits: { max_request_usd: 0 } }), ["limits.max_request_usd"]);
    assert.deepEqual(issues({ limits: { warn_at: 1 } }), ["limits.warn_at"]);
    assert.deepEqual(issues({ providers: { "Bad Name": { $tag: "anthropic" } } }), ["providers.Bad Name"]);
    assert.deepEqual(
      issues({
        providers: { a: { $tag: "anthropic", api_key_env: "sk-abc-123" } },
      }),
      ["providers.a.api_key_env"],
    );
    assert.deepEqual(issues({ providers: { a: { $tag: "nope" } } }), ["providers.a.$tag"]);
    assert.deepEqual(issues({ tools: { run: { allow: { x: "tomorrow" } } } }), ["tools.run.allow.x"]);
    assert.deepEqual(issues({ mcp: { x: { url: "not a url" } } }), ["mcp.x.url"]);
    assert.deepEqual(issues({ extra: 1 }), ["extra"]);
    assert.deepEqual(validateMock(schema, value), []);
  });

  test("its schema is read as a map by the form model, as providers and MCP servers are", () => {
    const tree = formFields(fixture());
    const mcp = tree.fields.find((f) => f.key === "mcp");
    assert.equal(mcp?.kind, "map");
    assert.deepEqual(mcp?.kind === "map" && mcp.entries.map((e) => e.key), ["github", "docs"]);
  });
});

describe("pages and problems", () => {
  test("a setting is on the page that shows it", () => {
    assert.equal(pageOf("providers.local.base_url"), "providers");
    assert.equal(pageOf("limits.warn_at"), "limits");
    assert.equal(pageOf("tools.run.allow.x"), "approvals");
    assert.equal(pageOf("mcp.github.allow.x"), "approvals");
    assert.equal(pageOf("mcp.github.url"), "mcp");
    assert.equal(pageOf("subagent.models"), "subagents");
    assert.equal(pageOf("injections.rules.a.every"), "context");
    assert.equal(pageOf("maintenance.packs"), "repository");
    assert.equal(pageOf(""), "general");
    assert.equal(pageOf("zzz"), "general");
  });

  test("problems are counted by page, and what no page shows is kept apart", () => {
    const { byPage, general } = issueCounts([
      { path: "limits.a", message: "x" },
      { path: "limits.b", message: "x" },
      { path: "mcp.s.url", message: "x" },
      { path: "", message: "whole file" },
    ]);
    assert.equal(byPage.get("limits"), 2);
    assert.equal(byPage.get("mcp"), 1);
    assert.deepEqual(
      general.map((i) => i.message),
      ["whole file"],
    );
  });
});

describe("providers", () => {
  test("every adapter the harness offers is here, each with a name for a new provider", () => {
    const { schema } = fixture();
    const providers = (schema["properties"] as { providers: { additionalProperties: { oneOf: { title: string }[] } } }).providers;
    const variants = providers.additionalProperties.oneOf.map((v) => v.title);
    assert.deepEqual(ADAPTERS.map((a) => a.tag).sort(), variants.sort());
    assert.equal(newProviderName("anthropic", []), "anthropic");
    assert.equal(newProviderName("anthropic", ["anthropic"]), "anthropic-2");
    assert.equal(newProviderName("openai-compatible", ["local", "local-2"]), "local-3");
  });

  test("a new provider is valid for its adapter", () => {
    const { schema } = fixture();
    for (const a of ADAPTERS) assert.deepEqual(validateMock(schema, { providers: { p: newProvider(a.tag) } }), [], a.tag);
  });
});

describe("approvals", () => {
  const value = fixture().value;

  test("grants are listed from tools and servers, with their state at a given time", () => {
    const g = grants(value, NOW);
    assert.equal(g.length, 9);
    const by = (o: string, k: string) => g.find((x) => x.owner === o && x.key === k);
    assert.equal(by("run", "git status")?.state, "forever");
    assert.equal(by("run", "pnpm test")?.state, "soon");
    assert.equal(by("run", "make *")?.state, "expired");
    assert.equal(by("fetch", "registry.npmjs.org")?.state, "active");
    assert.equal(by("github", "get_issue")?.scope, "mcp");
    assert.equal(
      g.some((x) => x.owner === "env"),
      false,
    );
  });

  test("a date or a datetime is judged the same way; anything else is not a date", () => {
    assert.equal(grantState("2999-01-01", NOW), "forever");
    assert.equal(grantState("2026-11-18T11:59:00Z", NOW), "expired");
    assert.equal(grantState("2026-11-19T00:00:00Z", NOW), "soon");
    assert.equal(grantState("2027-01-01", NOW), "active");
    assert.equal(grantState("soon", NOW), "invalid");
  });

  test("adding, renaming, changing and removing a grant leave everything else alone", () => {
    const added = addGrant(value, "tool", "run", "git log", FOREVER);
    assert.equal(grants(added, NOW).length, 10);
    const fresh = addGrant(value, "tool", "script", "x", "2027-01-01");
    assert.deepEqual((fresh["tools"] as Record<string, unknown>)["script"], {
      allow: { x: "2027-01-01" },
    });
    const renamed = renameGrant(value, { scope: "tool", owner: "run", key: "git status" }, "git status -s");
    assert.deepEqual(Object.keys(grantsOf(renamed, "run")), ["git status -s", "git diff *", "pnpm test", "make *"]);
    const moved = setGrantUntil(value, { scope: "mcp", owner: "github", key: "get_issue" }, "2027-02-02");
    assert.equal(grantsOf(moved, "github", "mcp")["get_issue"], "2027-02-02");
    const removed = removeGrant(value, {
      scope: "tool",
      owner: "edit",
      key: "src/**",
    });
    assert.equal((removed["tools"] as Record<string, Record<string, unknown>>)["edit"]?.["allow"], undefined);
    assert.deepEqual(value, fixture().value);
  });

  test("how an MCP server is reached", () => {
    assert.deepEqual(mcpTransport({ command: "npx", args: ["-y", "x"] }), {
      kind: "command",
      text: "npx -y x",
    });
    assert.deepEqual(mcpTransport({ url: "https://a/mcp" }), {
      kind: "url",
      text: "https://a/mcp",
    });
    assert.deepEqual(mcpTransport({}), { kind: "none", text: "" });
  });
});

function grantsOf(value: Record<string, unknown>, owner: string, scope: "tools" | "mcp" = "tools"): Record<string, unknown> {
  const top = value[scope] as Record<string, { allow?: Record<string, unknown> }>;
  return top[owner]?.allow ?? {};
}

describe("the editor model with the mock controller", () => {
  const rig = () => {
    const events: UiEvent[] = [];
    const sent: UiIntent[] = [];
    const controller = new MockController({
      emit: (e) => {
        const r = parseEvent(e);
        assert.ok(r.ok, "the controller sends events the protocol accepts");
        events.push(r.value);
      },
      sleep: async () => {},
    });
    const config = new ConfigModel((i) => {
      sent.push(i);
      controller.handle(i);
    });
    const feed = (): void => {
      for (const e of events.splice(0)) config.apply(e);
    };
    return { config, sent, controller, feed, events };
  };

  test("the file is asked for once, when the editor is first opened", () => {
    const { config, sent, feed } = rig();
    assert.equal(config.form.value, undefined);
    config.toggle();
    feed();
    const readies = (): number => sent.filter((i) => i.type === "ready").length;
    assert.equal(readies(), 1);
    assert.ok(config.form.value);
    config.toggle();
    config.toggle();
    assert.equal(readies(), 1);
    assert.equal(config.open.value, true);
  });

  test("a problem the file has is counted on its page; fixing it clears the count", () => {
    const { config, feed } = rig();
    config.toggle();
    feed();
    assert.equal(config.counts.value.byPage.get("limits"), 1);
    assert.equal(config.problems.value, 1);
    config.form.value?.set(["limits", "max_turn_usd"], 5);
    feed();
    assert.equal(config.problems.value, 0);
    assert.equal(config.dirty.value, true);
  });

  test("saving sends the message, is refused while there are problems, and commits on the trunk", () => {
    const { config, sent, controller, feed, events } = rig();
    controller.handle({ type: "ready", view: "graph" });
    config.toggle();
    feed();
    config.setMessage("raise the turn limit");
    config.save();
    assert.equal(
      sent.some((i) => i.type === "form.save"),
      false,
      "a file with a problem is not sent to be saved",
    );
    config.form.value?.set(["limits", "max_turn_usd"], 5);
    feed();
    config.save();
    feed();
    const save = sent.find((i) => i.type === "form.save");
    assert.deepEqual(save, {
      type: "form.save",
      id: "harness",
      message: "raise the turn limit",
    });
    assert.equal(config.dirty.value, false);
    assert.equal(config.message.value, "", "the message is spent with the save");
    const graph = events.length === 0 ? undefined : events;
    void graph;
  });

  test("the commit is on the trunk with the person's message", () => {
    const events: UiEvent[] = [];
    const controller = new MockController({
      emit: (e) => events.push(e),
      sleep: async () => {},
    });
    controller.handle({ type: "ready", view: "config" });
    controller.handle({
      type: "form.edit",
      id: "harness",
      value: { limits: { max_turn_usd: 5, max_conversation_usd: 50 } },
    });
    controller.handle({
      type: "form.save",
      id: "harness",
      message: "lower the cap",
    });
    const data = events.findLast((e) => e.type === "graph.data");
    assert.ok(data?.type === "graph.data");
    assert.equal(data.data.commits.at(-1)?.summary, "harness.yml: lower the cap");
    controller.handle({
      type: "form.edit",
      id: "harness",
      value: { limits: { max_turn_usd: 6 } },
    });
    controller.handle({ type: "form.save", id: "harness" });
    const again = events.findLast((e) => e.type === "graph.data");
    assert.ok(again?.type === "graph.data");
    assert.equal(again.data.commits.at(-1)?.summary, "harness.yml: update settings");
  });

  test("revert goes back to the file as saved", () => {
    const { config, feed } = rig();
    config.toggle();
    feed();
    config.form.value?.set(["skills", "follow"], "off");
    config.revert();
    feed();
    assert.equal(config.dirty.value, false);
    assert.deepEqual(config.form.value?.spec.value.value["skills"], {
      follow: "ask",
    });
  });
});

describe("providers' connection, their models and the instruction files", () => {
  const rig = () => {
    const sent: UiIntent[] = [];
    const controller = new MockController({
      emit: (e) => {
        const r = parseEvent(e);
        assert.ok(r.ok);
        config.apply(r.value);
      },
      sleep: async () => {},
    });
    const config = new ConfigModel((i) => {
      sent.push(i);
      controller.handle(i);
    });
    return { config, sent, controller };
  };

  test("opening the providers page tests each provider once; the result shows, and an edit makes it stale", async () => {
    const { config, sent, controller } = rig();
    config.toggle();
    await controller.idle();
    const tests = sent.flatMap((i) => (i.type === "provider.test" ? [i.provider] : []));
    assert.deepEqual(tests, ["anthropic", "openai", "local"]);
    assert.equal(config.statuses.value["anthropic"]?.state, "ok");
    assert.equal(config.statuses.value["local"]?.state, "error");
    assert.match(config.statuses.value["local"]?.detail ?? "", /connection refused/);
    config.setPage("limits");
    config.setPage("providers");
    assert.equal(sent.filter((i) => i.type === "provider.test").length, 3, "not asked again");
    assert.equal(config.isStale("anthropic"), false);
    config.form.value?.set(["providers", "anthropic", "api_key_env"], "OTHER_KEY");
    assert.equal(config.isStale("anthropic"), true);
    config.test("anthropic");
    await controller.idle();
    assert.equal(config.isStale("anthropic"), false);
  });

  test("the subagents page lists each provider's models, or why it cannot", async () => {
    const { config, controller } = rig();
    config.toggle();
    config.setPage("subagents");
    await controller.idle();
    assert.deepEqual(
      config.models.value["anthropic"]?.models.map((m) => m.id),
      ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    );
    assert.match(config.models.value["local"]?.error ?? "", /connection refused/);
  });

  test("model keys: the switch is the key's presence in subagent.models", () => {
    const value = fixture().value;
    assert.equal(modelKey("anthropic", "claude-haiku-5-5"), "anthropic/claude-haiku-5-5");
    assert.deepEqual(splitModelKey("local/org/model"), { provider: "local", id: "org/model" });
    assert.deepEqual([...enabledModels(value)], ["anthropic/claude-haiku-5-5", "local/qwen3-coder"]);
    assert.equal(enabledModels({}).size, 0);
  });

  test("instruction files: the well-known ones in the workspace are offered, and adding one takes it off the list", async () => {
    const { config, controller } = rig();
    config.toggle();
    await controller.idle();
    const first = config.instructions.value;
    assert.deepEqual(
      first.files.map((f) => [f.path, f.on]),
      [
        ["AGENTS.md", true],
        ["docs/conventions.md", false],
      ],
    );
    assert.deepEqual(
      first.found.map((f) => f.path),
      ["CLAUDE.md", ".github/copilot-instructions.md", "CONTRIBUTING.md"],
    );
    config.addInstruction("CLAUDE.md");
    config.addInstruction("notes/missing.md");
    config.enableInstruction("docs/conventions.md", true);
    const after = config.instructions.value;
    assert.deepEqual(
      after.files.map((f) => [f.path, f.on, f.exists]),
      [
        ["AGENTS.md", true, true],
        ["docs/conventions.md", true, true],
        ["CLAUDE.md", true, true],
        ["notes/missing.md", true, false],
      ],
    );
    assert.equal(
      after.found.some((f) => f.path === "CLAUDE.md"),
      false,
    );
    config.removeInstruction("AGENTS.md");
    assert.equal(
      config.instructions.value.files.some((f) => f.path === "AGENTS.md"),
      false,
    );
    assert.equal(
      config.instructions.value.found.some((f) => f.path === "AGENTS.md"),
      true,
      "a removed well-known file is offered again",
    );
    assert.equal(estimateTokens(4210), 1053);
  });
});
