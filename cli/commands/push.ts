/**
 * `/push [remote]`: push the code in the attached repositories (ADR 38), then the conversation's own branch if it has a remote. The
 * code goes first, so what the conversation records is there for anyone who fetches it. See `pushAttached`.
 */
import { pushAttached } from "../../harness/attached.ts";
import type { Command } from "../registry.ts";
import { failure } from "../turn.ts";

const push: Command = {
  name: "push",
  summary: "push the code in attached repositories (its checked-out branch), then this conversation's branch if it has a remote",
  usage: "/push [remote]",
  busy: "blocked",
  async *run(ctx, args) {
    if (args.length > 1) {
      yield { type: "error", message: "give at most one remote", hint: "/push [remote]" };
      return;
    }
    try {
      const results = await pushAttached(ctx.convo.host, ctx.convo.git, args[0]);
      if (results.length === 0) {
        yield { type: "notice", message: "nothing is attached and the conversation has no remote: nothing to push" };
        return;
      }
      for (const r of results)
        yield r.pushed
          ? { type: "notice", message: `${r.path === "." ? "conversation" : r.path}: ${r.note}` }
          : { type: "error", message: `${r.path === "." ? "conversation" : r.path}: ${r.note}` };
    } catch (e) {
      yield failure(e);
    }
  },
};

export const pushCommands: Command[] = [push];
