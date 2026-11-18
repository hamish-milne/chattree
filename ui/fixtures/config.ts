/**
 * The `harness.yml` form for the mock: the harness's own schema (generated, so the mock edits what the real file
 * allows) and a file with the kinds of setting a project has: two providers, limits, approvals (one expired, one about
 * to), MCP servers, subagent models and compaction.
 */
import type { FormSpec } from "../model/form.ts";
import { harnessSchema } from "./harness-schema.ts";

/** The day the fixture's grants are set around, so one is expired and one is soon whenever the preview opens. */
export function configFixture(now: Date = new Date()): FormSpec {
  const day = (n: number): string => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  return {
    id: "harness",
    title: "harness.yml",
    saveLabel: "Save and commit",
    schema: harnessSchema,
    value: {
      providers: {
        anthropic: { $tag: "anthropic", api_key_env: "ANTHROPIC_API_KEY" },
        openai: {
          $tag: "openai",
          api_key_env: "OPENAI_API_KEY",
          max_concurrent: 4,
        },
        local: {
          $tag: "openai-compatible",
          base_url: "http://localhost:8080/v1",
        },
      },
      tools: {
        env: ["PATH", "HOME"],
        run: {
          allow: {
            "git status": "2999-01-01",
            "git diff *": "2999-01-01",
            "pnpm test": day(3),
            "make *": day(-2),
          },
          git: true,
        },
        edit: { allow: { "src/**": "2999-01-01" } },
        fetch: {
          allow: { "registry.npmjs.org": day(30), "github.com": "2999-01-01" },
        },
      },
      mcp: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env_from: ["GITHUB_TOKEN"],
          allow: { "search_*": "2999-01-01", get_issue: day(14) },
          scope: "project",
        },
        docs: {
          url: "https://docs.example.com/mcp",
          bearer_env: "DOCS_TOKEN",
          only: ["search", "fetch"],
        },
      },
      background: { resume: false },
      threads: { siblings: false },
      subagent: {
        merge: "review",
        mcp: "inherit",
        models: {
          "anthropic/claude-haiku-5-5": {
            description: "Quick lookups and small edits",
          },
          "local/qwen3-coder": { description: "Free; for bulk, low-risk work" },
        },
      },
      limits: {
        max_request_usd: 1,
        max_turn_usd: 80,
        max_conversation_usd: 50,
        max_requests_per_turn: 40,
        warn_at: 0.8,
        unknown_price: "warn",
      },
      maintenance: {
        auto: true,
        loose_objects: 1000,
        packs: 20,
        check_every: 200,
      },
      attachments: { max_bytes: 20971520 },
      skills: { follow: "ask" },
      injections: {
        usage: true,
        environment: true,
        rules: {
          "tests-reminder": {
            every: 10,
            first: true,
            text: "Run the tests before finishing.",
          },
        },
      },
      compaction: {
        auto: "trim",
        keep_recent: 12,
        threshold_tokens: 150000,
        summary_input: "seen",
      },
    },
    // The one rule across fields the real file has.
    issues: [{ path: "limits.max_turn_usd", message: "is above max_conversation_usd" }],
    dirty: false,
  };
}
