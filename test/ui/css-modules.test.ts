import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";
import { declarationFor, localClasses } from "../../extensions/vscode/tools/css-classes.mts";

describe("class names in a CSS module", () => {
  test("every class in a selector is local, whatever it is combined with", () => {
    assert.deepEqual(localClasses(".a { color: red } .b.c > .d:hover, button.e::after { x: y }"), ["a", "b", "c", "d", "e"]);
  });

  test(":global(...) is left out, and so are keyframes, declarations, strings, comments and attribute selectors", () => {
    const css = `
      /* .commented { } */
      .row :global(.icon-button) { margin: 0.5px; background: url("a.b.png") }
      :global(.keep) .y[data-x=".nope"] { color: red }
      @keyframes spin { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }
      @media (max-width: 300px) { .z { color: blue } }
      @container (max-width: 300px) { .w:not(.v) { color: blue } }
    `;
    assert.deepEqual(localClasses(css), ["row", "v", "w", "y", "z"]);
  });

  test("the declaration lists the names and says where it came from", () => {
    const d = declarationFor("x.module.css", ".a-b { } .c { }");
    assert.match(d, /Generated from x\.module\.css/);
    assert.match(d, /readonly "a-b": string;/);
    assert.match(declarationFor("x.module.css", ".a_b { }"), /readonly a_b: string;/);
    assert.match(d, /export default styles;/);
  });

  test("the declarations beside the stylesheets are up to date (run `pnpm --filter chattree-vscode gen:css`)", () => {
    execFileSync(process.execPath, ["--no-warnings", "extensions/vscode/tools/gen-css-types.mts", "--check"], { stdio: "pipe" });
  });
});
