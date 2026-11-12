import { z } from "zod";

/**
 * The `local_models` section of the user's settings file (docs/local-models.md, section 4): the models to download and run, the
 * llama.cpp release to run them with, and how the server is reached. Pure data: nothing here touches the network or the disk.
 */

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, "letters, digits and . _ : -, starting with a letter or digit, at most 64 characters");
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name");
const sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hexadecimal digits").transform((s) => s.toLowerCase());

/** `b12110` (a llama.cpp build) or `v0.9.0` (a release that points at one: `resolveTag`). */
export const LLAMA_TAG = /^(b\d+|v\d+\.\d+(\.\d+)?)$/;

export const BACKENDS = ["auto", "cpu", "cuda", "vulkan", "rocm", "sycl", "openvino", "metal"] as const;
export type Backend = (typeof BACKENDS)[number];

const nonNegative = z.number().int().min(0);

/** What a llama-server option may be given in the preset file: the long option name without dashes. */
const optionValue = z.union([z.string(), z.number(), z.boolean()]);

/** The types of speculative decoding (docs/local-models.md, 9.8), named as llama-server's `--spec-type` does. */
export const SPEC_TYPES = ["none", "ngram-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod", "ngram-cache", "draft-simple", "draft-mtp", "draft-eagle3"] as const;
/** The types that run a second model. */
export const DRAFT_TYPES = ["draft-simple", "draft-mtp", "draft-eagle3"] as const;
export const isDraftType = (t: string): boolean => (DRAFT_TYPES as readonly string[]).includes(t);
/** `org/repo` or `org/repo:QUANT` on Hugging Face. */
const hfRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(:[A-Za-z0-9_.-]+)?$/, "org/repo or org/repo:QUANT");

/**
 * A file that goes with a model and is fetched like it (the multimodal projector, the draft model): `auto`, or one of `url` (a direct
 * address), `file` (a file of the model's own Hugging Face repository), `hf` (another repository, `org/repo` or `org/repo:QUANT`; with a
 * `file` that file, without one the repository's only fitting file). `auto` looks in the model's own repository by the usual names.
 */
const sidecarFields = {
  url: z.url({ protocol: /^https?$/ }).optional(),
  hf: hfRef.optional(),
  file: z.string().min(1).optional(),
  /** For `hf`: the revision of that repository (default `main`). */
  revision: z.string().min(1).optional(),
  sha256: sha256.optional(),
};
const sidecarObject = z.strictObject(sidecarFields);
const sidecar = z.union([z.literal("auto"), sidecarObject]);
export type Sidecar = z.infer<typeof sidecar>;
const sidecarIssues = (what: string, v: Sidecar | undefined, modelHf: boolean, path: (string | number)[], ctx: z.RefinementCtx): void => {
  if (v === undefined || v === "auto") {
    if (v === "auto" && !modelHf) ctx.addIssue({ code: "custom", path, message: `${what}: auto looks in the model's Hugging Face repository; this model has a url` });
    return;
  }
  if (v.url !== undefined && (v.hf !== undefined || v.file !== undefined)) ctx.addIssue({ code: "custom", path, message: `${what}: give a url, or hf and file, not both` });
  if (v.url === undefined && v.hf === undefined && v.file === undefined) ctx.addIssue({ code: "custom", path, message: `${what}: give a url, a file, an hf repository, or auto` });
  if (v.file !== undefined && v.hf === undefined && !modelHf) ctx.addIssue({ code: "custom", path: [...path, "file"], message: `${what}: a file belongs to a Hugging Face repository: give hf, or use a url` });
  if (v.revision !== undefined && v.hf === undefined) ctx.addIssue({ code: "custom", path: [...path, "revision"], message: `${what}: revision goes with hf` });
};

