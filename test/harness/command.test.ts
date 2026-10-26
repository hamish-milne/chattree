import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CommandSyntax, parseCommand } from "../../harness/starter/command.ts";
import { BUSYBOX_APPLETS, NotAvailable, portableStage } from "../../harness/starter/portable.ts";

const env: Record<string, string> = { NAME: "world", DIR: "src" };
const expand = (n: string): string => {
  const v = env[n];
  if (v === undefined) throw new CommandSyntax(`$${n} is not an allowed environment variable`);
  return v;
};
const parse = (s: string) => parseCommand(s, expand);
const words = (s: string): string[][] => parse(s).stages.map((st) => st.map((w) => w.text));
const refused = (s: string, re: RegExp) => assert.throws(() => parse(s), (e) => e instanceof CommandSyntax && re.test(e.message), s);

describe("the run command syntax", () => {
  test("words, single and double quotes, and escapes", () => {
    assert.deepEqual(words("ls -la src"), [["ls", "-la", "src"]]);
    assert.deepEqual(words("  echo   a    b  "), [["echo", "a", "b"]]);
    assert.deepEqual(words("echo 'a  b' \"c d\" e'f'\"g\""), [["echo", "a  b", "c d", "efg"]]);
    assert.deepEqual(words("echo 'it'\\''s' \"say \\\"hi\\\"\""), [["echo", "it's", 'say "hi"']]);
    assert.deepEqual(words("echo a\\ b \\* \\$HOME"), [["echo", "a b", "*", "$HOME"]]);
    assert.deepEqual(words("echo ''"), [["echo", ""]], "an empty quoted word is a word");
    assert.deepEqual(words("cat src\\main\\a.txt C:\\Users\\x"), [["cat", "src\\main\\a.txt", "C:\\Users\\x"]], "a backslash before an ordinary character is literal: Windows paths survive");
  });

  test("quoted characters are not operators: pipes, redirects, semicolons and wildcards inside quotes are text", () => {
    const p = parse("grep 'a|b' \"x > y\" 'c;d' '*.ts'");
    assert.deepEqual(p.stages[0]?.map((w) => [w.text, w.glob]), [["grep", false], ["a|b", false], ["x > y", false], ["c;d", false], ["*.ts", false]]);
    assert.equal(p.stdout, undefined);
  });

  test("pipes make stages", () => {
    assert.deepEqual(words("cat a.txt | sort | uniq -c"), [["cat", "a.txt"], ["sort"], ["uniq", "-c"]]);
    assert.deepEqual(words("a|b"), [["a"], ["b"]], "no spaces needed");
  });

  test("redirects: input, output, append, /dev/null, 2>&1 and 2>/dev/null", () => {
    const p = parse("sort < in.txt > out.txt");
    assert.equal(p.stdin?.text, "in.txt");
    assert.deepEqual(p.stdout && { t: (p.stdout.target as { text: string }).text, a: p.stdout.append }, { t: "out.txt", a: false });
    assert.equal(parse("echo hi >> log.txt").stdout?.append, true);
    assert.equal(parse("echo hi >log.txt").stdout !== undefined, true, "no space after >");
    assert.equal(parse("echo hi > /dev/null").stdout?.target, "discard");
    assert.equal(parse("cmd < /dev/null").stdin, undefined);
    assert.deepEqual(words("make 2>&1 | tail"), [["make"], ["tail"]]);
    assert.deepEqual(words("make > build.log 2>&1"), [["make"]]);
    assert.deepEqual(words("cmd 2>/dev/null"), [["cmd"]]);
    assert.deepEqual(words("cmd 2> /dev/null | wc"), [["cmd"], ["wc"]]);
    assert.equal(parse("echo hi 1> f.txt").stdout !== undefined, true, "1> is >");
    assert.deepEqual(words("echo 2"), [["echo", "2"]], "a lone 2 is just a word");
    assert.deepEqual(words("echo a2>b").length, 1);
  });

  test("redirects are on the right stage", () => {
    refused("a > x | b", /last command/);
    refused("a | b < x", /first command/);
    refused("a > x > y", /only one/);
    refused("a >", /needs a file name/);
    refused("a > |", /needs a file name/);
  });

  test("unquoted wildcards are marked for expansion; braces only when they list alternatives", () => {
    const p = parse("wc -l src/*.ts a?.txt [ab].md f{1,2}.txt {\"a\":1} 'x*'");
    assert.deepEqual(p.stages[0]?.map((w) => w.glob), [false, false, true, true, true, true, false, false]);
    refused("*.sh arg", /program name cannot be a wildcard/);
  });

  test("$NAME and ${NAME} expand for allowed names, also inside double quotes but not single; other $ are literal", () => {
    assert.deepEqual(words("echo $NAME ${NAME}s \"hi $NAME\" '$NAME' $DIR/*.ts"), [["echo", "world", "worlds", "hi world", "$NAME", "src/*.ts"]]);
    assert.deepEqual(words("echo 'a$' \"cost: $5\" a$"), [["echo", "a$", "cost: $5", "a$"]]);
    assert.throws(() => parse("echo $SECRET"), /\$SECRET is not an allowed/);
    assert.equal(parse("echo $DIR/*.ts").stages[0]?.[1]?.glob, true, "the expanded text can still be globbed");
  });

  test("what a shell does that run does not is refused, each time pointing to the script tool", () => {
    for (const [s, re] of [
      ["a; b", /`;`/], ["a && b", /`&&`/], ["a || b", /`\|\|`/], ["a &", /`&`/], ["a & b", /`&`/], ["a &> f", /`&>`/],
      ["echo `date`", /backticks/], ["echo \"`date`\"", /backticks/], ["echo $(date)", /\$\(\.\.\.\)/], ["(cd x; ls)", /subshells/],
      ["cat <<EOF", /heredocs/], ["cat <(ls)", /process substitution/], ["A=1 node x.js", /setting a variable/],
      ["ls ~/x", /`~`/], ["echo ${A:-b}", /\$\{NAME\}/], ["make 2> err.txt", /redirecting stderr to a file/], ["echo a\nls", /single line/],
    ] as const) refused(s, new RegExp(`${re.source}[\\s\\S]*|${re.source}`));
    assert.throws(() => parse("a; b"), /script tool/);
    assert.throws(() => parse("echo a\nb"), /script tool/);
  });

  test("an empty command, an empty stage and unclosed quotes are errors that say so", () => {
    refused("", /empty/);
    refused("   ", /empty/);
    refused("| a", /before it/);
    refused("a |", /after it/);
    refused("a | | b", /before it/);
    refused("echo 'abc", /never closed/);
    refused('echo "abc', /never closed/);
  });

  test("a tilde is only special at the start of a word", () => {
    assert.deepEqual(words("echo a~b '~'"), [["echo", "a~b", "~"]]);
  });
});

