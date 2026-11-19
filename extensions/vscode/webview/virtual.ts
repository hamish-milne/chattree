/**
 * Windowing for long lists: only the items in (and near) view are drawn; the rest are the space they would take, so a
 * conversation of thousands of commits and blocks costs what a screenful does. Two kinds: `useFixedWindow` for rows of one
 * height (the thread graph), `useVariableWindow` for items whose height is known only once drawn (the transcript).
 */
import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";

/** The items drawn: from `first` up to, not including, `last`. */
export interface Span {
  first: number;
  last: number;
}

/** What a scroll container shows: how far it is scrolled and how tall it is. */
interface View {
  top: number;
  height: number;
}

/**
 * Follows a scroll container: calls `onView` when it scrolls or is resized, and rebinds when the element behind the ref changes
 * (a view that draws something else first, then the list).
 */
function useView(scroller: RefObject<HTMLElement | null>, onView: (v: View) => void): void {
  const bound = useRef<{ el: HTMLElement; stop: () => void } | undefined>(undefined);
  const latest = useRef(onView);
  latest.current = onView;
  useEffect(() => {
    const el = scroller.current;
    if (el === bound.current?.el) return;
    bound.current?.stop();
    bound.current = undefined;
    if (el === null) return;
    const read = (): void => latest.current({ top: el.scrollTop, height: el.clientHeight });
    el.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    bound.current = {
      el,
      stop: () => {
        el.removeEventListener("scroll", read);
        ro.disconnect();
      },
    };
    read();
  });
  useEffect(() => () => bound.current?.stop(), []);
}

/** Whether what is in view has come within `margin` items of the edge of what is drawn (and there is more to draw beyond it). */
const nearEdge = (span: Span, first: number, last: number, count: number, margin: number): boolean =>
  (span.first > 0 && first < span.first + margin) || (span.last < count && last > span.last - margin);