const speculativeObject = z
  .strictObject({
    type: z.enum(SPEC_TYPES),
    /** The longest draft, and the shortest one worth making (for ngram-mod, its `n-max` and `n-min`). */
    draft_max: z.number().int().positive().optional(),
    draft_min: nonNegative.optional(),
    /** The length of the n-gram looked up in the history (for ngram-mod, `n-match`), and of the run drafted after a match (not used by ngram-mod). */
    ngram_n: z.number().int().positive().optional(),
    ngram_m: z.number().int().positive().optional(),
    /** How many times a key must have been seen before it drafts (ngram-map types). */
    min_hits: z.number().int().positive().optional(),
    /** The second model of a draft type: where its file is (a sidecar, as `mmproj`). */
    draft: sidecar.optional(),
    /** The least probability a drafted token needs to be kept (draft types). */
    p_min: z.number().min(0).max(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "ngram-mod" && (v.ngram_m !== undefined || v.min_hits !== undefined)) ctx.addIssue({ code: "custom", message: "ngram-mod has no ngram_m or min_hits" });
    if (isDraftType(v.type) && v.draft === undefined) ctx.addIssue({ code: "custom", message: `${v.type} needs a draft: auto, a url, a file, or an hf repository` });
    if (!isDraftType(v.type) && (v.draft !== undefined || v.p_min !== undefined)) ctx.addIssue({ code: "custom", message: `${v.type} has no draft model or p_min` });
    if (isDraftType(v.type) && (v.ngram_n !== undefined || v.ngram_m !== undefined || v.min_hits !== undefined)) ctx.addIssue({ code: "custom", message: `${v.type} has no n-gram options` });
    if (v.type === "ngram-cache" && (v.ngram_n !== undefined || v.ngram_m !== undefined || v.min_hits !== undefined)) ctx.addIssue({ code: "custom", message: "ngram-cache has no n-gram options" });
  });
export type Speculative = z.infer<typeof speculativeObject>;

/** Settings that apply to every model (`defaults`) or to one. */
const params = {
  ctx_size: z.number().int().positive().optional(),
  /** Layers on the GPU: a number, `auto` or `all`. */
  n_gpu_layers: z.union([nonNegative, z.enum(["auto", "all"])]).optional(),
  flash_attn: z.enum(["on", "off", "auto"]).optional(),
  threads: z.number().int().positive().optional(),
  parallel: z.number().int().positive().optional(),
  /** llama-server uses the model's own chat template through its Jinja engine by default; `false` turns that off. */
  jinja: z.boolean().optional(),
  cache_type_k: z.string().min(1).optional(),
  cache_type_v: z.string().min(1).optional(),
  /** Seconds idle before the model is unloaded from memory (it is loaded again by the next request). */
  sleep_idle_seconds: nonNegative.optional(),
  /** Speculative decoding: a type (`ngram-mod`) or an object with its tuning. Outputs are the same with it on or off; only speed changes. */
  speculative: z.union([z.enum(SPEC_TYPES).transform((type): Speculative => ({ type })), speculativeObject]).optional(),
  /** Any other llama-server option, by its long name without the dashes (`rope-scale: 2`). Written to the preset file as it is. */
  options: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/, "a long option name without dashes, in lower case"), optionValue).optional(),
} as const;

const sampling = z.strictObject({
  temperature: z.number().min(0).max(5).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: nonNegative.optional(),
  min_p: z.number().min(0).max(1).optional(),
  repeat_penalty: z.number().min(0).optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
});
export type Sampling = z.infer<typeof sampling>;


const modelEntry = z
  .strictObject({
    /** Where the GGUF file is: a direct URL, or ... */
    url: z.url({ protocol: /^https?$/ }).optional(),
    /** ... a Hugging Face repository (`org/repo:Q4_K_M`; a `file` names the exact file instead of a quantisation). */
    hf: hfRef.optional(),
    file: z.string().min(1).optional(),
    revision: z.string().min(1).default("main"),
    /** The SHA-256 the file must have. Hugging Face tells it, so it is optional there. */
    sha256: sha256.optional(),
    /** The multimodal projector for a vision model: a URL, or a file of the same Hugging Face repository. */
    mmproj: sidecar.optional(),
    description: z.string().min(1).optional(),
    aliases: z.array(name).optional(),
    /** Start it when the server starts, rather than at the first request. */
    load_on_startup: z.boolean().optional(),
    embeddings: z.boolean().optional(),
    sampling: sampling.optional(),
    /** How tool definitions must be written for this model (docs/tools.md, 3.7). */
    tool_convention: z.enum(["full", "flat"]).optional(),
    /** A chat template file to use instead of the model's own; a relative path is relative to the settings file. */
    chat_template: z.string().min(1).optional(),
    ...params,
  })
  .superRefine((m, ctx) => {
    if ((m.url === undefined) === (m.hf === undefined)) ctx.addIssue({ code: "custom", message: "give either url or hf, not both and not neither" });
    if (m.url !== undefined && m.file !== undefined) ctx.addIssue({ code: "custom", path: ["file"], message: "file goes with hf; a url already names the file" });
    sidecarIssues("the projector", m.mmproj, m.hf !== undefined, ["mmproj"], ctx);
    sidecarIssues("the draft model", m.speculative?.draft, m.hf !== undefined, ["speculative", "draft"], ctx);
  });
