import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Git } from "../../src/git/git.ts";
import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";
import { LeaseStore, ThreadBusy, type LeaseEnv } from "../../harness/lease.ts";
import { leaseRef, refLeaseBackend } from "../../harness/lease-ref.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();
const me = { pid: 1, host: "a", session: "one" };
const you = { pid: 2, host: "b", session: "two" };

/** Three clones that share nothing but a bare remote; the clock is shared and moved by hand. */
async function setup() {
  const root = await tempDir();
  const remote = join(root, "remote.git");
  const init = await host.exec("git", ["init", "--bare", "--quiet", remote], { cwd: root });
  assert.equal(init.exitCode, 0);
  let t = 1_000_000;
  const clock = { advance: (ms: number) => void (t += ms) };
  const store = async (name: string): Promise<LeaseStore> => {
    const git = await Git.init(host, join(root, name), {});
    return new LeaseStore(refLeaseBackend(git, { remote, cacheMs: 0, now: () => t }));
  };
  const env: LeaseEnv = { now: () => t };
  return { a: await store("a"), b: await store("b"), c: await store("c"), env, clock, now: () => t, remote };
}

describe("run leases kept as refs on a shared remote", () => {
  test("a lease taken in one clone is live in another, which is refused while it is; letting go frees it", async () => {
    const { a, b, env, now } = await setup();
    assert.deepEqual(await b.inspect("main", env), { state: "free" });
    assert.equal(await a.hold("main", me, env, "loop", now() + 5000), "free");
    const s = await b.inspect("main", env);
    assert.equal(s.state, "live");
    if (s.state === "live") assert.deepEqual([s.owner, s.holding], [me, ["loop"]]);
    await assert.rejects(b.hold("main", you, env, "loop", now() + 5000), (e: unknown) => e instanceof ThreadBusy && e.holder.owner.session === "one");
    assert.equal(await a.hold("main", me, env, "job:j1", now() + 60_000), "ours", "renewing is a compare-and-swap on what it wrote");
    await a.drop("main", "loop");
    assert.equal((await b.inspect("main", env)).state, "live", "a job keeps it");
    await a.drop("main", "job:j1");
    assert.deepEqual(await b.inspect("main", env), { state: "free" });
    assert.equal(await b.hold("main", you, env, "loop", now() + 5000), "free");
  });

  test("a lease past its deadline is taken over, and of several clones that try at once exactly one wins", async () => {
    const { a, b, c, env, clock, now } = await setup();
    await a.hold("main", me, env, "loop", now() + 5000);
    clock.advance(5001);
    assert.equal((await b.inspect("main", env)).state, "stale");
    const results = await Promise.allSettled([b.hold("main", you, env, "loop", now() + 5000), c.hold("main", { pid: 3, host: "c", session: "three" }, env, "loop", now() + 5000)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "one took it");
    const lost = results.find((r) => r.status === "rejected");
    assert.ok(lost?.status === "rejected" && lost.reason instanceof ThreadBusy);
    const winner = results.find((r) => r.status === "fulfilled");
    // Of two clones taking a stale lease over, the one whose create lands after the other has removed it (and before the other's create) finds
  // nothing there and is told "free": the answer is informational (what the thread's state is comes from reading the lease), so either is right.
    assert.ok(winner?.status === "fulfilled" && (winner.value === "stale" || winner.value === "free"), "the winner is told what it found");
  });

  test("the old holder finds its lease gone and does not overwrite the new one", async () => {
    const { a, b, env, clock, now } = await setup();
    await a.hold("main", me, env, "loop", now() + 5000);
    clock.advance(6000);
    await b.hold("main", you, env, "loop", now() + 5000);
    // a still thinks it holds the lease; renewing must fail the compare-and-swap and then find the thread busy
    await assert.rejects(a.hold("main", me, env, "loop", now() + 5000), ThreadBusy);
    const s = await a.inspect("main", env);
    assert.equal(s.state === "live" && s.owner.session, "two");
  });

  test("thread names with slashes, dots and wildcards make valid ref names", async () => {
    const { a, b, env, now } = await setup();
    for (const name of ["sub/w-abc123", "fork/1", "a.lock", "x..y", "star*", "é"]) {
      assert.match(leaseRef(name), /^refs\/chattree\/leases\/[A-Za-z0-9%_-]+$/);
      assert.equal(await a.hold(name, me, env, "loop", now() + 5000), "free", name);
      assert.equal((await b.inspect(name, env)).state, "live", name);
    }
  });

  test("a followed thread keeps this one live across clones", async () => {
    const { a, b, c, env, clock, now } = await setup();
    await a.follow("parent", me, env, "call:c1", "child", 1000);
    await b.hold("child", you, env, "loop", now() + 60_000);
    clock.advance(2000);
    const s = await c.inspect("parent", env);
    assert.equal(s.state, "live");
    if (s.state === "live") assert.deepEqual(s.holding, ["thread child"]);
  });
});

describe("leases.remote in harness.yml", () => {
  test("a conversation then keeps its run lease as a ref on that remote, and a second handle sees it", async () => {
    const root = await tempDir();
    const remote = join(root, "remote.git");
    assert.equal((await host.exec("git", ["init", "--bare", "--quiet", remote], { cwd: root })).exitCode, 0);
    const a = await Conversation.create(host, join(root, "a"), { config: `leases:\n  remote: ${JSON.stringify(remote)}\n` });
    const store = await a.leaseStore();
    await store.hold(a.branch, { pid: 1, host: "h" }, a.leaseEnv, "loop", a.now() + 30_000);
    const refs = new TextDecoder().decode((await host.exec("git", ["ls-remote", remote], { cwd: root })).stdout);
    assert.ok(refs.includes(leaseRef(a.branch)), refs);
    assert.equal((await a.leaseState()).state, "live");
    await store.releaseAll();
    assert.deepEqual(await a.leaseState(), { state: "free" });
    assert.equal(new TextDecoder().decode((await host.exec("git", ["ls-remote", remote], { cwd: root })).stdout).includes("leases"), false, "released: the ref is gone");
  });
});