/** Rows of one height: the span to draw, with `overscan` rows beyond the view each way. Draw the rows at `index * rowHeight`. */
export function useFixedWindow(scroller: RefObject<HTMLElement | null>, count: number, rowHeight: number, overscan: number): Span {
  const [view, setView] = useState<View>({ top: 0, height: 600 });
  const span = useRef<Span>({ first: 0, last: 0 });
  useView(scroller, (v) => {
    const first = Math.floor(v.top / rowHeight);
    const last = Math.ceil((v.top + v.height) / rowHeight);
    if (v.height !== view.height || nearEdge(span.current, first, last, count, Math.max(2, overscan >> 2))) setView(v);
  });
  const first = Math.max(0, Math.floor(view.top / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + overscan);
  span.current = { first, last: Math.max(first, last) };
  return span.current;
}

export interface VariableWindow {
  /** The span to draw, and the space above and below it. */
  span: Span;
  before: number;
  after: number;
  /** Where item `index` starts, as far as is known (an item not yet drawn counts as the average of those that were). */
  offsetOf(index: number): number;
  /** The ref for the element of the item with this key: its height is measured and kept. */
  measure(key: string): (el: HTMLElement | null) => void;
}

/**
 * Items of any height. Heights are measured as items are drawn and kept by key; the others count as the average. When a
 * drawn item above the view changes height the scroll position moves by as much, so what is read does not jump. The
 * scroll container needs `overflow-anchor: none`, as this does the anchoring. With `pinned` the window is the end of the
 * list, wherever the scroll position was (the view that follows the end sets the position after each render).
 */
export function useVariableWindow(
  scroller: RefObject<HTMLElement | null>,
  keys: readonly string[],
  opts: { overscanPx: number; pinned: boolean; estimate: number },
): VariableWindow {
  const heights = useRef(new Map<string, number>());
  const [view, setView] = useState<View>({ top: 0, height: 800 });
  const [, bump] = useState(0);
  const sizes = heights.current;
  let sum = 0;
  for (const h of sizes.values()) sum += h;
  const average = sizes.size === 0 ? opts.estimate : sum / sizes.size;
  const offs = new Float64Array(keys.length + 1);
  for (const [i, k] of keys.entries()) offs[i + 1] = (offs[i] ?? 0) + (sizes.get(k) ?? average);
  const total = offs[keys.length] ?? 0;

  const top = opts.pinned ? Math.max(0, total - view.height) : view.top;
  const spanOf = (t: number, h: number): Span => {
    // First item that ends below the top edge, last that starts above the bottom edge.
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((offs[mid + 1] ?? 0) > t - opts.overscanPx) hi = mid;
      else lo = mid + 1;
    }
    const first = lo;
    lo = first;
    hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((offs[mid] ?? 0) >= t + h + opts.overscanPx) hi = mid;
      else lo = mid + 1;
    }
    return { first, last: lo };
  };
  const span = spanOf(top, view.height);
  // Where each key is, for the observer: made again only when the keys change.
  const index = useMemo(() => new Map(keys.map((k, i) => [k, i])), [keys]);
  const now = useRef({ span, offs, keys, index, pinned: opts.pinned });
  now.current = { span, offs, keys, index, pinned: opts.pinned };

  useView(scroller, (v) => {
    const cur = now.current;
    const vis = spanOf2(cur.offs, cur.keys.length, v.top, v.height);
    if (v.height !== view.height || nearEdge(cur.span, vis.first, vis.last, cur.keys.length, 3)) setView(v);
  });

  // Heights: one observer for every drawn item.
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const pending = useRef(false);
  useLayoutEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const sc = scroller.current;
      let moved = false;
      for (const entry of entries) {
        const el = entry.target;
        if (!(el instanceof HTMLElement)) continue;
        const key = el.dataset["key"];
        if (key === undefined) continue;
        const h = el.offsetHeight;
        const cur = now.current;
        const at = cur.index.get(key) ?? -1;
        // What the item took until now: its measured height, or the guess it was laid out with.
        const old = heights.current.get(key) ?? (at < 0 ? undefined : (cur.offs[at + 1] ?? 0) - (cur.offs[at] ?? 0));
        if (old === undefined || old === h) {
          if (old === h) heights.current.set(key, h);
          continue;
        }
        // An item wholly above the top edge pushes what is in view down or up by its change: take the scroll with it. (A view
        // that follows the end sets the position itself after each render.)
        if (sc !== null && !cur.pinned && (cur.offs[at] ?? 0) + old <= sc.scrollTop) sc.scrollTop += h - old;
        heights.current.set(key, h);
        moved = true;
      }
      if (moved && !pending.current) {
        pending.current = true;
        requestAnimationFrame(() => {
          pending.current = false;
          bump((n) => n + 1);
        });
      }
    });
    observer.current = ro;
    return () => ro.disconnect();
  }, [scroller]);

  const measures = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const measure = (key: string): ((el: HTMLElement | null) => void) => {
    let f = measures.current.get(key);
    if (f === undefined) {
      let last: HTMLElement | null = null;
      f = (el) => {
        if (last !== null && last !== el) observer.current?.unobserve(last);
        last = el;
        if (el === null) return;
        el.dataset["key"] = key;
        observer.current?.observe(el);
      };
      measures.current.set(key, f);
    }
    return f;
  };
  // Forget the heights and refs of items that are gone, so a long session does not hold them for ever.
  useEffect(() => {
    if (sizes.size <= keys.length * 2 + 64) return;
    const alive = new Set(keys);
    for (const k of [...sizes.keys()]) if (!alive.has(k)) sizes.delete(k);
    for (const k of [...measures.current.keys()]) if (!alive.has(k)) measures.current.delete(k);
  });

  return {
    span,
    before: offs[span.first] ?? 0,
    after: total - (offs[span.last] ?? total),
    offsetOf: (i) => offs[Math.max(0, Math.min(keys.length, i))] ?? 0,
    measure,
  };
}

/** The items in view at this scroll position, given where each starts (for deciding whether to draw more). */
function spanOf2(offs: Float64Array, count: number, top: number, height: number): Span {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offs[mid + 1] ?? 0) > top) hi = mid;
    else lo = mid + 1;
  }
  const first = lo;
  hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offs[mid] ?? 0) >= top + height) hi = mid;
    else lo = mid + 1;
  }
  return { first, last: lo };
}
