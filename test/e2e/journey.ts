import type { Driver } from "./driver.ts";

/**
 * What the journey needs to know of the world it runs in, and the checks that are not about what is on screen: the
 * files and the history the product leaves behind. The journey is the same for every runner; the world is the test's.
 */
export interface World {
  /** The name of the workspace folder that holds no conversation yet. */
  folder: string;
  /** The messages the person sends, and what the (scripted) model does with them. */
  tasks: { first: string; second: string };
  /** Whether the agent has to be allowed before it writes (a fresh `harness.yml` allows writes; the mock asks anyway). */
  asksBeforeWriting: boolean;
  /** What the (scripted) model says when it has done each task, so that the end of a turn can be told from its start. */
  replies: { first: string; second: string };
  /** The file the work produces, and what it holds after the first task, and after the second. */
  deliverable: { path: string; afterFirst: string; afterSecond: string };
  /** Change a file in the project folder by hand, as someone editing in the editor. */
  editByHand(path: string, text: string): Promise<void>;
  /** The text of a file in the project folder now (undefined: there is none). */
  fileInFolder(path: string): Promise<string | undefined>;
  /** The text of a file as a branch has it (undefined: there is none). */
  fileOnBranch(branch: string, path: string): Promise<string | undefined>;
  /** The branch that is checked out in the project folder. */
  checkedOutBranch(): Promise<string>;
  /** The files the person asked to open (the host's stand-in for the editor records them). */
  opened(): Promise<string[]>;
}

