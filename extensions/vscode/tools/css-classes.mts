/**
 * Which class names a CSS module defines, and the `.d.ts` that says so: `import s from "./x.module.css"` is then checked by
 * `tsc` (a misspelt `s.pil` is a type error), which esbuild's local-name renaming alone cannot give.
 */

/** Remove comments, strings and attribute selectors, which can hold dots that are not classes. */
const plain = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

/** `:global(...)` with its balanced contents removed: what is inside is not ours. */
function withoutGlobal(selector: string): string {
  let out = "";
  for (let i = 0; i < selector.length;) {
    if (selector.startsWith(":global(", i)) {
      let depth = 0;
      let j = i + ":global".length;
      for (; j < selector.length; j++) {
        if (selector[j] === "(") depth++;
        else if (selector[j] === ")" && --depth === 0) break;
      }
      i = j + 1;
    } else out += selector[i++];
  }
  return out;
}

/** Selector preludes of every rule: text before a `{`, from the last `{`, `}` or `;`. Bodies of keyframes and font-faces are skipped. */
function preludes(css: string): string[] {
  const out: string[] = [];
  let start = 0;
  let skip = 0; // brace depth inside a block whose contents are not selectors
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      const prelude = css.slice(start, i).trim();
      if (skip > 0) skip++;
      else if (/^@(?:-\w+-)?keyframes\b|^@font-face\b|^@property\b/.test(prelude)) skip = 1;
      else if (!prelude.startsWith("@")) out.push(prelude);
      start = i + 1;
    } else if (c === "}") {
      if (skip > 0) skip--;
      start = i + 1;
    } else if (c === ";") start = i + 1;
  }
  return out;
}

/** The local class names a module defines, sorted. */
export function localClasses(css: string): string[] {
  const names = new Set<string>();
  for (const p of preludes(plain(css))) {
    const sel = withoutGlobal(p).replace(/\[[^\]]*\]/g, "");
    for (const m of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(m[1] ?? "");
  }
  return [...names].sort();
}

/** The declaration file's text for a module. */
export function declarationFor(file: string, css: string): string {
  const body = localClasses(css)
    .map((n) => `  readonly ${JSON.stringify(n)}: string;`)
    .join("\n");
  return `// Generated from ${file} by tools/gen-css-types.mts. Do not edit.\ndeclare const styles: {\n${body}\n};\nexport default styles;\n`;
}
