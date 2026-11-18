import type { Host } from "../src/host.ts";
import type { Settings } from "./settings.ts";

/**
 * What an application service needs of the machine and the person: the host (files, processes), the environment
 * variables, the working directory, the clock and the user-level settings. A terminal's `Io` has all of these (and more);
 * so has the extension host's own environment.
 */
export interface AppEnv {
  host: Host;
  env: Record<string, string | undefined>;
  cwd: string;
  now(this: void): number;
  /** The user-level settings file, read once at startup; absent means none. */
  settings?: Settings;
}
