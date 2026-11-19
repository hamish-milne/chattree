import { release, type } from "node:os";
import type { HostEnvironment } from "../harness/environment.ts";
import type { AppEnv } from "./env.ts";

/**
 * What this machine is, for the `environment` note the model gets. The `platform` value tells the model which shell
 * dialect its `run` and `script` tools speak: Windows hosts get busybox utilities, everything else the machine's own.
 * The time zone is the machine's; settings may override it later.
 */
export function hostEnvironment(io: Pick<AppEnv, "host">): HostEnvironment {
  const platform = io.host.platform === "windows" ? "windows" : "posix";
  const name = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : type();
  const utilities =
    platform === "windows"
      ? "`run` takes one command or pipeline in a bash-like syntax, with busybox utilities (cat, ls, grep, sed, sort, wc and so on) and the programs on the PATH; `script` runs a POSIX sh script with busybox."
      : "`run` takes one command or pipeline in a bash-like syntax, using this machine's own utilities and programs; `script` runs a POSIX sh script.";
  return { os: `${name} ${release()}`, platform, utilities, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
