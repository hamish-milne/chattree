import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { describe, test } from "node:test";
import { localModelsSchema, modelSource } from "../../localmodels/config.ts";
import { dataDir, downloadList, presetIni, routerArgs } from "../../localmodels/plan.ts";

const parse = (v: unknown) => localModelsSchema.parse(v);
const bad = (v: unknown) => {
  const r = localModelsSchema.safeParse(v);
  assert.equal(r.success, false);
  return r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
};

describe("the local_models section", () => {
  test("has defaults", () => {
    const c = parse({});
    assert.equal(c.engine, "router");
    assert.deepEqual(c.server, { host: "127.0.0.1", port: "auto", models_max: 1, health_timeout: 60, webui: false });
    assert.equal(c.llama_cpp.backend, "auto");
    assert.deepEqual(c.models, {});
  });

  test("a model has a url or hf, not both, not neither", () => {
    assert.match(bad({ models: { a: {} } }), /either url or hf/);
    assert.match(bad({ models: { a: { url: "https://x.test/a.gguf", hf: "o/r" } } }), /either url or hf/);
    assert.match(bad({ models: { a: { url: "https://x.test/a.gguf", file: "b.gguf" } } }), /file goes with hf/);
    assert.match(bad({ models: { a: { hf: "o/r", mmproj: { url: "https://x.test/p.gguf", file: "p.gguf" } } } }), /url or file/);
    assert.match(bad({ models: { a: { url: "https://x.test/a.gguf", mmproj: { file: "p.gguf" } } } }), /belongs to a Hugging Face/);
  });

  test("tags, names and unknown keys are checked", () => {
    assert.match(bad({ llama_cpp: { tag: "latest" } }), /tag/);
    parse({ llama_cpp: { tag: "b12110" } });
    parse({ llama_cpp: { tag: "v0.9.0" } });
    assert.match(bad({ models: { "bad name": { hf: "o/r" } } }), /bad name/);
    assert.match(bad({ models: { a: { hf: "o/r", nope: 1 } } }), /nope|Unrecognized/);
    assert.match(bad({ models: { a: { hf: "o/r", aliases: ["b"] }, b: { hf: "o/s" } } }), /also used by/);
  });

  test("a source is a file, or a quantisation to look up", () => {
    assert.deepEqual(modelSource(parse({ models: { a: { url: "https://x.test/d/Model%20Q4.gguf?download=1" } } }).models["a"]!), { kind: "url", url: "https://x.test/d/Model%20Q4.gguf?download=1", file: "Model Q4.gguf" });
    assert.equal(modelSource(parse({ models: { a: { url: "https://x.test/d/model" } } }).models["a"]!), undefined);
    assert.deepEqual(modelSource(parse({ models: { a: { hf: "o/r:Q4_K_M" } } }).models["a"]!), { kind: "hf-quant", repo: "o/r", revision: "main", quant: "Q4_K_M" });
    assert.deepEqual(modelSource(parse({ models: { a: { hf: "o/r", file: "sub/m.gguf", revision: "v1" } } }).models["a"]!), { kind: "hf", repo: "o/r", revision: "v1", file: "sub/m.gguf" });
  });
});

describe("the data directory", () => {
  const posixHost = { platform: "posix" as const, path: posix };
  const windowsHost = { platform: "windows" as const, path: win32 };
  test("settings, CHATTREE_DATA, then the user's data directory", () => {
    assert.equal(dataDir(posixHost, { CHATTREE_DATA: "/e" }, "/s"), "/s");
    assert.equal(dataDir(posixHost, { CHATTREE_DATA: "/e" }, undefined), "/e");
    assert.equal(dataDir(posixHost, { XDG_DATA_HOME: "/x", HOME: "/h" }, undefined), "/x/chattree");
    assert.equal(dataDir(posixHost, { HOME: "/h" }, undefined), "/h/.local/share/chattree");
    assert.equal(dataDir(posixHost, {}, undefined), undefined);
    assert.equal(dataDir(windowsHost, { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, undefined), "C:\\Users\\a\\AppData\\Local\\chattree");
  });
});

describe("the plan", () => {
  const config = parse({
    hf_token_env: "HF_TOKEN",
    defaults: { ctx_size: 8192, flash_attn: "on", options: { "rope-scale": 2 } },
    server: { port: 8089, models_max: 2 },
    models: {
      zeta: { hf: "o/z:Q4_K_M", sampling: { temperature: 0.6, top_k: 20 } },
      alpha: { url: "https://x.test/a/alpha-q8.gguf", sha256: "A".repeat(64), ctx_size: 32768, jinja: true, load_on_startup: true, mmproj: { url: "https://x.test/a/mm.gguf" } },
      vision: { hf: "o/v", file: "dir/v-q4.gguf", mmproj: { file: "dir/mm.gguf" }, embeddings: false },
      broken: { url: "https://x.test/a/noext" },
    },
  });

  test("lists the files to fetch in model order, with where they go", () => {
    const { downloads, issues } = downloadList(config, posix, "/data");
    assert.deepEqual(issues.map((i) => i.model), ["broken"]);
    assert.deepEqual(
      downloads.map((d) => [d.model, d.role, d.url, d.dest, d.sha256]),
      [
        ["alpha", "model", "https://x.test/a/alpha-q8.gguf", "/data/models/alpha/alpha-q8.gguf", "a".repeat(64)],
        ["alpha", "mmproj", "https://x.test/a/mm.gguf", "/data/models/alpha/mm.gguf", undefined],
        ["vision", "model", "https://huggingface.co/o/v/resolve/main/dir/v-q4.gguf", "/data/models/vision/v-q4.gguf", undefined],
        ["vision", "mmproj", "https://huggingface.co/o/v/resolve/main/dir/mm.gguf", "/data/models/vision/mm.gguf", undefined],
        ["zeta", "model", undefined, undefined, undefined],
      ],
    );
    assert.deepEqual(downloads.at(-1)?.resolve, { repo: "o/z", revision: "main", quant: "Q4_K_M" });
  });

  test("writes the same preset every time, in name order", () => {
    const files = {
      zeta: { file: "/data/models/zeta/z.gguf" },
      alpha: { file: "/data/models/alpha/alpha-q8.gguf", mmproj: "/data/models/alpha/mm.gguf", template: "/t/chat.jinja" },
      vision: { file: "/data/models/vision/v-q4.gguf" },
    };
    const a = presetIni(config, files);
    assert.equal(a, presetIni(config, { ...files }));
    assert.equal(
      a,
      `version = 1

[*]
ctx-size = 8192
flash-attn = on
rope-scale = 2

[alpha]
model = /data/models/alpha/alpha-q8.gguf
mmproj = /data/models/alpha/mm.gguf
chat-template-file = /t/chat.jinja
ctx-size = 32768
jinja = true
load-on-startup = true

[vision]
model = /data/models/vision/v-q4.gguf

[zeta]
model = /data/models/zeta/z.gguf
temp = 0.6
top-k = 20
`,
    );
  });

  test("a model whose file is not there yet is left out of the preset", () => {
    assert.doesNotMatch(presetIni(config, { alpha: { file: "/a.gguf" } }), /\[zeta\]|\[vision\]/);
  });

  test("starts the router with the settled port", () => {
    assert.deepEqual(routerArgs(config, "/data/preset.ini", 8089), ["--models-preset", "/data/preset.ini", "--host", "127.0.0.1", "--port", "8089", "--models-max", "2", "--no-webui"]);
    assert.ok(!routerArgs(parse({ server: { webui: true } }), "/p.ini", 1).includes("--no-webui"));
  });
});
