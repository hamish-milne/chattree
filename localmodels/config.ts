import { Type, type Static, type StaticDecode } from "typebox";
import { parser, record, rules, said, strictObject } from "../src/validate.ts";

/**
 * The `local_models` section of the user's settings file (docs/local-models.md, section 4): the models to download and run, the
 * llama.cpp release to run them with, and how the server is reached. Pure data: nothing here touches the network or the disk.
 */

const opt = Type.Optional;
const pattern = (re: RegExp, message: string) => said(message, Type.String({ pattern: re.source }));

const name = pattern(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/,
  "letters, digits and . _ : -, starting with a letter or digit, at most 64 characters",
);
const envName = pattern(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name");
const sha256 = Type.Codec(pattern(/^[0-9a-fA-F]{64}$/, "64 hexadecimal digits"))
  .Decode((s) => s.toLowerCase())
  .Encode((s) => s);
const httpUrl = said("an http or https address", Type.String({ format: "url", pattern: "^https?:" }));

/** `b12110` (a llama.cpp build) or `v0.9.0` (a release that points at one: `resolveTag`). */
export const LLAMA_TAG = /^(b\d+|v\d+\.\d+(\.\d+)?)$/;

export const BACKENDS = ["auto", "cpu", "cuda", "vulkan", "rocm", "sycl", "openvino", "metal"] as const;
export type Backend = (typeof BACKENDS)[number];

const nonNegative = Type.Integer({ minimum: 0 });
const positive = Type.Integer({ minimum: 1 });
const nonEmpty = Type.String({ minLength: 1 });

/** What a llama-server option may be given in the preset file: the long option name without dashes. */
const optionValue = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

/** The types of speculative decoding (docs/local-models.md, 9.8), named as llama-server's `--spec-type` does. */
export const SPEC_TYPES = [
  "none",
  "ngram-simple",
  "ngram-map-k",
  "ngram-map-k4v",
  "ngram-mod",
  "ngram-cache",
  "draft-simple",
  "draft-mtp",
  "draft-eagle3",
] as const;
/** The types that run a second model. */
export const DRAFT_TYPES = ["draft-simple", "draft-mtp", "draft-eagle3"] as const;
export const isDraftType = (t: string): boolean => (DRAFT_TYPES as readonly string[]).includes(t);
/** `org/repo` or `org/repo:QUANT` on Hugging Face. */
const hfRef = pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9_.-]+)?$/, "org/repo or org/repo:QUANT");

/**
 * A file that goes with a model and is fetched like it (the multimodal projector, the draft model): `auto`, or one of `url` (a direct
 * address), `file` (a file of the model's own Hugging Face repository), `hf` (another repository, `org/repo` or `org/repo:QUANT`; with a
 * `file` that file, without one the repository's only fitting file). `auto` looks in the model's own repository by the usual names.
 */
const sidecarObject = strictObject({
  url: opt(httpUrl),
  hf: opt(hfRef),
  file: opt(nonEmpty),
  /** For `hf`: the revision of that repository (default `main`). */
  revision: opt(nonEmpty),
  sha256: opt(sha256),
});
const sidecar = Type.Union([Type.Literal("auto"), sidecarObject]);
export type Sidecar = StaticDecode<typeof sidecar>;

/** What is wrong with a sidecar, given whether its model comes from Hugging Face; the sentences name the sidecar. */
function sidecarProblems(what: string, v: Sidecar | undefined, modelHf: boolean): string[] {
  const out: string[] = [];
  if (v === undefined) return out;
  if (v === "auto") {
    if (!modelHf) out.push(`${what}: auto looks in the model's Hugging Face repository; this model has a url`);
    return out;
  }
  if (v.url !== undefined && (v.hf !== undefined || v.file !== undefined)) out.push(`${what}: give a url, or hf and file, not both`);
  if (v.url === undefined && v.hf === undefined && v.file === undefined) out.push(`${what}: give a url, a file, an hf repository, or auto`);
  if (v.file !== undefined && v.hf === undefined && !modelHf)
    out.push(`${what}: a file belongs to a Hugging Face repository: give hf, or use a url`);
  if (v.revision !== undefined && v.hf === undefined) out.push(`${what}: revision goes with hf`);
  return out;
}

