import type { AdapterRegistry } from "../providers/registry.ts";
import { harnessConfig } from "./config.ts";
import { jsonOr } from "../src/json.ts";
import { jsonSchema } from "../src/validate.ts";

/** Where `create` and `open` write the generated schema (inside the ignored `.chattree/` directory). */
export const SCHEMA_PATH = ".chattree/harness.schema.json";
/** The comment that makes YAML-aware editors use it. */
export const SCHEMA_COMMENT = `# yaml-language-server: $schema=./${SCHEMA_PATH}`;

/**
 * The JSON Schema for `harness.yml`: the core keys, and each provider checked against the schema of the adapter its
 * `$tag` names. The YAML language server cannot learn the `!tag` sugar from a schema (that is its `yaml.customTags`
 * setting), so editors are pointed at the plain `$tag: name` form; both are accepted by the loader.
 */
export function configJsonSchema(registry: AdapterRegistry): object {
  const core = jsonSchema(harnessConfig.schema);
  const coreProperties = jsonOr(core["properties"]);
  const variants = registry.tags().map((tag) => {
    const def = registry.get(tag);
    return { title: tag, ...jsonOr(def?.jsonSchema().config) };
  });
  return {
    ...core,
    title: "chattree harness.yml",
    properties: {
      ...coreProperties,
      providers: {
        type: "object",
        description: "Providers by name; the name is what an agent's model setting refers to. `$tag` picks the adapter.",
        propertyNames: { pattern: "^[a-z][a-z0-9_-]*$" },
        additionalProperties: variants.length === 0 ? false : { oneOf: variants },
      },
    },
  };
}

/** The JSON Schema for one adapter's model settings (for editor tooling on `agent_setup`). */
export function settingsJsonSchema(registry: AdapterRegistry, tag: string): object | undefined {
  return registry.get(tag)?.jsonSchema().settings;
}
