import { defaultRegistry, localModelsDefinition, type AdapterRegistry, type LocalModelsRuntime } from "../providers/index.ts";
import { catalog, resolveName } from "../localmodels/catalog.ts";
import { ensureDaemon, launchDetached } from "../localmodels/client.ts";
import { dataDir } from "../localmodels/plan.ts";
import { resolveSampling, type ResolvedSampling } from "../localmodels/sampling.ts";
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
        // A host that is not running (stopped, or gone because its code changed) is started: asking for a model is asking for it to be there.
        // Nothing is installed or downloaded without the user's yes, so a first start still has to be `chattree models start`.
        const client = await ensureDaemon({ data, launch: () => launchDetached(data, io.env) });
        let status = await client.status();
        if (status.state.phase === "idle" || status.state.phase === "stopped") status = await client.start({ yes: false });
        // A settings file that cannot be used is an error for every consumer, not something to find in `status`.
        if (status.settingsError !== undefined) throw new Error(`the local model host is not using the current settings: ${status.settingsError} (fix the settings file; \`chattree models status\` shows more)`);
        const st = status.state;
        if (st.phase === "ready" && st.baseUrl !== undefined) {
          if (st.error !== undefined) throw new Error(`the local model host could not apply the current settings: ${st.error}`);
          return { baseUrl: st.baseUrl, ids: st.ids };
        }
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

/** The sampling for one of the settings' models, looking through the model's own metadata when the settings have none (docs/local-models.md, section 5). Never throws. */
export async function lookupSampling(io: Pick<Io, "env" | "settings">, name: string, o: { fetch?: typeof fetch | undefined; hfBase?: string | undefined; localFile?: string | undefined } = {}): Promise<ResolvedSampling> {
  const config = io.settings?.local_models;
  const entry = config?.models[resolveName(config, name)];
  if (config === undefined || entry === undefined) return { values: {}, source: undefined, detail: undefined, notes: [`${name} is not in local_models`] };
  const tokenVar = config.hf_token_env;
  const token = tokenVar === undefined ? undefined : io.env[tokenVar];
  return resolveSampling(entry, { fetch: o.fetch, hfBase: o.hfBase, localFile: o.localFile, token: token === "" ? undefined : token, signal: AbortSignal.timeout(15_000) });
}
