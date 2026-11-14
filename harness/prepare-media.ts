import { createHash } from "node:crypto";
import type { AttachmentPart, ModelContext, Turn, UserPart } from "./context-builder.ts";
import type { ConvertCache } from "./convert-cache.ts";
import type { Converter } from "./converter.ts";
import { formatOf, sniffFormat, type Format } from "./formats.ts";
import { planMedia, type MediaSpec, type MediaTarget } from "./media-spec.ts";
import type { CostWarning } from "./limits.ts";

/**
 * The step between the context builder and the adapter that makes every picture, sound and PDF something the sink takes
 * (docs/tools.md, media formats). The transcript keeps what came in; only the request is changed. A file the sink takes passes
 * untouched; one it does not is converted (through the cache, when there is one); one that cannot be becomes a note to the model
 * saying it was not shown and why, plus a warning for the user, and the request still goes. Estimates are taken from the result.
 */

export interface MediaConversion {
  name: string | undefined;
  /** Source and result media types. */
  from: string;
  to: string;
  /** The converter's id; also what a cached result was made by. */
  converter: string;
  cached: boolean;
}

export interface PrepareMediaOptions {
  spec: MediaSpec;
  /**
   * The converter, asked for only when a file needs converting (so that a missing `ffmpeg` setting is an error only then).
   * Rejecting stops the request with that error; resolving to undefined means nothing can convert, and files that need it get notes.
   */
  converter?: () => Promise<Converter | undefined>;
  cache?: ConvertCache;
  signal?: AbortSignal;
}

export interface PreparedMedia {
  context: ModelContext;
  converted: MediaConversion[];
  warnings: CostWarning[];
}

const NOUN = { image: "picture", audio: "sound", pdf: "PDF" } as const;

async function formatFor(p: AttachmentPart): Promise<Format | undefined> {
  return (await sniffFormat(p.bytes)) ?? formatOf(p.mime);
}

/** The context as the sink will take it. Unchanged (the same object) when there was nothing to do. */
export async function prepareMedia(context: ModelContext, o: PrepareMediaOptions): Promise<PreparedMedia> {
  const parts: AttachmentPart[] = [];
  for (const t of context.turns) {
    if (t.role === "user") for (const p of t.parts) if (p.type === "attachment") parts.push(p);
    if (t.role === "tool_results") for (const r of t.results) for (const m of r.media ?? []) parts.push(m);
  }
  if (parts.length === 0) return { context, converted: [], warnings: [] };

  const formats = new Map<AttachmentPart, Format | undefined>();
  for (const p of parts) formats.set(p, await formatFor(p));
  const needs = parts.some((p) => planMedia(formats.get(p), p.bytes.length, o.spec).action === "convert");
  const converter = needs ? await o.converter?.() : undefined;
  const canConvert = converter === undefined ? () => false : (f: Format, t: MediaTarget) => converter.can(f, t);

  const converted: MediaConversion[] = [];
  const warnings: CostWarning[] = [];
  const results = new Map<AttachmentPart, AttachmentPart | { note: string }>();
  const memo = new Map<string, Uint8Array | { note: string }>();

  const fail = (p: AttachmentPart, reason: string): { note: string } => {
    const what = NOUN[p.kind];
    const name = p.name ?? p.sha256.slice(0, 12);
    warnings.push({ kind: "media_not_sent", message: `${what} ${name} was not sent: ${reason}` });
    return { note: `[The ${what} "${name}" was attached but is not shown to you: ${reason}. Tell the user it was not seen, and what they can do about it.]` };
  };

  for (const p of parts) {
    const format = formats.get(p);
    const plan = planMedia(format, p.bytes.length, o.spec, canConvert);
    if (plan.action === "pass") continue;
    if (plan.action === "refuse" || format === undefined || converter === undefined) {
      results.set(p, fail(p, plan.action === "refuse" ? plan.reason : "no converter is available"));
      continue;
    }
    const key = `${p.sha256}:${plan.to.mime}`;
    let out = memo.get(key);
    let cached = false;
    if (out === undefined) {
      const ck = { source: createHash("sha256").update(p.bytes).digest("hex"), to: plan.to.mime, converter: converter.id };
      const hit = await o.cache?.get(ck);
      if (hit !== undefined) {
        out = hit;
        cached = true;
      } else {
        try {
          out = await converter.convert(p.bytes, format, plan.to, o.signal);
          await o.cache?.put(ck, out);
        } catch (e) {
          if (o.signal?.aborted === true) throw e;
          out = { note: e instanceof Error ? e.message : String(e) };
        }
      }
      if (!("note" in out) && plan.to.maxBytes !== undefined && out.length > plan.to.maxBytes) out = { note: `converted to ${plan.to.mime} it is ${out.length} bytes, over the ${plan.to.maxBytes} this model takes; make a smaller copy (lower resolution or a shorter clip)` };
      memo.set(key, out);
    }
    if ("note" in out) results.set(p, fail(p, out.note));
    else {
      results.set(p, { ...p, mime: plan.to.mime, bytes: out });
      converted.push({ name: p.name, from: format.mime, to: plan.to.mime, converter: converter.id, cached });
    }
  }
  if (results.size === 0) return { context, converted, warnings };

  const turns: Turn[] = context.turns.map((t): Turn => {
    if (t.role === "user") {
      if (!t.parts.some((p) => results.has(p as AttachmentPart))) return t;
      return { ...t, parts: t.parts.map((p): UserPart => {
        const r = p.type === "attachment" ? results.get(p) : undefined;
        return r === undefined ? p : "note" in r ? { type: "text", text: r.note } : r;
      }) };
    }
    if (t.role !== "tool_results") return t;
    return { ...t, results: t.results.map((res) => {
      if (!(res.media ?? []).some((m) => results.has(m))) return res;
      const notes: string[] = [];
      const media: AttachmentPart[] = [];
      for (const m of res.media ?? []) {
        const r = results.get(m);
        if (r === undefined) media.push(m);
        else if ("note" in r) notes.push(r.note);
        else media.push(r);
      }
      const { media: _drop, ...rest } = res;
      return { ...rest, content: notes.length === 0 ? res.content : `${res.content}\n${notes.join("\n")}`, ...(media.length === 0 ? {} : { media }) };
    }) };
  });
  return { context: { ...context, turns }, converted, warnings };
}
