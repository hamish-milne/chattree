import { toolDrift, syncMcpTools } from "../../harness/loop.ts";
import { describeServer, pinServer, serverOf, serverState, type ServerStatus } from "../../harness/mcp/servers.ts";
import type { Ctx } from "../engine.ts";
import type { Command } from "../registry.ts";
import type { Output } from "../output.ts";
import { withConfirmation } from "../changes.ts";
import { failure } from "../turn.ts";

const flat = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};

const USAGE = "/mcp [show <server> [tool] | accept [server...] | forget <server> | refresh]";

/** The MCP servers harness.yml names (empty when it has none or does not parse). */
async function configured(ctx: Ctx) {
  const cfg = await ctx.convo.readConfig();
  return cfg?.ok === true ? cfg.value.mcp : {};
}

function stateLine(s: ServerStatus, drift: { tools: number; changed: number; gone: number }): string {
  if (!s.connected) return `${s.name}  [${s.state === "accepted" ? "unavailable" : s.state === "new" ? "not accepted" : "configuration changed"}]  ${s.error ?? ""}`.trimEnd();
  const parts = [`${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}`];
  if (s.skipped.length > 0) parts.push(`${s.skipped.length} not offered`);
  if (drift.tools + drift.changed + drift.gone > 0) parts.push(`not yet accepted: ${[drift.tools > 0 ? `${drift.tools} new` : "", drift.changed > 0 ? `${drift.changed} changed` : "", drift.gone > 0 ? `${drift.gone} gone` : ""].filter((x) => x !== "").join(", ")}`);
  if (s.stale) parts.push("the server says its tools changed: /mcp refresh");
  return `${s.name}  [${drift.tools + drift.changed + drift.gone > 0 ? "tools to accept" : "ready"}]  ${s.info === undefined ? "" : `${s.info.name} ${s.info.version}  `}${parts.join("; ")}`;
}

