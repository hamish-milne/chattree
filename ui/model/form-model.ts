/**
 * Turns a JSON Schema and a value into the fields a form shows, and keeps a form's state as a signal model. The
 * schema is the one the harness validates with, so a form never knows more than the harness does: it shows what
 * the schema describes (text, numbers, switches, choices, lists of text, groups, maps of groups) and leaves any
 * shape it cannot edit as plain data (`raw`). Validation is the controller's: an edit is sent, and the same form comes
 * back with its issues filled in.
 */
import { createModel, computed, signal } from "@preact/signals-core";
import type { FormIssue, FormSpec } from "./form.ts";
import type { UiEvent, UiIntent } from "./protocol.ts";

type Json = Record<string, unknown>;

interface Common {
  /** Where the value is in the whole value. */
  path: string[];
  key: string;
  /** What the form calls it: the schema's `title`, or the key put into words ("max_output_tokens" is "Max output tokens"). */
  label: string;
  description: string | undefined;
  /** What the provider does when it is not set, if the schema says (`x-default`): shown instead of an empty field. */
  fallback: unknown;
  /** The object it is in does not require it, so it may be left unset (and put back to the default). */
  optional: boolean;
  /** The schema marks it as a setting few people touch (`x-advanced`): the view keeps it out of the way. */
  advanced: boolean;
  /** What is wrong with this value, from the controller. */
  issues: string[];
}

export type Field = Common &
  (
    | { kind: "string"; value: string }
    | { kind: "number"; integer: boolean; min: number | undefined; max: number | undefined; value: number | undefined }
    | { kind: "boolean"; value: boolean }
    | { kind: "choice"; options: string[]; value: string | undefined }
    | { kind: "list"; value: string[] }
    | { kind: "group"; fields: Field[] }
    /** An object whose keys the person chooses (providers, tool grants): each entry is a group. */
    | { kind: "map"; entries: { key: string; fields: Field[] }[]; template: Field[] }
    | { kind: "raw"; value: unknown }
  );

const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const objectOf = (x: unknown): Json => (isObject(x) ? x : {});
const text = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const num = (x: unknown): number | undefined => (typeof x === "number" ? x : undefined);

/** A key in words: "max_output_tokens" is "Max output tokens". */
export function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words === "" ? key : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** A path in the dotted form issues use. */
export const dotted = (path: readonly string[]): string => path.join(".");

/** The same value with `path` set to `to`. Nothing is changed in place. */
export function setIn(value: Json, path: readonly string[], to: unknown): Json {
  const [head, ...rest] = path;
  if (head === undefined) return isObject(to) ? to : value;
  return { ...value, [head]: rest.length === 0 ? to : setIn(objectOf(value[head]), rest, to) };
}

/** The same value without what `path` names. */
export function removeIn(value: Json, path: readonly string[]): Json {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (rest.length === 0) {
    const { [head]: _gone, ...kept } = value;
    return kept;
  }
  return { ...value, [head]: removeIn(objectOf(value[head]), rest) };
}

function fieldOf(key: string, schema: Json, value: unknown, path: string[], issues: Map<string, string[]>, optional = true): Field {
  const common: Common = {
    path,
    key,
    label: text(schema["title"]) ?? humanize(key),
    description: text(schema["description"]),
    fallback: schema["x-default"],
    optional,
    advanced: schema["x-advanced"] === true,
    issues: issues.get(dotted(path)) ?? [],
  };
  const options = Array.isArray(schema["enum"]) ? schema["enum"].filter((o): o is string => typeof o === "string") : undefined;
  if (options !== undefined && options.length > 0) return { ...common, kind: "choice", options, value: text(value) };
  switch (schema["type"]) {
    case "string":
      return { ...common, kind: "string", value: text(value) ?? "" };
    case "number":
    case "integer":
      return {
        ...common,
        kind: "number",
        integer: schema["type"] === "integer",
        min: num(schema["minimum"]),
        max: num(schema["maximum"]),
        value: num(value),
      };
    case "boolean":
      return { ...common, kind: "boolean", value: value === undefined ? schema["x-default"] === true : value === true };
    case "array": {
      const items = objectOf(schema["items"]);
      if (items["type"] === "string" && Array.isArray(value) && value.every((v) => typeof v === "string"))
        return { ...common, kind: "list", value: value.map(String) };
      if (items["type"] === "string" && value === undefined) return { ...common, kind: "list", value: [] };
      return { ...common, kind: "raw", value };
    }
    case "object": {
      // A map's entry schema: `additionalProperties`, or the one `patternProperties` entry a record is written with.
      const patterns = Object.values(objectOf(schema["patternProperties"]));
      const extra = isObject(schema["additionalProperties"])
        ? schema["additionalProperties"]
        : patterns.length === 1
          ? patterns[0]
          : undefined;
      if (isObject(extra) && !isObject(schema["properties"])) {
        const entries = Object.keys(objectOf(value)).map((k) => ({
          key: k,
          fields: objectFields(extra, objectOf(objectOf(value)[k]), [...path, k], issues),
        }));
        return { ...common, kind: "map", entries, template: objectFields(extra, {}, [...path, ""], new Map()) };
      }
      return { ...common, kind: "group", fields: objectFields(schema, objectOf(value), path, issues) };
    }
    default:
      return { ...common, kind: "raw", value };
  }
}

