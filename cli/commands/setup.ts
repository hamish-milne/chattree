import type { Conversation } from "../../harness/conversation.ts";
import { pinDefinition, loadDefinitions } from "../../harness/definitions.ts";
import type { AgentSetup, ModelSetup } from "../../harness/setup.ts";
import { tableHash } from "../../providers/pricing.ts";
import { defaultRegistry } from "../../providers/index.ts";
import { withConfirmation } from "../changes.ts";
import { openThread } from "../project.ts";
import type { Command } from "../registry.ts";
import { failure } from "../turn.ts";

const registry = defaultRegistry();

const providersOf = async (convo: Conversation): Promise<Record<string, { $tag: string; [k: string]: unknown }>> => {
  const cfg = await convo.readConfig();
  return cfg?.ok === true ? (cfg.value.providers as Record<string, { $tag: string }>) : {};
};

/** The adapter's own check of a settings object: the issues, or none. */
async function settingsIssues(tag: string, settings: unknown): Promise<string[]> {
  const def = registry.get(tag);
  if (def === undefined) return [`no adapter for ${tag}`];
  const r = await def.settings["~standard"].validate(settings);
  return r.issues === undefined ? [] : r.issues.map((i) => `${(i.path ?? []).map((p) => (typeof p === "object" ? p.key : p)).join(".") || "settings"}: ${i.message}`);
}

const settingKeys = (tag: string): string[] => {
  const schema = registry.get(tag)?.jsonSchema().settings as { properties?: Record<string, unknown> } | undefined;
  return Object.keys(schema?.properties ?? {});
};

const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

const model: Command = {
  name: "model",
  summary: "show or change the thread's model",
  usage: "/model [provider/id | id]",
  busy: "blocked",
  async complete(ctx, previous, partial) {
    if (previous.length > 0) return [];
    const out: string[] = [];
    for (const [name, p] of Object.entries(await providersOf(ctx.convo))) {
      const cfg = (await ctx.convo.readConfig())?.ok === true ? p : undefined;
      const def = registry.get(p.$tag);
      for (const id of Object.keys(cfg === undefined ? {} : (def?.models?.(p as never) ?? {}))) out.push(`${name}/${id}`);
    }
    return out.filter((m) => m.startsWith(partial));
  },
  async *run(ctx, args) {
    try {
      const setup = await ctx.convo.setup();
      const providers = await providersOf(ctx.convo);
      if (args.length === 0) {
        const m = setup.model;
        yield { type: "text", text: m === undefined ? "no model is set" : `${m.provider}/${m.id}${m.resolved !== undefined && m.resolved !== m.id ? `  (served as ${m.resolved})` : ""}${m.settings === undefined ? "" : `\nsettings: ${JSON.stringify(m.settings)}`}` };
        const lines: string[] = [];
        for (const [name, p] of Object.entries(providers)) {
          const known = Object.keys(registry.get(p.$tag)?.models?.(p as never) ?? {});
          lines.push(`${name} (${p.$tag}): ${known.length === 0 ? "any model id the server offers" : known.slice(0, 10).join(", ") + (known.length > 10 ? `, … ${known.length - 10} more` : "")}`);
        }
        if (lines.length > 0) yield { type: "text", text: `available:\n${lines.map((l) => `  ${l}`).join("\n")}` };
        return;
      }
      if (args.length > 1) {
        yield { type: "error", message: "give one model", hint: "/model [provider/id]" };
        return;
      }
      const want = args[0] as string;
      const slash = want.indexOf("/");
      const provider = slash < 0 ? setup.model?.provider : want.slice(0, slash);
      const id = slash < 0 ? want : want.slice(slash + 1);
      if (provider === undefined || id === "") {
        yield { type: "error", message: `${want} needs a provider`, hint: `/model <provider>/<id>; providers: ${Object.keys(providers).join(", ") || "none configured"}` };
        return;
      }
      const conf = providers[provider];
      if (conf === undefined) {
        yield { type: "error", message: `there is no provider ${provider} in harness.yml`, hint: `providers: ${Object.keys(providers).join(", ") || "none"}; see /providers` };
        return;
      }
      const known = registry.get(conf.$tag)?.models?.(conf as never) ?? {};
      if (Object.keys(known).length > 0 && known[id] === undefined) yield { type: "warning", message: `${id} is not in ${provider}'s list of known models; it is used as given` };
      let settings = provider === setup.model?.provider ? setup.model?.settings : undefined;
      if (provider !== setup.model?.provider && setup.model?.settings !== undefined) {
        const max = (setup.model.settings as Record<string, unknown>)["max_output_tokens"];
        if (max !== undefined && (await settingsIssues(conf.$tag, { max_output_tokens: max })).length === 0) {
          settings = { max_output_tokens: max };
          yield { type: "notice", message: "other settings were not carried over (they belong to the previous provider); max_output_tokens was" };
        }
      }
      const next: ModelSetup = { provider, id, ...(settings === undefined ? {} : { settings }) };
      const r = yield* withConfirmation(ctx, (allow) => ctx.convo.setupChange({ model: next }, { allow }));
      if (!r.done) return;
      if (r.value === undefined) {
        yield { type: "notice", message: `already using ${provider}/${id}` };
        return;
      }
      if (provider !== setup.model?.provider) {
        await ctx.convo.pinPricing();
        yield { type: "notice", message: `pinned ${provider}'s prices` };
      }
      yield { type: "notice", message: `now using ${provider}/${id}` };
    } catch (e) {
      yield failure(e);
    }
  },
};