/** What the disk and git hold a moment after the click that changed them (the product answers in its own time). */
async function eventually(what: string, read: () => Promise<unknown>, expected: unknown): Promise<void> {
  let actual: unknown;
  for (let i = 0; i < 100; i++) {
    actual = await read();
    if (actual === expected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const exact = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const assertEqual = (what: string, actual: unknown, expected: unknown): void => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/** Send a message and wait for the turn to end, approving the writes the agent asks to make. */
async function turn(d: Driver, w: World, text: string, reply: string): Promise<void> {
  await d.type({ label: /^Message$/ }, text);
  await d.click({ role: "button", name: "Send" });
  // The agent thinks (the reasoning block stays after it), calls a tool and waits for the person's yes before it writes.
  await d.expectVisible({ text: "Thought" });
  if (w.asksBeforeWriting) {
    await d.expectVisible({ role: "group", name: "Approve this call?" });
    await d.click({ role: "button", name: "Allow" });
  }
  // The agent's closing words are what show the turn is over (the status says Ready before the turn starts, too).
  await d.expectVisible({ text: reply });
  await d.expectVisible({ text: "Ready" });
}

/** The name of the thread open in the chat. */
const openThread = (d: Driver): Promise<string> => d.text({ role: "note", name: "Open thread" });

/** The name of the open thread once it is not `before` (the product answers in its own time, and what is typed before it does is lost). */
async function changedThread(d: Driver, before: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const now = await openThread(d).catch(() => before);
    if (now !== before) return now;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the chat is still on ${before}`);
}

/** The newest row of a thread in the graph. */
const tipRow = (name: string) => ({ role: "listitem", name: new RegExp(`thread ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });

/**
 * One person's work from an empty folder to delivered files: set a folder up, add a provider, give the agent a task and
 * approve its writes, look at the file it made, try an idea on a fork, switch the workspace to it (with a file changed by
 * hand in the way), merge it into the trunk and end with the files in the project folder, checked against the disk and git.
 */
export async function journey(d: Driver, w: World): Promise<void> {
  // 1. A workspace folder with no conversation is initialized from the repository menu.
  await d.click({ role: "button", name: /^Repository/ });
  await d.click({ role: "menuitem", name: exact(`Initialize in ${w.folder}`) });
  await d.expectVisible({ text: "No providers yet" });

  // 2. The sheet is on Providers: add one, see the connection work, save.
  await d.click({ role: "button", name: "Anthropic" });
  await d.expectVisible({ role: "button", name: /^anthropic: Connected/ });
  await d.click({ role: "button", name: /^Save/ });
  await d.click({ role: "button", name: "Back to the chat" });
  await d.screenshot("1-provider-added");

  // 3. A thread, a task, and the agent's work: thinking, a tool call, a write that needs a yes.
  const before = await openThread(d).catch(() => "");
  await d.click({ role: "button", name: "New thread" });
  const first = await changedThread(d, before);
  await turn(d, w, w.tasks.first, w.replies.first);
  await d.expectVisible({ label: /^Tool call: / });
  await d.screenshot("2-first-task");
  assertEqual("the folder before the thread is merged", await w.fileInFolder(w.deliverable.path), undefined);
  assertEqual("the file on the thread", await w.fileOnBranch(first, w.deliverable.path), w.deliverable.afterFirst);

  // 4. A file the agent named opens.
  const file = { role: "button", name: new RegExp(`^${w.deliverable.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) };
  // The name is a link inside the call, which is open already or opens with a click on the call.
  await d.expectVisible(file, 1000).catch(() => d.click({ role: "button", name: exact(w.deliverable.path) }));
  await d.click(file);
  // The intent travels to the host and on to the editor: it is there in a moment.
  for (let i = 0; i < 50 && !(await w.opened()).some((p) => p.endsWith(w.deliverable.path)); i++)
    await new Promise((r) => setTimeout(r, 100));
  assertEqual(
    "the file opened",
    (await w.opened()).some((p) => p.endsWith(w.deliverable.path)),
    true,
  );

  // 5. An idea, tried on a fork from here.
  await d.rightClick(tipRow(first));
  await d.click({ role: "menuitem", name: /^Fork from here/ });
  const fork = await changedThread(d, first);
  if (fork === first) throw new Error("the chat is still on the first thread after a fork");
  await turn(d, w, w.tasks.second, w.replies.second);
  assertEqual("the file on the fork", await w.fileOnBranch(fork, w.deliverable.path), w.deliverable.afterSecond);

  // 6. The workspace moves to the fork, though a file was changed by hand: it is kept as a snapshot.
  await w.editByHand("by-hand.txt", "typed in the editor");
  await d.rightClick(tipRow(fork));
  await d.click({ role: "menuitem", name: /^Switch workspace/ });
  await d.click({ role: "button", name: "Save snapshot and switch" });
  await d.expectVisible({ role: "img", name: "Checked out in your workspace" });
  await eventually("the branch in the folder", () => w.checkedOutBranch(), fork);
  await eventually("the file in the folder on the fork", () => w.fileInFolder(w.deliverable.path), w.deliverable.afterSecond);

  // 7. The fork is merged into the trunk (it carries the first thread's work too).
  await d.rightClick(tipRow(fork));
  await d.click({ role: "menuitem", name: /^Merge into / });
  await d.expectVisible({ role: "listitem", name: /^fork merged/ });

  // 8. The workspace goes back to the trunk, and the work is there.
  await d.rightClick({ role: "listitem", name: /, thread (main|master)$/ });
  await d.click({ role: "menuitem", name: /^Switch workspace/ });
  await d.expectVisible({ role: "img", name: "Checked out in your workspace" });
  await eventually("the trunk is checked out", async () => /^(main|master)$/.test(await w.checkedOutBranch()), true);
  const trunk = await w.checkedOutBranch();
  assertEqual("the trunk delivered", await w.fileOnBranch(trunk, w.deliverable.path), w.deliverable.afterSecond);
  await eventually("the folder delivered", () => w.fileInFolder(w.deliverable.path), w.deliverable.afterSecond);
  assertEqual("the hand-made file kept", await w.fileInFolder("by-hand.txt"), "typed in the editor");
  await d.screenshot("3-delivered");
}
