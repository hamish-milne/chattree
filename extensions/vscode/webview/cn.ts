/** Join class names, leaving out what is false, undefined or empty: `cn(css.row, active && css.active, "icon-button")`. */
export function cn(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => p !== false && p !== null && p !== undefined && p !== "").join(" ");
}

/** The class a stylesheet has for a state (`kind-fork`), or none when it has no rule for that state. */
export function pick(css: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  return css[name];
}
