/**
 * The `harness.yml` form for the mock. The schema is a trimmed copy of what `configJsonSchema` produces, so the mock
 * exercises every kind of field (sections, enums, numbers, booleans, string lists, a map) without the whole file.
 */
import type { FormSpec } from "../model/form.ts";

export function configFixture(): FormSpec {
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
              $tag: { enum: ["anthropic", "openai", "openai-compatible", "gemini", "local-models"] },
              api_key_env: { type: "string", description: "The NAME of an environment variable, never a key." },
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
            warn_at: { type: "number", minimum: 0, maximum: 1, description: "Fraction of a limit at which a warning is shown." },
          },
        },
        skills: {
          type: "object",
          properties: { follow: { enum: ["auto", "ask", "off"], description: "Whether changed skills on disk are taken automatically." } },
        },
        compaction: { type: "object", properties: { auto: { type: "boolean" }, keep_recent: { type: "integer", minimum: 0 } } },
        background: {
          type: "object",
          properties: { resume: { type: "boolean", description: "Let a finished background job restart an idle thread (spends money)." } },
        },
        allow_hosts: { type: "array", items: { type: "string" }, description: "Hosts the fetch tool may reach." },
      },
    },
    value: {
      providers: {
        anthropic: { $tag: "anthropic", api_key_env: "ANTHROPIC_API_KEY" },
        local: { $tag: "openai-compatible", base_url: "http://localhost:8080/v1" },
      },
      limits: { max_request_usd: 1, max_turn_usd: 80, max_conversation_usd: 50, warn_at: 0.8 },
      skills: { follow: "ask" },
      compaction: { auto: true, keep_recent: 12 },
      background: { resume: false },
      allow_hosts: ["registry.npmjs.org", "github.com"],
    },
    issues: [{ path: "limits.max_turn_usd", message: "is above max_conversation_usd" }],
    dirty: false,
  };
}
