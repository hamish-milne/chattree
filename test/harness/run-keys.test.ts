import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { runAllowKeys, runCovers, validateRunKey, type RunKeyContext } from "../../harness/starter/run-keys.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const SAFE = ["cat", "grep", "ls", "head", "sort", "git status", "git diff", "find", "sed"];

async function ws() {
  const dir = await tempDir();
  for (const f of ["a.txt", "src/a.ts", "src/b.ts", "tools/x.ts", "notes/n.md"]) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), "x\n");
  }
  const outside = await tempDir();
  await writeFile(join(outside, "secret"), "s");
  await symlink(outside, join(dir, "link"));
  const ctx: RunKeyContext = { host, workspace: dir, safe: SAFE, expand: (n) => (n === "HOME" ? "/home/u" : (() => { throw new Error(`$${n} not allowed`); })()) };
  return { dir, ctx };
}

const covers = async (keys: string[], command: string) => runCovers(keys, command, (await ws()).ctx);

describe("keys: what a key says", () => {
  test("a key is one command with patterns; the program is written out; ** only last; no pipelines or variables", () => {
    for (const ok of ["grep **", "git status **", "node ./tools/*.ts", "grep ** > ./**", "sort < ./** > ./out/*", "ls *"]) assert.equal(validateRunKey(ok), undefined, ok);
    assert.match(validateRunKey("cat a | grep b") ?? "", /one command/);
    assert.match(validateRunKey("* foo") ?? "", /wildcard/);
    assert.match(validateRunKey("grep ** foo") ?? "", /last word/);
    assert.match(validateRunKey("echo $HOME") ?? "", /not allowed/);
    assert.match(validateRunKey("xargs **") ?? "", /runs other programs/);
    assert.match(validateRunKey("env FOO=1 **") ?? "", /runs other programs/);
    assert.equal(validateRunKey("env"), undefined, "written out in full, a runner is only itself");
    assert.match(validateRunKey("cat > /dev/null") ?? "", /needs no key/);
  });
});

describe("keys: covering a call", () => {
  test("`*` is exactly one argument and a last `**` is any number, including none", async () => {
    assert.deepEqual(await covers(["ls *"], "ls src"), ["ls *"]);
    assert.equal(await covers(["ls *"], "ls"), undefined);
    assert.equal(await covers(["ls *"], "ls src notes"), undefined);
    assert.deepEqual(await covers(["ls **"], "ls"), ["ls **"]);
    assert.deepEqual(await covers(["ls **"], "ls -la src notes"), ["ls **"]);
    assert.deepEqual(await covers(["git status **"], "git status -s"), ["git status **"]);
    assert.equal(await covers(["git status **"], "git push"), undefined);
    assert.equal(await covers(["git status **"], "git"), undefined);
  });

  test("other words are globs: `*` stays in a segment, `**` crosses, and the candidate may itself be a glob", async () => {
    assert.deepEqual(await covers(["node ./tools/*.ts"], "node tools/x.ts"), ["node ./tools/*.ts"], "paths compare as ./relative");
    assert.equal(await covers(["node ./tools/*.ts"], "node src/a.ts"), undefined);
    assert.equal(await covers(["node ./tools/*.ts"], "node tools/x.ts extra"), undefined);
    assert.deepEqual(await covers(["cat ./**"], "cat src/a.ts"), ["cat ./**"]);
    assert.deepEqual(await covers(["cat ./**"], "cat ./a.txt"), ["cat ./**"]);
    assert.deepEqual(await covers(["cat ./src/*"], "cat src/*.ts"), ["cat ./src/*"], "a candidate glob is covered when the files it names are");
    assert.equal(await covers(["cat ./src/*"], "cat */*.ts"), undefined, "...and not when it names more");
    assert.equal(await covers(["cat ./**"], "cat missing-*.xyz"), undefined, "a glob that matches nothing does not run");
  });

  test("a pipeline needs every stage covered, each by some key", async () => {
    assert.deepEqual(await covers(["cat **", "grep **"], "cat a.txt | grep x"), ["cat **", "grep **"]);
    assert.equal(await covers(["cat **"], "cat a.txt | grep x"), undefined);
    assert.equal(await covers(["cat **", "grep **", "sort **"], "cat a.txt | wc -l"), undefined);
    assert.deepEqual(await covers(["grep **"], "grep x a.txt"), ["grep **"], "one stage is a pipeline of one");
  });

  test("a redirect must be named by the key; `>` covers `>>`; `/dev/null` needs nothing", async () => {
    assert.equal(await covers(["grep **"], "grep x a.txt > out.txt"), undefined);
    assert.deepEqual(await covers(["grep ** > ./**"], "grep x a.txt > out.txt"), ["grep ** > ./**"]);
    assert.deepEqual(await covers(["grep ** > ./**"], "grep x a.txt >> out.txt"), ["grep ** > ./**"]);
    assert.equal(await covers(["grep ** >> ./**"], "grep x a.txt > out.txt"), undefined, ">> does not allow >");
    assert.equal(await covers(["grep ** > ./out/*"], "grep x a.txt > src/out.txt"), undefined, "the target must match the key's pattern");
    assert.deepEqual(await covers(["grep **"], "grep x a.txt > /dev/null"), ["grep **"]);
    assert.deepEqual(await covers(["sort ** < ./**"], "sort < a.txt"), ["sort ** < ./**"]);
    assert.equal(await covers(["sort **"], "sort < a.txt"), undefined);
  });

  test("the redirect belongs to the right stage: input to the first, output to the last", async () => {
    assert.deepEqual(await covers(["cat **", "sort ** > ./**"], "cat a.txt | sort > o.txt"), ["cat **", "sort ** > ./**"]);
    assert.equal(await covers(["cat ** > ./**", "sort **"], "cat a.txt | sort > o.txt"), undefined);
  });

  test("a redirect into a protected file is not covered by any key", async () => {
    assert.equal(await covers(["cat ** > ./**"], "cat a.txt > harness.yml"), undefined);
    assert.equal(await covers(["cat ** > ./**"], "cat a.txt > chat.yml"), undefined);
  });

  test("nothing outside the workspace is covered, however the key is written", async () => {
    const { ctx, dir } = await ws();
    for (const cmd of ["cat /etc/hostname", "cat ../x", "cat ./../x", "cat link/secret", "cat link", "grep x --file=/etc/passwd", `cat ${dir}/../x`]) {
      assert.equal(await runCovers(["cat **", "grep **", "cat *"], cmd, ctx), undefined, cmd);
      assert.equal(await runAllowKeys(cmd, ctx), null, `${cmd}: offered once only`);
    }
    assert.deepEqual(await runCovers(["cat **"], `cat ${dir}/a.txt`, ctx), ["cat **"], "an absolute path inside the workspace is fine");
    assert.equal(await runCovers(["cat **"], "cat .git/config", ctx), undefined, "unreadable paths are not covered either");
  });

  test("a pattern key never covers writes or runners, but an exact key is what the user saw", async () => {
    assert.equal(await covers(["sed **"], "sed -i s/a/b/ a.txt"), undefined);
    assert.equal(await covers(["sed **"], "sed -ni p a.txt"), undefined);
    assert.deepEqual(await covers(["sed **"], "sed -n 1p a.txt"), ["sed **"]);
    assert.equal(await covers(["sort **"], "sort -o out a.txt"), undefined);
    assert.equal(await covers(["find **"], "find . -name x -delete"), undefined);
    assert.equal(await covers(["find **"], "find . -exec rm {} +"), undefined);
    assert.equal(await covers(["git diff **"], "git diff --output=x"), undefined);
    assert.deepEqual(await covers(["sed -i s/a/b/ a.txt"], "sed -i s/a/b/ a.txt"), ["sed -i s/a/b/ a.txt"], "an exact key allows exactly that");
    assert.equal(await covers(["sed -i s/a/b/ a.txt"], "sed -i s/a/c/ a.txt"), undefined);
  });

  test("a malformed or syntactically bad call is not covered, and a bad stored key is ignored", async () => {
    assert.equal(await covers(["cat **"], "cat a.txt; rm -rf ."), undefined);
    assert.equal(await covers(["cat **"], "cat $SECRET"), undefined);
    assert.deepEqual(await covers(["bad | key", "cat **"], "cat a.txt"), ["cat **"]);
  });
});