export type ModelEntry = z.infer<typeof modelEntry>;

const llamaCpp = z.strictObject({
  /** The release to run: a build (`b12110`) or a release that points at one (`v0.9.0`). No tag, no download: `chattree models update` picks the newest and writes it here. */
  tag: z.string().regex(LLAMA_TAG, "a build such as b12110, or a version such as v0.9.0").optional(),
  backend: z.enum(BACKENDS).default("auto"),
  /** With the cuda backend, the CUDA version to prefer (`12.8`); default the newest the release has. */
  cuda: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  /** Use this llama-server instead of fetching one. */
  path: z.string().min(1).optional(),
});

const server = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  /** `auto` lets the host choose a free port and record it. */
  port: z.union([z.literal("auto"), z.number().int().min(1).max(65535)]).default("auto"),
  /** How many models stay in memory at once; the least recently used is unloaded for the next. 0 is no limit. */
  models_max: nonNegative.default(1),
  /** Stop the host when it has had no request for this many minutes. Default: never. */
  idle_exit_minutes: z.number().int().positive().optional(),
  /** How long to wait, in seconds, for llama-server to answer after it starts. */
  health_timeout: z.number().int().positive().default(60),
  /** Serve llama-server's own web page. */
  webui: z.boolean().default(false),
});

export const localModelsSchema = z
  .strictObject({
    /** The engine that runs the models. Only `router` (llama-server's own router mode) exists so far; the host is written against an interface so another can be added. */
    engine: z.literal("router").default("router"),
    llama_cpp: llamaCpp.default({ backend: "auto" }),
    server: server.default({ host: "127.0.0.1", port: "auto", models_max: 1, health_timeout: 60, webui: false }),
    defaults: z.strictObject(params).default({}),
    /** The environment variable that holds a Hugging Face token, for repositories that need one. */
    hf_token_env: envName.optional(),
    models: z.record(name, modelEntry).default({}),
  })
  .superRefine((c, ctx) => {
    if (c.defaults.speculative?.draft !== undefined) ctx.addIssue({ code: "custom", path: ["defaults", "speculative", "draft"], message: "a draft model belongs to one model: set speculative on the model" });
    const seen = new Map<string, string>();
    for (const [model, m] of Object.entries(c.models)) {
      for (const n of [model, ...(m.aliases ?? [])]) {
        const other = seen.get(n);
        if (other !== undefined && other !== model) ctx.addIssue({ code: "custom", path: ["models", model], message: `the name ${n} is also used by ${other}` });
        seen.set(n, model);
      }
    }
  });

export type LocalModels = z.infer<typeof localModelsSchema>;

/** Where a model's file comes from, as far as the settings alone say. */
export type ModelSource = { kind: "url"; url: string; file: string } | { kind: "hf"; repo: string; revision: string; file: string } | { kind: "hf-quant"; repo: string; revision: string; quant: string | undefined };

const lastSegment = (path: string): string => decodeURIComponent(path.split("/").filter((s) => s !== "").at(-1) ?? "");

/** The file a model entry names, or what has to be asked of Hugging Face to find it. Undefined for a url that does not end in `.gguf`. */
export function modelSource(m: ModelEntry): ModelSource | undefined {
  if (m.url !== undefined) {
    const file = lastSegment(new URL(m.url).pathname);
    return file.toLowerCase().endsWith(".gguf") ? { kind: "url", url: m.url, file } : undefined;
  }
  const hf = m.hf as string;
  const at = hf.indexOf(":");
  const repo = at < 0 ? hf : hf.slice(0, at);
  if (m.file !== undefined) return { kind: "hf", repo, revision: m.revision, file: m.file };
  return { kind: "hf-quant", repo, revision: m.revision, quant: at < 0 ? undefined : hf.slice(at + 1) };
}

/** The address a file of a Hugging Face repository is downloaded from. */
export const hfUrl = (repo: string, revision: string, file: string): string => `https://huggingface.co/${repo}/resolve/${encodeURIComponent(revision)}/${file.split("/").map(encodeURIComponent).join("/")}`;