const speculativeBase = strictObject({
  type: Type.Enum(SPEC_TYPES),
  /** The longest draft, and the shortest one worth making (for ngram-mod, its `n-max` and `n-min`). */
  draft_max: opt(positive),
  draft_min: opt(nonNegative),
  /** The length of the n-gram looked up in the history (for ngram-mod, `n-match`), and of the run drafted after a match (not used by ngram-mod). */
  ngram_n: opt(positive),
  ngram_m: opt(positive),
  /** How many times a key must have been seen before it drafts (ngram-map types). */
  min_hits: opt(positive),
  /** The second model of a draft type: where its file is (a sidecar, as `mmproj`). */
  draft: opt(sidecar),
  /** The least probability a drafted token needs to be kept (draft types). */
  p_min: opt(Type.Number({ minimum: 0, maximum: 1 })),
});
type SpecFields = Static<typeof speculativeBase>;
const hasNgram = (v: SpecFields): boolean => v.ngram_n !== undefined || v.ngram_m !== undefined || v.min_hits !== undefined;
const speculativeObject = rules(speculativeBase, [
  (v) =>
    v.type === "ngram-mod" && (v.ngram_m !== undefined || v.min_hits !== undefined) ? "ngram-mod has no ngram_m or min_hits" : undefined,
  (v) => (isDraftType(v.type) && v.draft === undefined ? `${v.type} needs a draft: auto, a url, a file, or an hf repository` : undefined),
  (v) => (!isDraftType(v.type) && (v.draft !== undefined || v.p_min !== undefined) ? `${v.type} has no draft model or p_min` : undefined),
  (v) => (isDraftType(v.type) && hasNgram(v) ? `${v.type} has no n-gram options` : undefined),
  (v) => (v.type === "ngram-cache" && hasNgram(v) ? "ngram-cache has no n-gram options" : undefined),
]);
export type Speculative = StaticDecode<typeof speculativeBase>;

/** Settings that apply to every model (`defaults`) or to one. */
const params = {
  ctx_size: opt(positive),
  /** Layers on the GPU: a number, `auto` or `all`. */
  n_gpu_layers: opt(Type.Union([nonNegative, Type.Enum(["auto", "all"])])),
  flash_attn: opt(Type.Enum(["on", "off", "auto"])),
  threads: opt(positive),
  parallel: opt(positive),
  /** llama-server uses the model's own chat template through its Jinja engine by default; `false` turns that off. */
  jinja: opt(Type.Boolean()),
  cache_type_k: opt(nonEmpty),
  cache_type_v: opt(nonEmpty),
  /** Seconds idle before the model is unloaded from memory (it is loaded again by the next request). */
  sleep_idle_seconds: opt(nonNegative),
  /** Speculative decoding: a type (`ngram-mod`) or an object with its tuning. Outputs are the same with it on or off; only speed changes. */
  speculative: opt(
    Type.Union([
      Type.Codec(Type.Enum(SPEC_TYPES))
        .Decode((type): Speculative => ({ type }))
        .Encode((s) => s.type),
      speculativeObject,
    ]),
  ),
  /** Any other llama-server option, by its long name without the dashes (`rope-scale: 2`). Written to the preset file as it is. */
  options: opt(record(pattern(/^[a-z][a-z0-9-]*$/, "a long option name without dashes, in lower case"), optionValue)),
};

const sampling = strictObject({
  temperature: opt(Type.Number({ minimum: 0, maximum: 5 })),
  top_p: opt(Type.Number({ minimum: 0, maximum: 1 })),
  top_k: opt(nonNegative),
  min_p: opt(Type.Number({ minimum: 0, maximum: 1 })),
  repeat_penalty: opt(Type.Number({ minimum: 0 })),
  presence_penalty: opt(Type.Number()),
  frequency_penalty: opt(Type.Number()),
});
export type Sampling = StaticDecode<typeof sampling>;

const modelBase = strictObject({
  /** Where the GGUF file is: a direct URL, or ... */
  url: opt(httpUrl),
  /** ... a Hugging Face repository (`org/repo:Q4_K_M`; a `file` names the exact file instead of a quantisation). */
  hf: opt(hfRef),
  file: opt(nonEmpty),
  revision: Type.String({ minLength: 1, default: "main" }),
  /** The SHA-256 the file must have. Hugging Face tells it, so it is optional there. */
  sha256: opt(sha256),
  /** The multimodal projector for a vision model: a URL, or a file of the same Hugging Face repository. */
  mmproj: opt(sidecar),
  description: opt(nonEmpty),
  aliases: opt(Type.Array(name)),
  /** Start it when the server starts, rather than at the first request. */
  load_on_startup: opt(Type.Boolean()),
  embeddings: opt(Type.Boolean()),
  sampling: opt(sampling),
  /** How tool definitions must be written for this model (docs/tools.md, 3.7). */
  tool_convention: opt(Type.Enum(["full", "flat"])),
  /** A chat template file to use instead of the model's own; a relative path is relative to the settings file. */
  chat_template: opt(nonEmpty),
  ...params,
});
type ModelFields = Static<typeof modelBase>;

/** The speculative setting as the object it means (it may be written as just a type, which has no draft). */
const specOf = (s: ModelFields["speculative"]): SpecFields | undefined => (typeof s === "object" ? s : undefined);

