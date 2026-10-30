import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { SCHEMA_PATH, configJsonSchema, settingsJsonSchema } from "../../harness/config-schema.ts";
import { CONFIG_FILE, Conversation, ConversationError, type NewEntry } from "../../harness/conversation.ts";
import { envSource, layered, parseDotenv, redactionPatterns, repoSecretSource, SecretFileError } from "../../harness/secrets.ts";
import { defaultRegistry } from "../../providers/index.ts";
import { AdapterRegistry, buildProviders, defineAdapter, ProviderSetupError, validateProviders } from "../../providers/registry.ts";
import { tempDir } from "../support/tmp.ts";
import { z } from "zod";

const host = nodeHost();
const KEY = "sk-ant-api03-THE-SECRET-VALUE";
const CONFIG = `providers:
  claude:
    $tag: anthropic
    api_key_env: ANTHROPIC_API_KEY
  gpt:
    $tag: openai
    api_key_env: OPENAI_API_KEY
    store: false
    max_concurrent: 2
  local:
    $tag: openai
    base_url: http://localhost:11434/v1
`;
const env = { ANTHROPIC_API_KEY: KEY, OPENAI_API_KEY: "sk-proj-OTHER-SECRET" };
const registry = defaultRegistry();
const opts = (e: Record<string, string | undefined> = env) => ({ providers: { registry, secrets: envSource(e) } });
const dirOf = async () => join(await tempDir(), "conv");
const user = (text: string): NewEntry => ({ $tag: "user", content: [{ $tag: "text", text }] });

describe("secrets", () => {
  test("dotenv syntax", () => {
    const m = parseDotenv(`# comment\nA=1\nexport B = two words # trailing\nC="quoted # not a comment"\nD='single'\n\nbad line\nE=\n`);
    assert.deepEqual([...m], [["A", "1"], ["B", "two words"], ["C", "quoted # not a comment"], ["D", "single"], ["E", ""]]);
  });

  test("the first non-empty source wins", async () => {
    const s = layered(envSource({ A: "", B: "env" }), envSource({ A: "second", B: "second", C: "third" }));
    assert.deepEqual([await s.get("A"), await s.get("B"), await s.get("C"), await s.get("D")], ["second", "env", "third", undefined]);
  });

  test("short values are not redacted (they would mangle ordinary text); long ones are, with regex characters escaped", () => {
    const [p, ...rest] = redactionPatterns(["short", "a.b*c+d?e(f)g", "a.b*c+d?e(f)g"]);
    assert.equal(rest.length, 0);
    assert.equal("x a.b*c+d?e(f)g y aXb".replace(p as RegExp, "[R]"), "x [R] y aXb");
  });

  test("repoSecretSource: environment, the worktree's ignored file, then the file inside .git", async () => {
    const dir = await dirOf();
    await Conversation.create(host, dir, {});
    const git = (await Conversation.open(host, dir)).git;
    const shared = join(await git.commonDir(), "chattree", "env");
    await mkdir(join(shared, ".."), { recursive: true });
    await writeFile(shared, "S=from-git-dir\nW=shared-loses\nE=shared-loses\n");
    await mkdir(join(dir, ".chattree"), { recursive: true });
    await writeFile(join(dir, ".chattree", "env"), "W=from-worktree\nE=worktree-loses\n");
    const s = repoSecretSource(host, dir, { E: "from-env" });
    assert.deepEqual([await s.get("E"), await s.get("W"), await s.get("S"), await s.get("N")], ["from-env", "from-worktree", "from-git-dir", undefined]);
  });

  test("a worktree secrets file that git does not ignore is refused, with the reason", async () => {
    const dir = await dirOf();
    const convo = await Conversation.create(host, dir, {});
    await writeFile(join(dir, ".gitignore"), "");
    await convo.snapshot();
    await mkdir(join(dir, ".chattree"), { recursive: true });
    await writeFile(join(dir, ".chattree", "env"), "K=v\n");
    await assert.rejects(repoSecretSource(host, dir, {}).get("K"), (e) => e instanceof SecretFileError && /does not ignore it/.test(e.message));
  });
});

