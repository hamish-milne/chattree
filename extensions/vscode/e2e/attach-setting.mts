import { readFileSync } from "node:fs";

/** The `chattree.attach` map in a folder's `.vscode/settings.json`: repository path to conversation folder. */
export function attachSetting(file: string): Record<string, string> {
  const json: unknown = JSON.parse(readFileSync(file, "utf8"));
  const map = typeof json === "object" && json !== null ? new Map(Object.entries(json)).get("chattree.attach") : undefined;
  if (typeof map !== "object" || map === null) return {};
  return Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => typeof e[1] === "string"));
}
