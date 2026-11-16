/** A comparator for `.sort()` of values that are compared as text (arrays of pairs, say), in code-unit order as the default sort does. */
export const byText = (a: unknown, b: unknown): number => {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
