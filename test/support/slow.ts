/**
 * Suites that take many seconds because they are exhaustive (a fault injected at every step, random operations, whole live-check
 * runs). They are tagged `[slow]` in their names and skipped unless CHATTREE_SLOW is set:
 *   pnpm test        everything else (the quick group)
 *   pnpm test:slow   only the [slow] suites
 *   pnpm test:all    both
 * Run the slow group before a release and after changing the journal, forks, subagents or the history invariants.
 */
export const slowOptions = process.env["CHATTREE_SLOW"] === undefined ? { skip: "slow suite: run `pnpm test:slow`" } : {};
export const slow = (name: string): string => `[slow] ${name}`;