const mcp: Command = {
  name: "mcp",
  summary: "MCP servers: what harness.yml names, what this thread has accepted, and their tools",
  usage: USAGE,
  busy: "blocked",
  async complete(ctx, previous, partial) {
    if (previous.length === 0) return ["show", "accept", "forget", "refresh"].filter((s) => s.startsWith(partial));
    if (["show", "accept", "forget"].includes(previous[0] as string)) return Object.keys(await configured(ctx)).filter((n) => n.startsWith(partial));
    return [];
  },
  async *run(ctx, args): AsyncGenerator<Output, void> {
    try {
      const set = await ctx.engine.toolset();
      if (set === undefined) {
        yield { type: "notice", message: "this session gives the model no tools (`chattree chat` does)" };
        return;
      }
      const servers = await configured(ctx);
      const sub = args[0] ?? "list";
      const driftOf = async (name: string) => {
        const d = await toolDrift(ctx.convo, set.registry);
        const mine = (n: string): boolean => serverOf(n) === name;
        return { tools: d.missing.filter(mine).length, changed: d.changed.filter(mine).length, gone: d.extra.filter(mine).length };
      };

      if (sub === "list") {
        const setup = await ctx.convo.setup();
        const names = [...new Set([...Object.keys(servers), ...Object.keys(setup.mcp)])].sort();
        if (names.length === 0) {
          yield { type: "text", text: "no MCP servers: add them under `mcp:` in harness.yml (docs/context.md)" };
          return;
        }
        const rows: string[] = [];
        for (const name of names) {
          const s = set.mcp.status.find((x) => x.name === name);
          if (s === undefined) rows.push(`${name}  [removed from harness.yml]  /mcp forget ${name} drops what the thread pinned`);
          else rows.push(stateLine(s, await driftOf(name)));
        }
        yield { type: "text", text: rows.join("\n") };
        return;
      }

      if (sub === "refresh") {
        await set.reloadMcp();
        yield { type: "notice", message: "reconnected the accepted MCP servers; /mcp shows how it went" };
        return;
      }

      if (sub === "show") {
        const name = args[1];
        const s = name === undefined ? undefined : set.mcp.status.find((x) => x.name === name);
        if (name === undefined || s === undefined) {
          yield { type: "error", message: name === undefined ? "which server?" : `${name} is not a connected MCP server`, hint: USAGE };
          return;
        }
        if (args[2] !== undefined) {
          const t = s.tools.find((x) => x.tool === args[2] || x.name === args[2]);
          const tool = t === undefined ? undefined : set.registry.get(t.name);
          if (t === undefined || tool === undefined) {
            yield { type: "error", message: `${name} has no offered tool ${args[2]}`, hint: `offered: ${s.tools.map((x) => x.tool).join(", ")}` };
            return;
          }
          const notes = s.notes.filter((n) => n.tool === t.tool).map((n) => `  ${n.note}`);
          yield { type: "text", text: `${t.name}\n${tool.definition.description}\n\n${JSON.stringify(tool.definition.input_schema, null, 2)}${notes.length > 0 ? `\n\nchanged to fit:\n${notes.join("\n")}` : ""}` };
          return;
        }
        const lines = s.tools.map((t) => `${t.tool}  ${flat((set.registry.get(t.name)?.definition.description ?? "").replace(/^\[MCP server [^\]]*\]\s*/, ""), 110)}`);
        for (const x of s.skipped) lines.push(`${x.tool}  [not offered] ${flat(x.why, 110)}`);
        yield { type: "text", text: `${s.info === undefined ? s.name : `${s.name}: ${s.info.name} ${s.info.version}`}${s.instructions === undefined ? "" : `\nthe server says: ${flat(s.instructions, 300)}`}\n${lines.join("\n")}` };
        return;
      }

      if (sub === "forget") {
        const name = args[1];
        const setup = await ctx.convo.setup();
        if (name === undefined || (setup.mcp[name] === undefined && !Object.keys(setup.tools).some((n) => serverOf(n) === name))) {
          yield { type: "error", message: name === undefined ? "which server?" : `this thread has nothing pinned for ${name}`, hint: USAGE };
          return;
        }
        await ctx.convo.setupChange({ mcp: { remove: [name] } });
        await set.reloadMcp(); // now not accepted, so not connected, so its tools are gone from the registry
        const r = yield* withConfirmation(ctx, (allow) => syncMcpTools(ctx.convo, set.registry, [name], allow));
        if (r.done) yield { type: "notice", message: `${name} is forgotten: its configuration and tools are unpinned` };
        return;
      }

      if (sub === "accept") {
        const wanted = args.length > 1 ? args.slice(1) : Object.keys(servers);
        for (const name of wanted) {
          const cfg = servers[name];
          if (cfg === undefined) {
            yield { type: "error", message: `harness.yml has no MCP server ${name}`, hint: `servers: ${Object.keys(servers).join(", ") || "(none)"}` };
            return;
          }
          let setup = await ctx.convo.setup();
          const state = await serverState(setup, name, cfg);
          if (state !== "accepted") {
            const verb = state === "new" ? "Let this thread" : "This thread accepted a different configuration for this server. Let it now";
            if (!(await ctx.confirm(`${verb} ${describeServer(cfg)}?`))) {
              yield { type: "notice", message: `${name} was not accepted` };
              continue;
            }
            await ctx.convo.setupChange({ mcp: { set: { [name]: await pinServer(ctx.convo.store, cfg) } } });
            setup = await ctx.convo.setup();
          }
          await set.reloadMcp();
          const s = set.mcp.status.find((x) => x.name === name);
          if (s === undefined || !s.connected) {
            yield { type: "error", message: `${name} could not be reached: ${s?.error ?? "unknown"}`, hint: "fix it, then /mcp accept again" };
            continue;
          }
          for (const x of s.skipped) yield { type: "warning", message: `${name}: tool ${x.tool} is not offered: ${flat(x.why, 160)}` };
          const d = await driftOf(name);
          if (d.tools + d.changed + d.gone === 0) {
            yield { type: "notice", message: `${name}: ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}, all accepted already` };
            continue;
          }
          yield { type: "text", text: `${name} offers: ${s.tools.map((t) => t.tool).join(", ")}\n(${[d.tools > 0 ? `${d.tools} new` : "", d.changed > 0 ? `${d.changed} changed` : "", d.gone > 0 ? `${d.gone} gone` : ""].filter((x) => x !== "").join(", ")}; /mcp show ${name} <tool> shows a tool's description and arguments)` };
          const r = yield* withConfirmation(ctx, (allow) => syncMcpTools(ctx.convo, set.registry, [name], allow));
          if (r.done) yield { type: "notice", message: `${name}: tools pinned to this thread; each call still asks` };
        }
        return;
      }

      yield { type: "error", message: `unknown option ${sub}`, hint: USAGE };
    } catch (e) {
      yield failure(e);
    }
  },
};

export const mcpCommands: Command[] = [mcp];