/** The rules between a model's fields. They are reported at the model, and the sentence says which field it is about. */
const modelEntry = rules(modelBase, [
  (m) => ((m.url === undefined) === (m.hf === undefined) ? "give either url or hf, not both and not neither" : undefined),
  (m) => (m.url !== undefined && m.file !== undefined ? "file goes with hf; a url already names the file" : undefined),
  (m) => sidecarProblems("the projector", m.mmproj, m.hf !== undefined).join("; ") || undefined,
  (m) => sidecarProblems("the draft model", specOf(m.speculative)?.draft, m.hf !== undefined).join("; ") || undefined,
]);
export type ModelEntry = StaticDecode<typeof modelEntry>;

const llamaCpp = strictObject(
  {
    /** The release to run: a build (`b12110`) or a release that points at one (`v0.9.0`). No tag, no download: `chattree models update` picks the newest and writes it here. */
    tag: opt(said("a build such as b12110, or a version such as v0.9.0", Type.String({ pattern: LLAMA_TAG.source }))),
    backend: Type.Enum(BACKENDS, { default: "auto" }),
    /** With the cuda backend, the CUDA version to prefer (`12.8`); default the newest the release has. */
    cuda: opt(Type.String({ pattern: "^\\d+(\\.\\d+)?$" })),
    /** Use this llama-server instead of fetching one. */
    path: opt(nonEmpty),
  },
  { default: {} },
);

const server = strictObject(
  {
    host: Type.String({ minLength: 1, default: "127.0.0.1" }),
    /** `auto` lets the host choose a free port and record it. */
    port: Type.Union([Type.Literal("auto"), Type.Integer({ minimum: 1, maximum: 65535 })], { default: "auto" }),
    /** How many models stay in memory at once; the least recently used is unloaded for the next. 0 is no limit. */
    models_max: Type.Integer({ minimum: 0, default: 1 }),
    /** Stop the host when it has had no request for this many minutes. Default: never. */
    idle_exit_minutes: opt(positive),
    /** How long to wait, in seconds, for llama-server to answer after it starts. */
    health_timeout: Type.Integer({ minimum: 1, default: 60 }),
    /** Serve llama-server's own web page. */
    webui: Type.Boolean({ default: false }),
  },
  { default: {} },
);

const localModels = strictObject({
  /** The engine that runs the models. Only `router` (llama-server's own router mode) exists so far; the host is written against an interface so another can be added. */
  engine: Type.Literal("router", { default: "router" }),
  llama_cpp: llamaCpp,
  server,
  defaults: rules(strictObject(params, { default: {} }), [
    (d) =>
      specOf(d.speculative)?.draft !== undefined
        ? "speculative.draft: a draft model belongs to one model: set speculative on the model"
        : undefined,
  ]),
  /** The environment variable that holds a Hugging Face token, for repositories that need one. */
  hf_token_env: opt(envName),
  models: rules(record(name, modelEntry, { default: {} }), [
    (models) => {
      const seen = new Map<string, string>();
      for (const [model, m] of Object.entries(models)) {
        for (const n of [model, ...(m.aliases ?? [])]) {
          const other = seen.get(n);
          if (other !== undefined && other !== model) return `the name ${n} is also used by ${other}`;
          seen.set(n, model);
        }
      }
      return undefined;
    },
  ]),
});

export const localModelsSchema = parser(localModels);
export type LocalModels = StaticDecode<typeof localModels>;

/** Where a model's file comes from, as far as the settings alone say. */
export type ModelSource =
  | { kind: "url"; url: string; file: string }
  | { kind: "hf"; repo: string; revision: string; file: string }
  | { kind: "hf-quant"; repo: string; revision: string; quant: string | undefined };

const lastSegment = (path: string): string =>
  decodeURIComponent(
    path
      .split("/")
      .filter((s) => s !== "")
      .at(-1) ?? "",
  );

/** The file a model entry names, or what has to be asked of Hugging Face to find it. Undefined for a url that does not end in `.gguf`. */
export function modelSource(m: ModelEntry): ModelSource | undefined {
  if (m.url !== undefined) {
    const file = lastSegment(new URL(m.url).pathname);
    return file.toLowerCase().endsWith(".gguf") ? { kind: "url", url: m.url, file } : undefined;
  }
  const hf = m.hf;
  if (hf === undefined) return undefined; // the settings check gives every model a url or an hf
  const at = hf.indexOf(":");
  const repo = at < 0 ? hf : hf.slice(0, at);
  if (m.file !== undefined) return { kind: "hf", repo, revision: m.revision, file: m.file };
  return { kind: "hf-quant", repo, revision: m.revision, quant: at < 0 ? undefined : hf.slice(at + 1) };
}

/** The address a file of a Hugging Face repository is downloaded from. */
export const hfUrl = (repo: string, revision: string, file: string): string =>
  `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${file.split("/").map(encodeURIComponent).join("/")}`;