const set: Command = {
  name: "set",
  summary: "show or change a model setting (checked by the provider's own rules)",
  usage: "/set  |  /set <key>  |  /set <key> <value>  |  /set <key> unset      (values are JSON, or plain text)",
  busy: "blocked",
  async complete(ctx, previous, partial) {
    const m = (await ctx.convo.setup()).model;
    const tag = m === undefined ? undefined : (await providersOf(ctx.convo))[m.provider]?.$tag;
    return previous.length === 0 && tag !== undefined ? settingKeys(tag).filter((k) => k.startsWith(partial)) : [];
  },
  async *run(ctx, args, rest) {
    try {
      const m = (await ctx.convo.setup()).model;
      if (m === undefined) {
        yield { type: "error", message: "no model is set", hint: "/model <provider>/<id>" };
        return;
      }
      const tag = (await providersOf(ctx.convo))[m.provider]?.$tag;
      if (tag === undefined) {
        yield { type: "error", message: `provider ${m.provider} is not configured in harness.yml` };
        return;
      }
      const cur = (m.settings ?? {}) as Record<string, unknown>;
      const key = args[0];
      if (key === undefined) {
        yield { type: "text", text: `${Object.keys(cur).length === 0 ? "(no settings)" : pretty(cur)}\nsettings ${tag} accepts: ${settingKeys(tag).join(", ")}` };
        return;
      }
      if (args.length === 1) {
        yield { type: "text", text: key in cur ? `${key}: ${JSON.stringify(cur[key])}` : `${key} is not set${settingKeys(tag).includes(key) ? "" : ` (and ${tag} has no such setting; known: ${settingKeys(tag).join(", ")})`}` };
        return;
      }
      const raw = rest.replace(/^\s*\S+\s*/, "").trim();
      const next: Record<string, unknown> = { ...cur };
      if (raw === "unset") delete next[key];
      else {
        try {
          next[key] = JSON.parse(raw);
        } catch {
          next[key] = raw;
        }
      }
      const issues = await settingsIssues(tag, next);
      if (issues.length > 0) {
        yield { type: "error", message: `that setting is not valid for ${m.provider}:\n  ${issues.join("\n  ")}`, hint: `known keys: ${settingKeys(tag).join(", ")}` };
        return;
      }
      const r = yield* withConfirmation(ctx, (allow) => ctx.convo.setupChange({ model: { ...m, settings: next } }, { allow }));
      if (!r.done) return;
      yield { type: "notice", message: r.value === undefined ? `${key} already has that value` : raw === "unset" ? `${key} is unset` : `${key} set to ${JSON.stringify(next[key])}` };
    } catch (e) {
      yield failure(e);
    }
  },
};

async function currentInstructions(convo: Conversation, setup: AgentSetup): Promise<string | undefined> {
  if (setup.instructions === undefined) return undefined;
  return (await loadDefinitions(setup, { blobs: convo.store })).instructions;
}