describe("registry and providers", () => {
  test("every provider is checked against its adapter; all problems at once", async () => {
    const { issues } = await validateProviders({ a: { $tag: "nope" }, b: { $tag: "anthropic", api_key_env: "sk-ant-abc", extra: 1 } as never, c: { $tag: "openai", max_concurrent: 0 } as never }, registry);
    const by = Object.fromEntries(issues.map((i) => [i.path, i.message]));
    assert.match(by["providers.a.$tag"] ?? "", /no adapter for "nope" \(known: anthropic, openai, openai-compatible\)/);
    assert.match(by["providers.b.api_key_env"] ?? "", /NAME of an environment variable/);
    assert.ok(Object.keys(by).some((k) => k.startsWith("providers.b") && /nrecognized|extra/.test(by[k] ?? "")), JSON.stringify(by));
    assert.ok("providers.c.max_concurrent" in by);
  });

  test("missing variables are reported by name and provider, all of them", async () => {
    await assert.rejects(buildProviders({ claude: { $tag: "anthropic", api_key_env: "A_KEY" } as never, gpt: { $tag: "openai", api_key_env: "B_KEY" } as never, local: { $tag: "openai" } }, registry, envSource({})), (e) => {
      assert.ok(e instanceof ProviderSetupError);
      assert.deepEqual(e.issues.map((i) => i.path), ["providers.claude", "providers.gpt"]);
      assert.match(e.issues[0]?.message ?? "", /A_KEY is not set/);
      return true;
    });
  });

  test("a provider that needs no key builds without one; adapters carry their tag", async () => {
    const b = await buildProviders({ local: { $tag: "openai", base_url: "http://localhost:1/v1" } as never }, registry, envSource({}));
    assert.equal(b.adapters.get("local")?.$tag, "openai");
    assert.deepEqual(b.secretValues, []);
  });

  test("a third-party adapter registers with its own schema library", async () => {
    const reg = new AdapterRegistry().register(
      defineAdapter({
        $tag: "toy",
        config: z.strictObject({ $tag: z.literal("toy"), token_env: z.string() }),
        settings: z.strictObject({ n: z.number() }),
        jsonSchema: () => ({ config: { type: "object" }, settings: { type: "object" } }),
        secrets: (c) => [c.token_env],
        create: (_c, s) => ({ $tag: "toy", stream: (() => { throw new Error(String(s.get("T"))); }) as never }),
      }),
    );
    assert.throws(() => reg.register(reg.get("toy") as never), /already registered/);
    const b = await buildProviders({ t: { $tag: "toy", token_env: "T" } as never }, reg, envSource({ T: "v" }));
    assert.equal(b.adapters.get("t")?.$tag, "toy");
  });
});

describe("JSON Schema", () => {
  const schema = configJsonSchema(registry) as { properties: Record<string, { additionalProperties?: { oneOf: { title: string; properties: Record<string, unknown>; required: string[] }[] } }> };

  test("core keys, and one variant per adapter discriminated by a $tag const", () => {
    assert.deepEqual(Object.keys(schema.properties).sort(), ["attachments", "background", "compaction", "leases", "limits", "maintenance", "providers", "subagent", "tools"]);
    const variants = schema.properties["providers"]?.additionalProperties?.oneOf ?? [];
    assert.deepEqual(variants.map((v) => v.title), ["anthropic", "openai", "openai-compatible"]);
    for (const v of variants) {
      assert.equal((v.properties["$tag"] as { const: string }).const, v.title);
      assert.ok(v.required.includes("$tag"));
    }
    assert.ok("api_key_env" in (variants[0]?.properties ?? {}));
    assert.ok("store" in (variants[1]?.properties ?? {}));
  });

  test("settings schemas per adapter", () => {
    const s = settingsJsonSchema(registry, "openai") as { required: string[] };
    assert.deepEqual(s.required, ["max_output_tokens"]);
    assert.equal(settingsJsonSchema(registry, "nope"), undefined);
  });
});

describe("a model's tool convention", () => {
  const withModels = (convention: string): string => `providers:\n  local:\n    $tag: openai-compatible\n    base_url: http://localhost:11434/v1\n    models:\n      "gpt-oss:20b":\n        tool_convention: ${convention}\n`;
  test("is set per model in harness.yml, read back by modelInfo, and unknown for a model that was not named", async () => {
    const dir = await dirOf();
    const convo = await Conversation.create(host, dir, { ...opts(), config: withModels("flat") });
    assert.equal(convo.modelInfo("local", "gpt-oss:20b")?.tool_convention, "flat");
    assert.equal(convo.modelInfo("local", "gemma4:12b")?.tool_convention, undefined);
  });
  test("a value other than full or flat is refused where it is written", async () => {
    await assert.rejects(Conversation.create(host, await dirOf(), { ...opts(), config: withModels("nested") }), /tool_convention/);
  });
});

