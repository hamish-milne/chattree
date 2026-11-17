/**
 * Display helper for how long a tool call has been waiting for approval, shown in the run and engine notices. Rounds to
 * whole seconds, then minutes, hours and days, moving up a unit only once the smaller one reaches 90 (or 48 hours), so
 * a value never shows as a bare "60s" or "60m". Negative or future times are shown as zero.
 */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}
