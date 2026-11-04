import type { McpClient } from "./client.ts";
import type { ConnectedServer } from "./servers.ts";

/**
 * The MCP connections of one process, shared by the threads that would make the same one (`connectionKey`): a server over HTTP, a program
 * that every thread runs in the same directory (`scope: project`), and the same thread asking again. A connection lives while someone holds a
 * lease on it and is closed when the last lease is released, so a subagent's servers go when it is done and nothing is left running at exit.
 */

export interface ConnectionMaker {
  /** Start the connection and read its tools. */
  open(): Promise<ConnectedServer>;
  /** Read the tools of a connection that is already up (a refresh). */
  list(client: McpClient): Promise<ConnectedServer>;
}

/** One holder's use of a pooled connection. */
export interface PoolLease {
  readonly server: ConnectedServer;
  /** The server said its tools changed, or another holder has read them again since this one did. */
  stale(): boolean;
  /** Let go; the connection closes when no one holds it. Calling it again does nothing. */
  release(): Promise<void>;
}

interface Entry {
  ready: Promise<ConnectedServer>;
  refs: number;
}

export class McpPool {
  readonly #entries = new Map<string, Entry>();

  /** How many connections are open or opening. */
  get size(): number {
    return this.#entries.size;
  }

  /** Hold the connection for `key`, starting it if no one has. With `fresh` the tools are read again (and every other holder sees itself as stale). */
  async acquire(key: string, make: ConnectionMaker, opts: { fresh?: boolean } = {}): Promise<PoolLease> {
    let entry = this.#entries.get(key);
    if (entry !== undefined) {
      try {
        const current = await entry.ready;
        if (current.client.closedBecause !== undefined) {
          // The server went away: the next holder starts it again; those who hold the dead one find out when they call.
          this.#entries.delete(key);
          entry = undefined;
        } else if (opts.fresh === true) {
          entry.ready = make.list(current.client);
          await entry.ready;
        }
      } catch {
        if (entry !== undefined && this.#entries.get(key) === entry) this.#entries.delete(key);
        entry = undefined;
      }
    }
    if (entry === undefined) {
      const made: Entry = { ready: make.open(), refs: 0 };
      entry = made;
      this.#entries.set(key, made);
      made.ready.catch(() => {
        if (this.#entries.get(key) === made) this.#entries.delete(key);
      });
    }
    const held = entry;
    held.refs++;
    let server: ConnectedServer;
    try {
      server = await held.ready;
    } catch (e) {
      held.refs--;
      throw e;
    }
    const mine: ConnectedServer = { ...server, status: { ...server.status } };
    const listings = server.client.listings;
    let released = false;
    return {
      server: mine,
      stale: () => server.client.stale || server.client.listings !== listings,
      release: async () => {
        if (released) return;
        released = true;
        held.refs--;
        if (held.refs > 0) return;
        if (this.#entries.get(key) === held) this.#entries.delete(key);
        await server.client.close();
      },
    };
  }

  /** Close every connection, whoever holds it (the process is leaving). */
  async closeAll(): Promise<void> {
    const all = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(all.map((e) => e.ready.then((s) => s.client.close(), () => undefined)));
  }
}
