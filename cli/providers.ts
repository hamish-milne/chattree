import { defaultRegistry, localModelsDefinition, type AdapterRegistry, type LocalModelsRuntime } from "../providers/index.ts";
import { catalog, resolveName } from "../localmodels/catalog.ts";
import { findDaemon } from "../localmodels/client.ts";
import { dataDir } from "../localmodels/plan.ts";
import type { Io } from "./io.ts";

/** The local models as a provider sees them (docs/local-models.md, section 6): the catalog from the settings, the address from the running host. */
export function localRuntime(io: Pick<Io, "host" | "env" | "settings">): LocalModelsRuntime {
  const config = io.settings?.local_models;
  return {
    catalog: () => (config === undefined ? {} : catalog(config)),
    resolve: (id) => (config === undefined ? id : resolveName(config, id)),
    async connect(signal) {
      if (config === undefined) throw new Error("the settings file has no local_models section, so there are no local models (`chattree settings edit`)");
      const data = dataDir(io.host, io.env, io.settings?.data_dir);
      if (data === undefined) throw new Error("there is no data directory on this machine (set data_dir in the settings file)");
      const deadline = Date.now() + 60_000;
      for (;;) {
        const client = await findDaemon(data);
        if (client === undefined) throw new Error("the local model host is not running: start it with `chattree models start`");
        const st = (await client.status()).state;
        if (st.phase === "ready" && st.baseUrl !== undefined) return { baseUrl: st.baseUrl, ids: st.ids };
        // A host that is restarting is given a moment; anything else is for the user to look at.
        if (!["restarting", "starting"].includes(st.phase) || Date.now() > deadline || signal?.aborted === true) {
          throw new Error(`the local model host is ${st.phase}${st.error === undefined ? "" : `: ${st.error}`}; \`chattree models status\` shows more, \`chattree models start\` starts it`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    },
  };
}

/** The adapters that ship with chattree, and `local-models`, which needs this machine's settings and host. */
export function cliRegistry(io: Pick<Io, "host" | "env" | "settings">): AdapterRegistry {
  return defaultRegistry().register(localModelsDefinition(localRuntime(io)));
}
