/**
 * The arguments of a tool call, read where the tool receives them. The registry has already checked them against the tool's schema,
 * so these say so once instead of every use casting; one that is not what the schema promised (a tool whose schema is looser than its
 * code) is thrown, and the call fails with that.
 */
export type ToolArgs = Record<string, unknown>;

const fail = (key: string, want: string, got: unknown): never => {
  throw new TypeError(`the argument ${key} should be ${want}, not ${got === null ? "null" : typeof got}`);
};

/** A string the call must have. */
export function stringArg(args: ToolArgs, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : fail(key, "a string", v);
}

/** A string the call may leave out. */
export function optStringArg(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return v === undefined ? undefined : typeof v === "string" ? v : fail(key, "a string", v);
}

/** A number the call must have. */
export function numberArg(args: ToolArgs, key: string): number {
  const v = args[key];
  return typeof v === "number" ? v : fail(key, "a number", v);
}

/** A number the call may leave out. */
export function optNumberArg(args: ToolArgs, key: string): number | undefined {
  const v = args[key];
  return v === undefined ? undefined : typeof v === "number" ? v : fail(key, "a number", v);
}