const instructions: Command = {
  name: "instructions",
  summary: "show or change the agent's instructions",
  usage: "/instructions [show | edit | set <text>]",
  busy: "blocked",
  async complete(_ctx, previous, partial) {
    return previous.length === 0 ? ["show", "edit", "set"].filter((s) => s.startsWith(partial)) : [];
  },
  async *run(ctx, args, rest) {
    try {
      const setup = await ctx.convo.setup();
      const sub = args[0] ?? "show";
      const text = await currentInstructions(ctx.convo, setup);
      let next: string | undefined;
      if (sub === "show") {
        yield { type: "text", text: text ?? "(no instructions are set: the model gets only the harness's own prompt)" };
        return;
      } else if (sub === "set") next = rest.replace(/^\s*set\s*/, "");
      else if (sub === "edit") {
        const dir = ctx.io.host.path.join(ctx.engine.project.mainRoot, ".chattree", "tmp");
        const file = ctx.io.host.path.join(dir, "instructions.md");
        await ctx.io.host.fs.writeAtomic(file, new TextEncoder().encode(text ?? ""));
        try {
          if (!(await ctx.engine.edit(file))) {
            yield { type: "error", message: "the editor did not exit cleanly; nothing was changed" };
            return;
          }
          next = new TextDecoder().decode(await ctx.io.host.fs.read(file));
        } finally {
          await ctx.io.host.fs.remove(file);
        }
      } else {
        yield { type: "error", message: `unknown option ${sub}`, hint: "/instructions [show | edit | set <text>]" };
        return;
      }
      if (next.trim() === "") {
        yield { type: "error", message: "the instructions would be empty", hint: "a thread's instructions can be replaced but not removed" };
        return;
      }
      if (next === text) {
        yield { type: "notice", message: "the instructions are unchanged" };
        return;
      }
      const pin = await pinDefinition("instructions", next, { store: "blob", blobs: ctx.convo.store });
      const r = yield* withConfirmation(ctx, (allow) => ctx.convo.setupChange({ instructions: pin }, { allow }));
      if (r.done) yield { type: "notice", message: `instructions updated (${next.length} characters)` };
    } catch (e) {
      yield failure(e);
    }
  },
};

const providers: Command = {
  name: "providers",
  summary: "the providers in harness.yml and whether their keys are set",
  usage: "/providers",
  busy: "allowed",
  async *run(ctx) {
    const cfg = await ctx.convo.readConfig();
    if (cfg === undefined) {
      yield { type: "error", message: "this thread has no harness.yml" };
      return;
    }
    if (!cfg.ok) {
      yield { type: "error", message: `harness.yml has problems:\n  ${cfg.issues.map((i) => `${i.path === "" ? "" : `${i.path}: `}${i.message}`).join("\n  ")}` };
      return;
    }
    const current = (await ctx.convo.setup()).model?.provider;
    const rows: string[] = [];
    for (const [name, p] of Object.entries(cfg.value.providers as Record<string, { $tag: string; [k: string]: unknown }>)) {
      const keys = registry.get(p.$tag)?.secrets(p as never) ?? [];
      const keyText = keys.length === 0 ? "no key needed" : keys.map((k) => `${k} ${ctx.io.env[k] === undefined || ctx.io.env[k] === "" ? "NOT SET" : "set"}`).join(", ");
      rows.push(`${name === current ? "*" : " "} ${name}  ${p.$tag}${typeof p["base_url"] === "string" ? `  ${p["base_url"]}` : ""}  ${keyText}`);
    }
    yield { type: "text", text: rows.length === 0 ? "no providers are configured" : rows.join("\n") };
    if (ctx.engine.degraded !== undefined) yield { type: "warning", message: `providers are unavailable in this session: ${ctx.engine.degraded}` };
  },
};

