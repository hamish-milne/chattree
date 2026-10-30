# Services and plans

How to point chattree at particular services, including flat-fee plans that give API access to a fixed set of models. Everything here was checked on **2026-10-30** against the providers' own pages, and these services change their terms often: check the page named in each entry before relying on it.

> **You are responsible for each service's terms.** chattree is open-source software that sends requests to the endpoint you configure. Some plans limit which tools may use them, ask for a true client identity, forbid unattended or scripted use, or limit sharing of keys; some enforce this with suspensions or bans. We list what we found so you can decide. We do not verify that a plan allows chattree, we are not a party to your agreement with the provider, and we are not responsible for what happens to your account.

## Settings every provider has

```yaml
providers:
  go:
    $tag: opencode-go
    api_key_env: OPENCODE_GO_KEY
    headers:                       # added to every request; a null removes one
      x-team: platform
      user-agent: null             # see below
    session_header: x-opencode-session   # the header that carries the thread's id
```

- **`User-Agent`.** Requests say `chattree/<version>` unless `headers` sets another value. Setting it to `null` stops us sending it; Node's own `User-Agent` (`node`) is then sent. **Some providers' terms require clients to identify themselves truthfully** (Kimi Code treats altering it as a violation, OpenCode Go asks for an identifiable one). Removing or replacing it may break a provider's terms.
- **`session_header`.** The name of a header that carries a stable id for the conversation (a hash of the thread, the same for every request on it). OpenCode Go uses it for caching, so its provider sets `x-opencode-session` by default; `headers: { x-opencode-session: null }` turns it off, which costs cache hits and so allowance.
- **Header names are case-insensitive.** The provider's credentials are added last and cannot be overridden by `headers`.

## Services

| Service | API style | Headers it wants | Model list | Provider |
|---|---|---|---|---|
| OpenCode Go | Chat Completions (used for every model); each model's own style is in the catalog | honest `User-Agent`; `x-opencode-session` per conversation | `GET https://opencode.ai/inference/go/v1/models` (public) | `opencode-go` (`openai-compatible` with a catalog and the session header) |
| Gemini API | Chat Completions, at the OpenAI-compatibility endpoint | none (`Authorization: Bearer <key>`) | `GET https://generativelanguage.googleapis.com/v1beta/models` (needs the key; limits, no prices) | `gemini` (`openai-compatible` with a catalog) |
| Qwen Token Plan | OpenAI Chat Completions or Anthropic Messages | none documented | none documented | `openai-compatible` or `anthropic`, configuration only |
| Kimi Code | Anthropic Messages (OpenAI-compatible is mentioned but no URL found) | honest `User-Agent` | none documented | `anthropic`, configuration only |
| MiniMax Token Plan | OpenAI Chat Completions or Anthropic Messages | none documented | none documented | `openai-compatible` or `anthropic`, configuration only |

Not supported: **Z.ai's GLM Coding Plan** (its terms limit the plan to tools on its own list), and **subscription sign-in** for Claude, Gemini and ChatGPT (see below).

### OpenCode Go

A flat monthly plan (from $10) for many models; usage is limited by a dollar allowance per model in 5-hour, weekly and monthly windows. Docs: https://opencode.ai/docs/en/go/. The plan is for coding agents that send typical coding-agent traffic.

```yaml
providers:
  go: { $tag: opencode-go, api_key_env: OPENCODE_GO_KEY }
```

Then `chattree` can use any model in `providers/catalog/opencode-go-rows.ts` (for example `glm-5.3-flash`). The prices in the ledger are what the list gives for each model (taken as USD per million tokens), so they show how fast the allowance is used, not what you are billed. Not modelled: the 2x multipliers the list shows for the DeepSeek V4 models at some hours and for `gemini-4-argon` after 2026-12-01.

The gateway translates between API styles, so every text model works through Chat Completions, which is what this provider speaks. Models that natively speak Messages (the Claude and Qwen entries) may do better through it. That is untested; the configuration would be an `anthropic` provider with `base_url: https://opencode.ai/inference/go/anthropic` and `session_header: x-opencode-session`.

