import { hostname } from "node:os";
import type { LeaseOwner } from "../harness/lease.ts";

/** Who this process is, as it appears in run leases and request journals. */
export function localOwner(session?: string): LeaseOwner & { pid: number; host: string } {
  return { pid: process.pid, host: hostname(), ...(session === undefined ? {} : { session }) };
}

/** True when the lease's owner was a process on this machine that no longer exists (anything else is not known to be dead). */
export function ownerIsDead(owner: LeaseOwner): boolean {
  if (owner.pid === undefined || owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}
