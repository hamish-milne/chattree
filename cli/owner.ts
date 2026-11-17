import { hostname } from "node:os";
import type { LeaseOwner } from "../harness/lease.ts";
import { hasCode } from "../src/json.ts";

/** Who this process is, as it appears in run leases and request journals. */
export function localOwner(session?: string): LeaseOwner & { pid: number; host: string } {
  return { pid: process.pid, host: hostname(), ...(session === undefined ? {} : { session }) };
}

/**
 * True when the lease's owner was a process on this machine that no longer exists. A pid only means something on the host
 * that issued it, so other hosts are never reported dead. Only ESRCH counts as dead: EPERM means the process exists but
 * belongs to another user, so it is treated as alive.
 */
export function ownerIsDead(owner: LeaseOwner): boolean {
  if (owner.pid === undefined || owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (e) {
    return hasCode(e, "ESRCH");
  }
}