Refresh the model list with `npm run catalog -- opencode-go` (see below).

### Gemini API

```yaml
providers:
  gemini: { $tag: gemini, api_key_env: GEMINI_API_KEY, pricing: { free: true } }   # free: true for a key on the free tier
```

An API key from Google AI Studio. The free tier covers the Flash and Flash-Lite models and **Google may use free-tier content to improve its products** (https://ai.google.dev/gemini-api/docs/pricing). `pricing: { free: true }` makes the ledger show no cost; leave it out on a paid key, and the bundled prices (paid Standard tier, dated in `gemini-rows.ts`, with the two price changes that are announced) apply. Reasoning is set with `reasoning_effort`; some Gemini models cannot turn thinking off.

Google does not allow third-party tools to use the Gemini CLI's Google-account sign-in, so only API keys are supported.

### Qwen, Kimi Code, MiniMax

Configuration only. Because they have no catalog here, give each model's limits yourself (`models:`), and `max_output_tokens` in its settings.

```yaml
providers:
  qwen:                      # https://docs.qwencloud.com/token-plan/overview
    $tag: openai-compatible
    base_url: https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
    api_key_env: QWEN_TOKEN_PLAN_KEY
  kimi:                      # https://www.kimi.com/code/docs/en/
    $tag: anthropic
    base_url: https://api.kimi.com/coding          # overseas: https://api.kimi.ai/coding
    api_key_env: KIMI_CODE_KEY
  minimax:                   # https://platform.minimax.io/docs/m-plan/other-tools
    $tag: anthropic
    base_url: https://api.minimax.io/anthropic     # or openai-compatible at https://api.minimax.io/v1
    api_key_env: MINIMAX_PLAN_KEY                  # keys start with sk-cp-
```

What their pages say about use, as of the date above:

- **Qwen Token Plan**: "intended for interactive use within compatible AI tools only", "cannot use it for automated scripts or application backends", the key is for the subscriber's personal use. Team Edition is in Singapore only, and prompts cross borders. The supported-tools list does not name chattree. `chattree run` and background subagents are unattended work: consider whether that fits.
- **Kimi Code**: members may use it in third-party coding tools with their own key. Altering the `User-Agent` is "treated as a violation". For calling models from your own product, Kimi points to its pay-as-you-go platform (a different base URL and key). The Anthropic URL is the one documented.
- **MiniMax Token Plan**: its documentation lists many third-party tools and frameworks and states no restriction on use; no statement of permission either. The Anthropic URL is the one it recommends (prompt caching).
- **Z.ai GLM Coding Plan**: "strictly limited to use within officially supported tools and products". chattree is not on the list, so it is not supported here.

### Claude, Gemini and ChatGPT subscriptions

Not supported. Anthropic does not permit third-party tools to route requests through Free, Pro or Max plan credentials (https://code.claude.com/docs/en/legal-and-compliance); use an API key, or Bedrock or Vertex credentials. Google states that using the Gemini CLI's sign-in from third-party software violates its terms (https://geminicli.com/docs/resources/tos-privacy/). OpenAI's "Sign in with ChatGPT" is offered to partner and open-source clients under conditions we have not confirmed with OpenAI; it is on the list of things to look at.

## Refreshing the bundled model lists

`providers/catalog/*-rows.ts` are snapshots. `npm run catalog -- opencode-go` rewrites the OpenCode Go one from its public list; `GEMINI_API_KEY=… npm run catalog -- gemini` fills the token limits of the Gemini rows from the model list and names models that have no row. Review the diff: prices for Gemini, and long-context price bands for OpenCode Go, are not in those lists and are kept as they were. A changed price table is a `pricing_changed` for agents pinned to the old one (providers.md, P9).

The OpenCode snapshot in the repository was read through a summarising tool, and the refresh script's reading of the list was written from a description of its fields. If the script reports that a field is missing, `npm run catalog -- opencode-go --dump` prints the list so the paths in `providers/catalog/refresh.ts` (`FIELDS`) can be corrected.
