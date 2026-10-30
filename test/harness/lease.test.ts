import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { nodeHost } from "../../hosts/node.ts";
import { LeaseStore, ThreadBusy, type LeaseEnv } from "../../harness/lease.ts";
import { tempDir } from "../support/tmp.ts";

const host = nodeHost();

/** Two stores over one directory stand for two processes; the clock is shared and moved by hand. */
async function setup() {
  const dir = await tempDir();
  const file = (b: string) => join(dir, `${encodeURIComponent(b)}.lease`);
  let t = 1_000_000;
  const clock = { advance: (ms: number) => void (t += ms) };
  const env = (isDead?: LeaseEnv["isDead"]): LeaseEnv => ({ now: () => t, ...(isDead === undefined ? {} : { isDead }) });
  return { a: new LeaseStore(host.fs, file), b: new LeaseStore(host.fs, file), env, clock, now: () => t, file };
}

const me = { pid: 1, host: "h", session: "one" };
const you = { pid: 2, host: "h", session: "two" };

describe("run leases", () => {
  test("a hold makes the thread live, naming the holder and what holds it; dropping the last hold frees it", async () => {
    const { a, env, now } = await setup();
    assert.deepEqual(await a.inspect("main", env()), { state: "free" });
    assert.equal(await a.hold("main", me, env(), "loop", now() + 5000), "free");
    const s = await a.inspect("main", env());
    assert.equal(s.state, "live");
    if (s.state === "live") assert.deepEqual([s.owner, s.holding, s.until], [me, ["loop"], now() + 5000]);
    await a.hold("main", me, env(), "job:j1", now() + 60_000);
    await a.drop("main", "loop");
    assert.equal((await a.inspect("main", env())).state, "live", "a job keeps the lease after the loop has gone");
    await a.drop("main", "job:j1");
    assert.deepEqual(await a.inspect("main", env()), { state: "free" });
  });

  test("the same process holding again is not an obstacle; another process is refused while the lease is live", async () => {
    const { a, b, env, now } = await setup();
    await a.hold("main", me, env(), "loop", now() + 5000);
    assert.equal(await a.hold("main", me, env(), "job:j1", now() + 5000), "ours");
    await assert.rejects(b.hold("main", you, env(), "loop", now() + 5000), (e: unknown) => e instanceof ThreadBusy && e.holder.owner.session === "one" && /session one/.test(e.message));
    assert.equal((await b.inspect("main", env())).state, "live");
    await a.drop("main", "loop");
    await a.drop("main", "job:j1");
    assert.equal(await b.hold("main", you, env(), "loop", now() + 5000), "free");
  });

  test("a lease past its deadline is stale and is taken over; the taker is told it found one", async () => {
    const { a, b, env, clock, now } = await setup();
    await a.hold("main", me, env(), "loop", now() + 5000);
    clock.advance(5001);
    const s = await b.inspect("main", env());
    assert.equal(s.state, "stale");
    assert.equal(await b.hold("main", you, env(), "loop", now() + 5000), "stale");
    const after = await b.inspect("main", env());
    assert.equal(after.state === "live" && after.owner.session, "two");
  });

  test("an owner known to be dead makes the lease stale at once, but never one of this store's own", async () => {
    const { a, b, env, now } = await setup();
    await a.hold("main", me, env(), "loop", now() + 600_000);
    const dead = (o: { session?: string | undefined }) => o.session === "one";
    assert.equal((await b.inspect("main", env(dead))).state, "stale");
    assert.equal((await a.inspect("main", env(dead))).state, "live");
    assert.equal(await b.hold("main", you, env(dead), "loop", now() + 5000), "stale");
  });

  test("a followed thread keeps this one live while it is, and a grace covers the time before it starts", async () => {
    const { a, b, env, clock, now } = await setup();
    await a.follow("parent", me, env(), "call:c1", "child", 30_000);
    assert.equal((await b.inspect("parent", env())).state, "live", "the grace");
    clock.advance(31_000);
    assert.equal((await b.inspect("parent", env())).state, "stale", "the child never took its lease");
    await a.hold("child", me, env(), "loop", now() + 60_000);
    const s = await b.inspect("parent", env());
    assert.equal(s.state, "live");
    if (s.state === "live") assert.deepEqual(s.holding, ["thread child"]);
    await a.drop("child", "loop");
    assert.equal((await b.inspect("parent", env())).state, "stale", "the child is done and the parent holds nothing else");
  });

  test("two threads that follow each other do not loop forever", async () => {
    const { a, env, clock } = await setup();
    await a.follow("x", me, env(), "k", "y", 1);
    await a.follow("y", me, env(), "k", "x", 1);
    clock.advance(10);
    assert.equal((await a.inspect("x", env())).state, "stale");
  });

  test("an unreadable lease file is stale, and releaseAll frees what this process holds", async () => {
    const { a, b, env, now, file } = await setup();
    await host.fs.writeAtomic(file("main"), new TextEncoder().encode("not json"));
    assert.equal((await b.inspect("main", env())).state, "stale");
    assert.equal(await b.hold("main", you, env(), "loop", now() + 1000), "stale");
    await a.hold("other", me, env(), "loop", now() + 1000);
    await a.releaseAll();
    assert.deepEqual(await a.inspect("other", env()), { state: "free" });
    assert.equal((await b.inspect("main", env())).state, "live", "another process's lease is not ours to release");
    assert.deepEqual(a.held(), []);
  });

  test("operations from one process on one thread do not interleave", async () => {
    const { a, b, env, now } = await setup();
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => a.hold("main", me, env(), `job:j${i}`, now() + 1000 + i)));
    const s = await b.inspect("main", env());
    assert.equal(s.state === "live" && s.holding.length, 6);
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => a.drop("main", `job:j${i}`)));
    assert.deepEqual(await b.inspect("main", env()), { state: "free" });
  });
});