/** The fields of an object schema, in the schema's order, then anything in the value the schema does not describe (as raw). */
export function objectFields(schema: Json, value: Json, path: string[], issues: Map<string, string[]>): Field[] {
  const props = objectOf(schema["properties"]);
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  const fields = Object.entries(props).map(([k, s]) => fieldOf(k, objectOf(s), value[k], [...path, k], issues, !required.includes(k)));
  for (const k of Object.keys(value))
    if (!(k in props))
      fields.push({
        path: [...path, k],
        key: k,
        label: k,
        description: undefined,
        fallback: undefined,
        optional: true,
        advanced: true,
        issues: issues.get(dotted([...path, k])) ?? [],
        kind: "raw",
        value: value[k],
      });
  return fields;
}

/** The issues of a form by dotted path. */
export function issueMap(issues: readonly FormIssue[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const i of issues) out.set(i.path, [...(out.get(i.path) ?? []), i.message]);
  return out;
}

export interface FormTree {
  fields: Field[];
  /** Issues about a place no field shows (the whole value, or a key the schema does not know). */
  unplaced: FormIssue[];
}

export function formFields(spec: FormSpec): FormTree {
  const issues = issueMap(spec.issues);
  const fields = objectFields(spec.schema, spec.value, [], issues);
  const shown = new Set<string>();
  const walk = (fs: Field[]): void => {
    for (const f of fs) {
      shown.add(dotted(f.path));
      if (f.kind === "group") walk(f.fields);
      if (f.kind === "map") for (const e of f.entries) walk(e.fields);
    }
  };
  walk(fields);
  return { fields, unplaced: spec.issues.filter((i) => !shown.has(i.path)) };
}

/** A form's state: the spec the controller sent, with edits applied at once and sent on. */
export const FormModel = createModel((initial: FormSpec, send: (intent: UiIntent) => void) => {
  const spec = signal(initial);
  const tree = computed(() => formFields(spec.value));
  const issues = computed(() => issueMap(spec.value.issues));
  const edit = (value: Json): void => {
    spec.value = { ...spec.value, value, dirty: true };
    send({ type: "form.edit", id: spec.peek().id, value });
  };
  return {
    spec,
    tree,
    issues,
    /** Take in an event; true when it was this form's own state. */
    apply(e: UiEvent): boolean {
      if (e.type !== "form.set" || e.form.id !== spec.peek().id) return false;
      spec.value = e.form;
      return true;
    },
    set(path: readonly string[], to: unknown): void {
      edit(setIn(spec.peek().value, path, to));
    },
    remove(path: readonly string[]): void {
      edit(removeIn(spec.peek().value, path));
    },
    /** Put a whole new value in place of the current one (an edit that changes more than one path). */
    replace(value: Json): void {
      edit(value);
    },
    /** Save; for a form that is committed (`harness.yml`) `message` is the commit message. */
    save(message?: string): void {
      send({ type: "form.save", id: spec.peek().id, ...(message === undefined || message === "" ? {} : { message }) });
    },
    revert(): void {
      send({ type: "form.revert", id: spec.peek().id });
    },
  };
});
