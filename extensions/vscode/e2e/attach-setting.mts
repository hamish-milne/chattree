import { readFileSync } from "node:fs";

/** The `chattree.attach` map in a folder's `.vscode/settings.json`: repository path to conversation folder. */
export function attachSetting(file: string): Record<string, string> {
  const json: unknown = JSON.parse(readFileSync(file, "utf8"));
  const top: [string, unknown][] = typeof json === "object" && json !== null ? Object.entries(json) : [];
  const map: unknown = top.find(([k]) => k === "chattree.attach")?.[1];
  if (typeof map !== "object" || map === null) return {};
  const inner: [string, unknown][] = Object.entries(map);
  return Object.fromEntries(inner.filter((e): e is [string, string] => typeof e[1] === "string"));
}