const pricing: Command = {
  name: "pricing",
  summary: "show the price table in force, or pin the current one",
  usage: "/pricing [pin]",
  busy: "blocked",
  async complete(_ctx, previous, partial) {
    return previous.length === 0 ? ["pin"].filter((s) => s.startsWith(partial)) : [];
  },
  async *run(ctx, args) {
    try {
      const setup = await ctx.convo.setup();
      const provider = setup.model?.provider;
      if (provider === undefined) {
        yield { type: "error", message: "no model is set, so there are no prices to show" };
        return;
      }
      const table = ctx.convo.priceTable(provider);
      if (args[0] === "pin") {
        const r = await ctx.convo.pinPricing();
        yield { type: "notice", message: r === undefined ? "the current prices are already pinned" : `pinned ${provider}'s current prices` };
        return;
      }
      if (args.length > 0) {
        yield { type: "error", message: `unknown option ${args[0]}`, hint: "/pricing [pin]" };
        return;
      }
      const now = table === undefined ? undefined : tableHash(table);
      const pinned = setup.pricing?.table;
      yield {
        type: "text",
        text: [`provider:  ${provider}`, `pinned:    ${pinned === undefined ? "nothing (costs are unknown)" : pinned.slice(0, 12)}`, `in force:  ${now === undefined ? "no table for this provider" : now.slice(0, 12)}`, pinned !== undefined && now !== undefined ? (pinned === now ? "the pin is current" : "the provider's table has changed since it was pinned: /pricing pin accepts the new prices") : ""].filter((l) => l !== "").join("\n"),
      };
    } catch (e) {
      yield failure(e);
    }
  },
};

const accept: Command = {
  name: "accept",
  summary: "accept a change the provider made to the agent (a model alias moving to a new version, say)",
  usage: "/accept",
  busy: "blocked",
  async *run(ctx) {
    try {
      const pending = (await ctx.convo.setup()).unacknowledged;
      if (pending.length === 0) {
        yield { type: "notice", message: "nothing to accept" };
        return;
      }
      yield { type: "notice", message: pending.map((p) => `accepting ${p.id}: ${p.changes.join(", ")}`).join("\n") };
      await ctx.convo.setupChange({}, { acknowledges: pending.map((p) => p.id) });
      yield { type: "notice", message: "accepted; requests can go ahead" };
    } catch (e) {
      yield failure(e);
    }
  },
};

const config: Command = {
  name: "config",
  summary: "check harness.yml, or open it in your editor",
  usage: "/config [edit]",
  busy: "blocked",
  async complete(_ctx, previous, partial) {
    return previous.length === 0 ? ["edit"].filter((s) => s.startsWith(partial)) : [];
  },
  async *run(ctx, args) {
    try {
      const path = ctx.io.host.path.join(ctx.convo.dir, "harness.yml");
      if (args[0] === "edit") {
        if (!(await ctx.engine.edit(path))) {
          yield { type: "error", message: "the editor did not exit cleanly" };
          return;
        }
        const edited = await ctx.convo.readConfig();
        if (edited !== undefined && edited.ok) {
          const opened = await openThread(ctx.io, ctx.engine.project, ctx.engine.thread, { providers: "optional" });
          const old = ctx.engine.convo;
          ctx.engine.rebind(opened);
          await old.close().catch(() => undefined);
          yield { type: "notice", message: "reloaded; the edit is committed with this thread's next entry" };
        } else yield { type: "warning", message: "not reloaded: the session keeps using the configuration it had until the file is valid" };
      } else if (args.length > 0) {
        yield { type: "error", message: `unknown option ${args[0]}`, hint: "/config [edit]" };
        return;
      }
      const cfg = await ctx.convo.readConfig();
      if (cfg === undefined) yield { type: "error", message: `${path} does not exist` };
      else if (!cfg.ok) yield { type: "error", message: `harness.yml has problems:\n  ${cfg.issues.map((i) => `${i.path === "" ? "" : `${i.path}: `}${i.message}`).join("\n  ")}`, hint: "/config edit opens it" };
      else {
        const v = cfg.value;
        yield { type: "text", text: [`${path}: valid`, `providers:   ${Object.keys(v.providers).join(", ") || "none"}`, `limits:      ${Object.keys(v.limits).length === 0 ? "none" : JSON.stringify(v.limits)}`, `maintenance: ${JSON.stringify(v.maintenance)}`, `attachments: up to ${v.attachments.max_bytes} bytes`].join("\n") };
      }
    } catch (e) {
      yield failure(e);
    }
  },
};

export const setupCommands: Command[] = [model, set, instructions, providers, pricing, accept, config];
