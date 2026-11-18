/**
 * What the settings sheet shows that is not in `harness.yml` itself: whether each provider can be reached, the models
 * each one offers, and the instruction files of the thread. The controller finds these out (it has the network and the
 * file system); the view only shows them.
 */
import { Type, type Static } from "typebox";
import { strictObject } from "../../src/validate.ts";

const count = Type.Integer({ minimum: 0 });

/** The result of trying a provider: a request that needs no model (list the models, or the cheapest call it has). */
export const providerStatus = strictObject({
  state: Type.Enum(["checking", "ok", "error"]),
  /** For `ok`, what was seen ("3 models"); for `error`, what went wrong, in words the person can act on. */
  detail: Type.Optional(Type.String()),
  /** How long the check took. */
  ms: Type.Optional(count),
});
export type ProviderStatus = Static<typeof providerStatus>;

export const modelInfo = strictObject({
  /** The id the provider uses; with the provider's name it is `provider/id`, the form `subagent.models` is keyed by. */
  id: Type.String({ minLength: 1 }),
  /** The context window in tokens, when the provider says. */
  context: Type.Optional(count),
  /** US dollars per million tokens, when known. */
  input_usd: Type.Optional(Type.Number({ minimum: 0 })),
  output_usd: Type.Optional(Type.Number({ minimum: 0 })),
  reasoning: Type.Optional(Type.Boolean()),
});
export type ModelInfo = Static<typeof modelInfo>;

export const providerModels = strictObject({
  models: Type.Array(modelInfo),
  /** Why the list could not be had. */
  error: Type.Optional(Type.String()),
});
export type ProviderModels = Static<typeof providerModels>;

/** One instruction file of the thread. */
export const instructionFile = strictObject({
  /** Relative to the workspace. */
  path: Type.String({ minLength: 1 }),
  /** Whether the thread is given it. */
  on: Type.Boolean(),
  exists: Type.Boolean(),
  bytes: Type.Optional(count),
});
export type InstructionFile = Static<typeof instructionFile>;

export const instructionState = strictObject({
  /** The files the thread has, in the order they are given to the model. */
  files: Type.Array(instructionFile),
  /** Well-known files found in the workspace that the thread does not have yet. */
  found: Type.Array(Type.Object({ path: Type.String({ minLength: 1 }), bytes: count })),
});
export type InstructionState = Static<typeof instructionState>;