describe("cross-platform utilities", () => {
  test("on POSIX, and for programs not on the list, the stage is untouched", () => {
    assert.deepEqual(portableStage(["cat", "a"], "posix", undefined), ["cat", "a"]);
    assert.deepEqual(portableStage(["cat", "a"], undefined, undefined), ["cat", "a"]);
    assert.deepEqual(portableStage(["git", "status"], "windows", "C:\\bb\\busybox.exe"), ["git", "status"]);
    assert.deepEqual(portableStage(["node", "-v"], "windows", "C:\\bb\\busybox.exe"), ["node", "-v"]);
  });

  test("on Windows the utilities become busybox applets, however they were spelt, but a path is left alone", () => {
    const bb = "C:\\tools\\busybox.exe";
    assert.deepEqual(portableStage(["cat", "a.txt"], "windows", bb), [bb, "cat", "a.txt"]);
    assert.deepEqual(portableStage(["SORT.EXE", "-r"], "windows", bb), [bb, "sort", "-r"]);
    assert.deepEqual(portableStage(["find", ".", "-name", "*.ts"], "windows", bb), [bb, "find", ".", "-name", "*.ts"], "find is a different program on Windows");
    assert.deepEqual(portableStage(["./cat", "x"], "windows", bb), ["./cat", "x"]);
    assert.deepEqual(portableStage(["C:\\bin\\ls.exe"], "windows", bb), ["C:\\bin\\ls.exe"]);
  });

  test("on Windows without busybox the model is told what to do instead of getting 'command not found'", () => {
    assert.throws(() => portableStage(["grep", "x"], "windows", undefined), (e) => e instanceof NotAvailable && /grep is not available.*fetch-busybox.*read tool/.test(e.message));
  });

  test("the list holds the everyday utilities and not programs that exist everywhere", () => {
    for (const a of ["cat", "ls", "grep", "sed", "awk", "head", "tail", "wc", "sort", "find", "cp", "mv", "rm", "mkdir", "touch", "echo"]) assert.ok(BUSYBOX_APPLETS.has(a), a);
    for (const a of ["git", "node", "npm", "curl", "python", "tar"]) assert.ok(!BUSYBOX_APPLETS.has(a), a);
  });
});