describe("create and open", () => {
  test("create validates, adds the editor line, writes the schema into an ignored directory, and nothing of it is committed", async () => {
    const dir = await dirOf();
    const convo = await Conversation.create(host, dir, { ...opts(), config: CONFIG });
    const text = await readFile(join(dir, CONFIG_FILE), "utf8");
    assert.ok(text.startsWith("# yaml-language-server: $schema=./.chattree/harness.schema.json\n"));
    const schema = JSON.parse(await readFile(join(dir, SCHEMA_PATH), "utf8")) as { title: string };
    assert.equal(schema.title, "chattree harness.yml");
    assert.equal(await convo.git.isClean(), true);
    assert.deepEqual((await convo.git.listFiles([".chattree"], "tracked")), []);
    assert.equal(await readFile(join(dir, ".gitignore"), "utf8").then((t) => t.includes("/.chattree/")), true);
    assert.deepEqual([...convo.providers.keys()].sort(), ["claude", "gpt", "local"]);
    assert.equal(convo.provider("claude").$tag, "anthropic");
    assert.throws(() => convo.provider("nope"), (e) => e instanceof ConversationError && /have: claude, gpt, local/.test(e.message));
    const r = await convo.readConfig();
    assert.ok(r?.ok);
  });

  test("an existing editor line is kept; a bad tag or key fails create and leaves nothing behind", async () => {
    const dir = await dirOf();
    const mine = `# yaml-language-server: $schema=other.json\n${CONFIG}`;
    await Conversation.create(host, dir, { ...opts(), config: mine });
    assert.equal(await readFile(join(dir, CONFIG_FILE), "utf8"), mine);
    const dir2 = await dirOf();
    await assert.rejects(Conversation.create(host, dir2, { ...opts(), config: "providers:\n  x:\n    $tag: nope\n" }), (e) => e instanceof ConversationError && /no adapter for "nope"/.test(e.message));
    await assert.rejects(Conversation.create(host, dir2, { ...opts({}), config: CONFIG }), (e) => e instanceof ConversationError && /ANTHROPIC_API_KEY is not set/.test(e.message) && /OPENAI_API_KEY is not set/.test(e.message));
    assert.equal(await readFile(join(dir2, CONFIG_FILE), "utf8").catch(() => undefined), undefined);
  });

  test("open builds the providers, fails early on a missing variable, and forks share the adapters", async () => {
    const dir = await dirOf();
    await Conversation.create(host, dir, { config: CONFIG });
    await assert.rejects(Conversation.open(host, dir, opts({ ANTHROPIC_API_KEY: KEY })), (e) => e instanceof ConversationError && /providers\.gpt: the environment variable OPENAI_API_KEY is not set/.test(e.message));
    const convo = await Conversation.open(host, dir, opts());
    assert.equal(convo.providers.size, 3);
    assert.equal(JSON.parse(await readFile(join(dir, SCHEMA_PATH), "utf8")).title, "chattree harness.yml", "open regenerates the schema in every worktree");
    await convo.append(user("hi"));
    const child = (await convo.fork(undefined, { name: "side" })).conversation;
    assert.ok(child !== undefined);
    assert.equal(child.provider("claude"), convo.provider("claude"), "the same adapter objects, so concurrency limits are shared");
  });

  test("a hand edit with an unknown key in a provider is reported by readConfig", async () => {
    const dir = await dirOf();
    const convo = await Conversation.create(host, dir, { ...opts(), config: CONFIG });
    await writeFile(join(dir, CONFIG_FILE), CONFIG.replace("store: false", "stor: false"));
    const r = await convo.readConfig();
    assert.ok(r !== undefined && !r.ok && r.issues.some((i) => i.path.startsWith("providers.gpt")));
  });

  test("resolved secrets never reach the transcript, even if a tool result echoes one", async () => {
    const dir = await dirOf();
    const convo = await Conversation.create(host, dir, { ...opts(), config: CONFIG });
    await convo.append(user(`my key is ${KEY} and the other is sk-proj-OTHER-SECRET`));
    const text = await readFile(join(dir, "chat.yml"), "utf8");
    assert.ok(!text.includes(KEY) && !text.includes("OTHER-SECRET"));
    assert.ok(text.includes("[REDACTED]"));
  });
});
