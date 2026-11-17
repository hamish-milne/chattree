import type { Server } from "node:net";

/** The keys of an object, typed as what they are. `Object.keys` says `string[]` because an object may have more keys than its type names; for a table written in this code it has not. */
export function typedKeys<T extends object>(table: T): (keyof T & string)[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the point of this function: see above
  return Object.keys(table) as (keyof T & string)[];
}

/** The port a server listens on, once it does. */
export function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server is not listening on a port");
  return address.port;
}