describe("keys: what a grant would add", () => {
  test("a listed read-only command is offered as its prefix with **", async () => {
    const { ctx } = await ws();
    assert.deepEqual(await runAllowKeys("grep -n TODO src/a.ts", ctx), ["grep **"]);
    assert.deepEqual(await runAllowKeys("git status -s", ctx), ["git status **"]);
    assert.deepEqual(await runAllowKeys("git diff HEAD", ctx), ["git diff **"]);
  });
  test("anything else is offered exactly as written, never as a wider pattern", async () => {
    const { ctx } = await ws();
    assert.deepEqual(await runAllowKeys("git push origin main", ctx), ["git push origin main"]);
    assert.deepEqual(await runAllowKeys("node tools/x.ts --flag", ctx), ["node tools/x.ts --flag"]);
    assert.deepEqual(await runAllowKeys("echo 'two words'", ctx), ["echo 'two words'"]);
    assert.deepEqual(await runAllowKeys("sed -i s/a/b/ a.txt", ctx), ["sed -i s/a/b/ a.txt"], "a listed program with a writing argument falls back to exact");
  });
  test("a pipeline offers a key per stage, and redirects ride on the right stage", async () => {
    const { ctx } = await ws();
    assert.deepEqual(await runAllowKeys("cat a.txt | grep x | sort", ctx), ["cat **", "grep **", "sort **"]);
    assert.deepEqual(await runAllowKeys("cat a.txt | sort > o.txt", ctx), ["cat **", "sort ** > ./**"]);
    assert.deepEqual(await runAllowKeys("sort < a.txt >> o.txt", ctx), ["sort ** < ./** >> ./**"]);
    assert.deepEqual(await runAllowKeys("node t.js > o.txt", ctx), ["node t.js > o.txt"]);
  });
  test("a runner is never offered with a wildcard, and a call that will not run is offered nothing", async () => {
    const { ctx } = await ws();
    assert.deepEqual(await runAllowKeys("xargs echo", { ...ctx, safe: [...SAFE, "xargs"] }), ["xargs echo"]);
    assert.equal(await runAllowKeys("cat a.txt; ls", ctx), null);
    assert.equal(await runAllowKeys("cat nope-*.zzz", ctx), null);
  });
  test("what is offered covers the call it was offered for", async () => {
    const { ctx } = await ws();
    for (const cmd of ["grep -n TODO src/a.ts", "git status -s", "git push origin main", "cat a.txt | sort > o.txt", "sort < a.txt >> o.txt", "echo 'two words'", "node tools/x.ts --flag", "cat src/*.ts | grep x"]) {
      const keys = await runAllowKeys(cmd, ctx);
      assert.ok(keys !== null, cmd);
      assert.ok((await runCovers(keys, cmd, ctx)) !== undefined, `${cmd} with ${JSON.stringify(keys)}`);
    }
  });
});

describe("keys: a bad stored key", () => {
  test("never throws and covers nothing", async () => {
    assert.equal(await covers(["grep ** foo"], "grep x a.txt"), undefined);
  });
});
