// Runs inside the page (added with `addInitScript`): the measurements of the performance test. Plain JavaScript, because it
// needs the DOM and the test's type configuration has none.

/** Resolves with the time at which a task queued from the next animation frame runs: after that frame's style, layout and paint. */
const afterFrame = () =>
  new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve(performance.now());
    requestAnimationFrame(() => ch.port2.postMessage(0));
  });

const WARM_UP = 20;

const graphScroller = () => document.querySelector('[role="list"][aria-label="Threads"] [role="listitem"]')?.parentElement?.parentElement;
const transcript = () => document.querySelector('[role="log"]');

window.__perfKit = {
  /** At the tip, as a person is when they write: the transcript at its end, the graph at its newest. */
  async toTip() {
    const log = transcript();
    if (log) log.scrollTop = log.scrollHeight;
    const g = graphScroller();
    if (g) g.scrollTop = 0;
    await afterFrame();
    await afterFrame();
  },

  /**
   * The main-thread cost of each frame of a scroll: from the scroll event at the start of a frame to a task queued from that
   * frame's animation callback. `from` is where it starts: "end" scrolls up from the bottom, "start" down from the top.
   */
  async scrollCosts(target, steps, stepPx, from) {
    const el = target === "transcript" ? transcript() : graphScroller();
    if (!el) throw new Error(`no ${target} to scroll`);
    const dir = from === "end" ? -1 : 1;
    el.scrollTop = from === "end" ? el.scrollHeight : 0;
    await afterFrame();
    await afterFrame();
    // The first frames of a scroll run code for the first time and pay for it; a person scrolling a long conversation has
    // done so before, so a few frames at the start are not counted.
    const costs = [];
    for (let i = 0; i < steps + WARM_UP; i++) {
      let started;
      el.addEventListener("scroll", () => (started ??= performance.now()), { once: true, capture: true });
      el.scrollTop += dir * stepPx;
      const end = await afterFrame();
      if (started !== undefined && i >= WARM_UP) costs.push(end - started);
    }
    return costs;
  },

  /** Note when the Enter key goes down, and when an element with the marker text is painted in the transcript and in the graph. */
  watchAdds() {
    const perf = [];
    window.__perf = perf;
    document.addEventListener("keydown", (e) => e.key === "Enter" && perf.push({ t0: performance.now() }), true);
    new MutationObserver((records) => {
      const cur = perf.at(-1);
      const mark = window.__marker;
      if (!cur || !mark) return;
      for (const r of records)
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1 || !(node.textContent ?? "").includes(mark)) continue;
          const inChat = node.closest('[role="log"]') !== null || node.querySelector('[role="log"]') !== null;
          const inGraph = node.closest('[role="list"]') !== null || node.querySelector('[role="listitem"]') !== null;
          if (inChat && cur.chat === undefined) afterFrame().then((t) => (cur.chat = t - cur.t0));
          else if (inGraph && cur.graph === undefined) afterFrame().then((t) => (cur.graph = t - cur.t0));
        }
    }).observe(document.body, { childList: true, subtree: true });
  },
};
