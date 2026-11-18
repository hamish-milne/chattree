/**
 * A form over some JSON: the data a view needs to show a settings sheet or the `harness.yml` editor. The JSON Schema
 * is the same one validation and editors use, so the view builds fields from it and the controller keeps the rules.
 * The controller owns validation: the view sends an edited value and gets back the same form with `issues` filled in.
 */
import { Type, type Static } from "typebox";
import { strictObject } from "../../src/validate.ts";

export const formIssue = strictObject({
  /** Where in the value, as a dotted path (`limits.max_turn_usd`); empty for the whole value. */
  path: Type.String(),
  message: Type.String(),
});
export type FormIssue = Static<typeof formIssue>;

export const formSpec = strictObject({
  /** Which form this is (`harness`, `model-settings`); intents name it. */
  id: Type.String({ minLength: 1 }),
  title: Type.String(),
  /** A JSON Schema describing `value`. */
  schema: Type.Record(Type.String(), Type.Unknown()),
  value: Type.Record(Type.String(), Type.Unknown()),
  issues: Type.Array(formIssue),
  /** `value` differs from what is saved. */
  dirty: Type.Boolean(),
  /** What saving does, for the button (`Save and commit`, `Apply to thread`). */
  saveLabel: Type.String(),
});
export type FormSpec = Static<typeof formSpec>;
