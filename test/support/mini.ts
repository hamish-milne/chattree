import type { StandardIssue, StandardSchemaV1 } from "../../src/index.ts";

/**
 * A tiny hand-written validator that implements the Standard Schema contract. The generic pipeline tests
 * use it (instead of zod) to show the library depends on the contract only.
 */
export type Check = (v: unknown, path: PropertyKey[]) => { value: unknown } | { issues: StandardIssue[] };

const bad = (message: string, path: PropertyKey[]) => ({ issues: [{ message, path }] });

export const str: Check = (v, p) => (typeof v === "string" ? { value: v } : bad("expected string", p));
export const num: Check = (v, p) => (typeof v === "number" ? { value: v } : bad("expected number", p));
export const bool: Check = (v, p) => (typeof v === "boolean" ? { value: v } : bad("expected boolean", p));
export const any: Check = (v) => ({ value: v });
export const lit = (x: string): Check => (v, p) => (v === x ? { value: v } : bad(`expected ${JSON.stringify(x)}`, p));
export const opt = (c: Check): Check => (v, p) => (v === undefined ? { value: undefined } : c(v, p));

export const arr = (item: Check): Check => (v, p) => {
  if (!Array.isArray(v)) return bad("expected list", p);
  const out: unknown[] = [];
  const issues: StandardIssue[] = [];
  v.forEach((x, i) => {
    const r = item(x, [...p, i]);
    if ("issues" in r) issues.push(...r.issues);
    else out.push(r.value);
  });
  return issues.length > 0 ? { issues } : { value: out };
};

/** Accepts the first alternative that validates. */
export const either = (...cs: Check[]): Check => (v, p) => {
  for (const c of cs) {
    const r = c(v, p);
    if (!("issues" in r)) return r;
  }
  return bad("no alternative matched", p);
};

/** An object check that, like zod's default, drops keys not in the shape. Output keys follow the shape's order. */
export const obj = (shape: Record<string, Check>): Check => (v, p) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad("expected object", p);
  const out: Record<string, unknown> = {};
  const issues: StandardIssue[] = [];
  for (const [k, c] of Object.entries(shape)) {
    const r = c((v as Record<string, unknown>)[k], [...p, k]);
    if ("issues" in r) issues.push(...r.issues);
    else if (r.value !== undefined) out[k] = r.value;
  }
  return issues.length > 0 ? { issues } : { value: out };
};

export const schema = (c: Check): StandardSchemaV1<unknown, Record<string, unknown>> => ({
  "~standard": {
    version: 1,
    vendor: "mini",
    validate: (v) => {
      const r = c(v, []);
      return "issues" in r ? { issues: r.issues } : { value: r.value as Record<string, unknown> };
    },
  },
});
