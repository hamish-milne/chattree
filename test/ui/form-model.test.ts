import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FormModel, formFields, removeIn, setIn, type Field } from "../../ui/model/form-model.ts";
import type { FormSpec } from "../../ui/model/form.ts";
import type { UiIntent } from "../../ui/model/protocol.ts";

/** A small form with one of each kind of field: the harness's own file is tested through the sheet. */
function smallForm(): FormSpec {
  return {
    id: "harness",
    title: "harness.yml",
    saveLabel: "Save and commit",
    schema: {
      type: "object",
      properties: {
        providers: {
          type: "object",
          description: "The model services this project can reach, each named by a key you choose.",
          additionalProperties: {
            type: "object",
            properties: {
              $tag: {
                enum: ["anthropic", "openai", "openai-compatible", "gemini", "local-models"],
              },
              api_key_env: {
                type: "string",
                description: "The NAME of an environment variable, never a key.",
              },
              base_url: { type: "string" },
            },
            required: ["$tag"],
          },
        },
        limits: {
          type: "object",
          description: "Enforced before a request is sent.",
          properties: {
            max_request_usd: { type: "number", minimum: 0 },
            max_turn_usd: { type: "number", minimum: 0 },
            max_conversation_usd: { type: "number", minimum: 0 },
            warn_at: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Fraction of a limit at which a warning is shown.",
            },
          },
        },
        skills: {
          type: "object",
          properties: {
            follow: {
              enum: ["auto", "ask", "off"],
              description: "Whether changed skills on disk are taken automatically.",
            },
          },
        },
        compaction: {
          type: "object",
          properties: {
            auto: { type: "boolean" },
            keep_recent: { type: "integer", minimum: 0 },
          },
        },
        background: {
          type: "object",
          properties: {
            resume: {
              type: "boolean",
              description: "Let a finished background job restart an idle thread (spends money).",
            },
          },
        },
        allow_hosts: {
          type: "array",
          items: { type: "string" },
          description: "Hosts the fetch tool may reach.",
        },
      },
    },
    value: {
      providers: {
        anthropic: { $tag: "anthropic", api_key_env: "ANTHROPIC_API_KEY" },
        local: {
          $tag: "openai-compatible",
          base_url: "http://localhost:8080/v1",
        },
      },
      limits: {
        max_request_usd: 1,
        max_turn_usd: 80,
        max_conversation_usd: 50,
        warn_at: 0.8,
      },
      skills: { follow: "ask" },
      compaction: { auto: true, keep_recent: 12 },
      background: { resume: false },
      allow_hosts: ["registry.npmjs.org", "github.com"],
    },
    issues: [{ path: "limits.max_turn_usd", message: "is above max_conversation_usd" }],
    dirty: false,
  };
}

const find = (fields: Field[], ...path: string[]): Field | undefined => {
  let level = fields;
  let found: Field | undefined;
  for (const key of path) {
    found = level.find((f) => f.key === key);
    level = found?.kind === "group" ? found.fields : [];
  }
  return found;
};

