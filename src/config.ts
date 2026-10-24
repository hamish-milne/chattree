import { Document, isAlias, isMap, isScalar, parseDocument, visit, type ParsedNode } from "yaml";
import { SchemaError, type Issue } from "./errors.ts";
import { hashValue } from "./hash.ts";
import { TAG_KEY, VALUE_KEY, findDropped, objectToValue } from "./schema.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * Configuration files. Same schemas, validation and hashing as the transcript, but a different codec:
 * people edit these by hand, so they are read with the `yaml` package (comments, flow style, plain scalars,
 * anything YAML 1.2 core allows) and edited through its comment-preserving document model. The strict
 * canonical codec is never used for them.
 *
 * What is rejected, because it makes a config ambiguous or unhashable: anchors and aliases, custom tags,
 * duplicate keys, multiple documents, non-finite numbers, non-string keys, and the reserved keys
 * `$tag`/`$value`.
 */

export type ConfigResult<T> = { ok: true; value: T; hash: string } | { ok: false; issues: Issue[] };

export interface ConfigOptions {
  /** Reject fields the schema would drop (typos in a config are bugs). Default true. */
  strict?: boolean;
}

const fail = (message: string, path = ""): { ok: false; issues: Issue[] } => ({ ok: false, issues: [{ path, message }] });

function pathOf(path: readonly unknown[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

function structural(doc: Document.Parsed): Issue[] {
  const issues: Issue[] = [];
  const line = (node: unknown): string => {
    const range = (node as { range?: [number, number, number] } | null)?.range;
    if (range === undefined) return "";
    return ` (offset ${range[0]})`;
  };
  visit(doc, {
    Alias(_k, node) {
      issues.push({ path: "", message: `aliases are not allowed in config files${line(node)}` });
    },
    Node(_k, node) {
      if (isAlias(node)) return;
      const anchor = (node as { anchor?: string }).anchor;
      if (anchor !== undefined) issues.push({ path: "", message: `anchors are not allowed in config files (&${anchor})${line(node)}` });
    },
    Scalar(_k, node) {
      if (typeof node.value === "number" && !Number.isFinite(node.value)) {
        issues.push({ path: "", message: `non-finite number${line(node)}` });
      }
      if (node.value instanceof Date) issues.push({ path: "", message: `timestamps are not supported; quote the value${line(node)}` });
    },
    Pair(_k, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        issues.push({ path: "", message: `map keys must be strings${line(pair.key)}` });
      } else if (pair.key.value === TAG_KEY || pair.key.value === VALUE_KEY) {
        issues.push({ path: "", message: `the key ${pair.key.value} is reserved${line(pair.key)}` });
      }
    },
  });
  return issues;
}

/** Parse text into a document, with every problem the YAML library reports (errors and warnings) as an issue. */
export function loadConfigDocument(text: string): { doc: Document.Parsed; issues: Issue[] } {
  const doc = parseDocument(text, { version: "1.2", uniqueKeys: true, prettyErrors: false, strict: true });
  const issues: Issue[] = [];
  for (const e of [...doc.errors, ...doc.warnings]) {
    const pos = e.linePos?.[0];
    issues.push({ path: "", message: `${pos ? `line ${pos.line}, column ${pos.col}: ` : ""}${e.message.split("\n")[0]}` });
  }
  if (issues.length === 0) issues.push(...structural(doc));
  return { doc, issues };
}

function checkRoot(doc: Document.Parsed): Issue | undefined {
  const c = doc.contents as ParsedNode | null;
  if (c === null || !isMap(c)) return { path: "", message: "a config file must be a map at the top level" };
  return undefined;
}

async function validate<T>(schema: StandardSchemaV1<unknown, T>, plain: unknown, strict: boolean): Promise<ConfigResult<T>> {
  const r = await schema["~standard"].validate(plain);
  if (r.issues !== undefined) {
    return {
      ok: false,
      issues: r.issues.map((i) => ({ path: pathOf((i.path ?? []).map((s) => (typeof s === "object" ? s.key : s))), message: i.message })),
    };
  }
  if (strict) {
    const dropped = findDropped(plain, r.value);
    if (dropped.length > 0) return { ok: false, issues: dropped.map((path) => ({ path, message: "unknown field (not in the schema)" })) };
  }
  try {
    return { ok: true, value: r.value, hash: await hashValue(objectToValue(r.value)) };
  } catch (e) {
    if (e instanceof SchemaError) return { ok: false, issues: e.issues };
    throw e;
  }
}

/**
 * Parse and validate a config file. The hash is of the validated data, in canonical form with sorted keys:
 * comments, spacing, quoting, flow versus block style and key order do not affect it; values and list order do.
 */
export async function parseConfig<T>(text: string, schema: StandardSchemaV1<unknown, T>, opts: ConfigOptions = {}): Promise<ConfigResult<T>> {
  if (/\u0000/.test(text)) return fail("config files may not contain NUL bytes");
  const { doc, issues } = loadConfigDocument(text);
  if (issues.length > 0) return { ok: false, issues };
  const rootIssue = checkRoot(doc);
  if (rootIssue !== undefined) return { ok: false, issues: [rootIssue] };
  return validate(schema, doc.toJS({ maxAliasCount: 0 }), opts.strict !== false);
}

/**
 * Change values in a config file, keeping its comments and layout. The edit is applied to the document,
 * the result is re-read and validated, and nothing is returned unless it is valid.
 */
export async function editConfig<T>(
  text: string,
  schema: StandardSchemaV1<unknown, T>,
  edit: (doc: Document.Parsed) => void,
  opts: ConfigOptions = {},
): Promise<{ ok: true; text: string; value: T; hash: string } | { ok: false; issues: Issue[] }> {
  const { doc, issues } = loadConfigDocument(text);
  if (issues.length > 0) return { ok: false, issues };
  edit(doc);
  const out = doc.toString({ flowCollectionPadding: false });
  const r = await parseConfig(out, schema, opts);
  return r.ok ? { ok: true, text: out, value: r.value, hash: r.hash } : r;
}