describe("fields from a schema", () => {
  const tree = formFields(smallForm());

  test("each kind of schema becomes the field a person would expect", () => {
    assert.equal(find(tree.fields, "skills", "follow")?.kind, "choice");
    assert.deepEqual((find(tree.fields, "skills", "follow") as { options: string[] }).options, ["auto", "ask", "off"]);
    assert.equal(find(tree.fields, "compaction", "auto")?.kind, "boolean");
    assert.equal(find(tree.fields, "allow_hosts")?.kind, "list");
    const turn = find(tree.fields, "limits", "max_turn_usd");
    assert.equal(turn?.kind, "number");
    assert.equal(turn?.kind === "number" && turn.integer, false);
    assert.equal(
      find(tree.fields, "compaction", "keep_recent")?.kind === "number" &&
        (find(tree.fields, "compaction", "keep_recent") as { integer: boolean }).integer,
      true,
    );
    const warn = find(tree.fields, "limits", "warn_at");
    assert.deepEqual(warn?.kind === "number" && [warn.min, warn.max], [0, 1]);
  });

  test("keys the person chooses become a map of groups, with a template for a new entry", () => {
    const providers = find(tree.fields, "providers");
    assert.equal(providers?.kind, "map");
    if (providers?.kind !== "map") return;
    assert.deepEqual(
      providers.entries.map((e) => e.key),
      ["anthropic", "local"],
    );
    assert.deepEqual(
      providers.entries[0]?.fields.map((f) => f.key),
      ["$tag", "api_key_env", "base_url"],
    );
    assert.deepEqual(
      providers.template.map((f) => f.key),
      ["$tag", "api_key_env", "base_url"],
    );
    assert.deepEqual(providers.entries[0]?.fields[1]?.path, ["providers", "anthropic", "api_key_env"]);
  });

  test("the schema's descriptions come along, and an issue lands on its own field", () => {
    assert.match(find(tree.fields, "limits", "warn_at")?.description ?? "", /warning/);
    assert.deepEqual(find(tree.fields, "limits", "max_turn_usd")?.issues, ["is above max_conversation_usd"]);
    assert.deepEqual(find(tree.fields, "limits", "max_request_usd")?.issues, []);
  });

  test("something the schema does not describe is kept as it is, and an issue about nowhere is not lost", () => {
    const spec = smallForm();
    spec.value = { ...spec.value, mystery: { a: 1 } };
    spec.issues = [
      { path: "", message: "the file is wrong" },
      { path: "nope.nothing", message: "unknown" },
    ];
    const t = formFields(spec);
    assert.equal(t.fields.find((f) => f.key === "mystery")?.kind, "raw");
    assert.deepEqual(
      t.unplaced.map((i) => i.message),
      ["the file is wrong", "unknown"],
    );
  });
});

describe("editing a value", () => {
  test("setIn and removeIn make new values and leave the old alone", () => {
    const before = { a: { b: 1, c: 2 }, d: 3 };
    const after = setIn(before, ["a", "b"], 9);
    assert.deepEqual(after, { a: { b: 9, c: 2 }, d: 3 });
    assert.deepEqual(before, { a: { b: 1, c: 2 }, d: 3 });
    assert.deepEqual(setIn(before, ["x", "y"], 1), {
      a: { b: 1, c: 2 },
      d: 3,
      x: { y: 1 },
    });
    assert.deepEqual(removeIn(before, ["a", "c"]), { a: { b: 1 }, d: 3 });
    assert.deepEqual(before.a, { b: 1, c: 2 });
  });

  test("an edit shows at once and is sent; save and revert are sent by name", () => {
    const sent: UiIntent[] = [];
    const form = new FormModel(smallForm(), (i) => sent.push(i));
    form.set(["skills", "follow"], "auto");
    assert.equal(
      find(form.tree.value.fields, "skills", "follow")?.kind === "choice" &&
        (find(form.tree.value.fields, "skills", "follow") as { value: string }).value,
      "auto",
    );
    assert.equal(form.spec.value.dirty, true);
    assert.deepEqual(
      sent.map((i) => i.type),
      ["form.edit"],
    );
    const edits = sent.flatMap((i) => (i.type === "form.edit" ? [i.value] : []));
    assert.deepEqual(edits[0]?.["skills"], { follow: "auto" });
    form.remove(["providers", "local"]);
    const edits2 = sent.flatMap((i) => (i.type === "form.edit" ? [i.value] : []));
    assert.deepEqual(Object.keys((edits2[1]?.["providers"] as object | undefined) ?? {}), ["anthropic"]);
    form.save();
    form.revert();
    assert.deepEqual(sent.slice(2), [
      { type: "form.save", id: "harness" },
      { type: "form.revert", id: "harness" },
    ]);
  });

  test("it takes the controller's answer, and only for its own form", () => {
    const form = new FormModel(smallForm(), () => {});
    const answer = {
      ...smallForm(),
      issues: [{ path: "skills.follow", message: "no" }],
      dirty: true,
    };
    assert.equal(form.apply({ type: "form.set", form: { ...answer, id: "other" } }), false);
    assert.equal(form.apply({ type: "form.set", form: answer }), true);
    assert.deepEqual(find(form.tree.value.fields, "skills", "follow")?.issues, ["no"]);
    assert.equal(form.apply({ type: "notice", level: "info", message: "x" }), false);
  });
});
