/**
 * The pages of the settings sheet. What a person is likely to change (the providers, the main limits, the choices)
 * is up front as buttons and labelled inputs; the granular settings (approvals, MCP servers, subagent models) are dense
 * tables, one row each, that stay readable at a hundred entries.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
  ADAPTERS,
  FOREVER,
  adapterOf,
  addGrant,
  changeAdapter,
  grantOwners,
  grants,
  inDays,
  mcpTransport,
  newProvider,
  newProviderName,
  removeGrant,
  renameGrant,
  setGrantUntil,
  type Grant,
} from "chattree/ui/model/config-sheet";
import { Icon } from "../icons.tsx";
import { Choice, Issues, Lines, NumberInput, Row, Section, Switch, TextInput, at, type Form } from "./controls.tsx";

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const objectOf = (x: unknown): Json => (isObject(x) ? x : {});
const keysOf = (x: unknown): string[] => Object.keys(objectOf(x));
const valueOf = (form: Form): Json => form.spec.value.value;

// ---- providers -----------------------------------------------------------------------------------------------------

function ProviderCard({ form, name }: { form: Form; name: string }): JSX.Element {
  const p = objectOf(at(valueOf(form), ["providers", name]));
  const a = adapterOf(p["$tag"]);
  const base = ["providers", name];
  const [more, setMore] = useState(false);
  const bad = [...form.issues.value.keys()].some((k) => k === base.join(".") || k.startsWith(`${base.join(".")}.`));
  return (
    <div class={`pv-card${bad ? " bad" : ""}`}>
      <div class="pv-head">
        <input
          class="pv-name mono"
          aria-label="Provider name"
          value={name}
          onChange={(e) => {
            const to = e.currentTarget.value.trim();
            if (to === "" || to === name || to in objectOf(valueOf(form)["providers"])) return;
            // Keep the provider's place among the others.
            form.set(
              ["providers"],
              Object.fromEntries(Object.entries(objectOf(valueOf(form)["providers"])).map(([k, v]) => [k === name ? to : k, v])),
            );
          }}
        />
        <span class="spacer" />
        <button class="icon-button" title={`Remove ${name}`} aria-label={`Remove ${name}`} onClick={() => form.remove(base)}>
          <Icon name="trash" />
        </button>
      </div>
      <div class="pv-adapters" role="radiogroup" aria-label="Adapter">
        {ADAPTERS.map((x) => (
          <button
            key={x.tag}
            role="radio"
            aria-checked={x.tag === a.tag}
            class={`cf-option${x.tag === a.tag ? " on" : ""}`}
            title={x.hint}
            onClick={() => x.tag !== a.tag && form.set(base, changeAdapter(p, x.tag))}
          >
            <span class="cf-option-label">{x.label}</span>
          </button>
        ))}
      </div>
      <div class="cf-hint">{a.hint}</div>
      <Issues form={form} path={[...base, "$tag"]} />
      <div class="pv-fields">
        {(a.key || "api_key_env" in p) && (
          <Row
            form={form}
            path={[...base, "api_key_env"]}
            label="Key from"
            help="The name of an environment variable. The key itself never goes in this file."
          >
            <TextInput form={form} path={[...base, "api_key_env"]} placeholder="ANTHROPIC_API_KEY" mono />
          </Row>
        )}
        {(a.address || "base_url" in p) && (
          <Row form={form} path={[...base, "base_url"]} label="Address">
            <TextInput form={form} path={[...base, "base_url"]} placeholder="https://…" mono />
          </Row>
        )}
      </div>
      <button class="link" aria-expanded={more} onClick={() => setMore(!more)}>
        {more ? "Fewer settings" : "More settings"}
      </button>
      {more && (
        <div class="pv-fields">
          <Row
            form={form}
            path={[...base, "max_concurrent"]}
            label="Parallel requests"
            help="Most requests in flight at once to this provider."
          >
            <NumberInput form={form} path={[...base, "max_concurrent"]} integer placeholder="no limit" wide />
          </Row>
          <Row
            form={form}
            path={[...base, "max_attempts"]}
            label="Attempts"
            help="Tries per request, counting the first, when a request fails in a way that can be retried."
          >
            <NumberInput form={form} path={[...base, "max_attempts"]} integer placeholder="default" wide />
          </Row>
        </div>
      )}
    </div>
  );
}

export function ProvidersPage({ form }: { form: Form }): JSX.Element {
  const names = keysOf(valueOf(form)["providers"]);
  const add = (tag: string): void => {
    const name = newProviderName(tag, names);
    form.set(["providers", name], newProvider(tag));
  };
  return (
    <>
      <Section title="Providers" hint="Each provider is a place models come from. An agent's model setting names one of these.">
        <div class="pv-list">
          {names.map((n) => (
            <ProviderCard key={n} form={form} name={n} />
          ))}
          {names.length === 0 && <p class="cf-empty">No providers yet. Add one below.</p>}
        </div>
        <Issues form={form} path={["providers"]} />
        <div class="pv-add">
          <span class="cf-label">Add a provider</span>
          <div class="pv-adapters">
            {ADAPTERS.map((a) => (
              <button key={a.tag} class="cf-option add" title={a.hint} onClick={() => add(a.tag)}>
                <Icon name="plus" size={12} />
                <span class="cf-option-label">{a.label}</span>
              </button>
            ))}
          </div>
        </div>
      </Section>
    </>
  );
}

// ---- limits --------------------------------------------------------------------------------------------------------

export function LimitsPage({ form }: { form: Form }): JSX.Element {
  const L = (k: string): string[] => ["limits", k];
  return (
    <>
      <Section title="Spending" hint="Checked before a request is sent. Leave a box empty for no limit.">
        <Row form={form} path={L("max_request_usd")} label="Per request">
          <NumberInput form={form} path={L("max_request_usd")} prefix="$" placeholder="no limit" />
        </Row>
        <Row form={form} path={L("max_turn_usd")} label="Per turn" help="A turn is everything the agent does for one message.">
          <NumberInput form={form} path={L("max_turn_usd")} prefix="$" placeholder="no limit" />
        </Row>
        <Row form={form} path={L("max_conversation_usd")} label="Per conversation">
          <NumberInput form={form} path={L("max_conversation_usd")} prefix="$" placeholder="no limit" />
        </Row>
        <Row form={form} path={L("warn_at")} label="Warn at" help="Show a warning when a limit is this far used.">
          <NumberInput form={form} path={L("warn_at")} scale={100} suffix="%" placeholder="off" />
        </Row>
        <Row
          form={form}
          path={L("unknown_price")}
          label="Unpriced models"
          help="What to do when a model has no price, so its cost cannot be counted."
        >
          <Choice
            form={form}
            path={L("unknown_price")}
            fallback="warn"
            options={[
              {
                value: "warn",
                label: "Warn",
                hint: "Carry on, and say the cost is unknown",
              },
              {
                value: "block",
                label: "Block",
                hint: "Refuse until a price is set",
              },
            ]}
          />
        </Row>
      </Section>
      <Section title="Time and size">
        <Row form={form} path={L("max_requests_per_turn")} label="Requests per turn">
          <NumberInput form={form} path={L("max_requests_per_turn")} integer placeholder="no limit" />
        </Row>
        <Row form={form} path={L("max_turn_seconds")} label="Per turn">
          <NumberInput form={form} path={L("max_turn_seconds")} suffix="seconds" placeholder="no limit" />
        </Row>
        <Row form={form} path={L("max_tool_seconds")} label="Per tool call">
          <NumberInput form={form} path={L("max_tool_seconds")} suffix="seconds" placeholder="no limit" />
        </Row>
        <Row form={form} path={L("max_request_seconds")} label="Per model request">
          <NumberInput form={form} path={L("max_request_seconds")} suffix="seconds" placeholder="no limit" />
        </Row>
        <Row form={form} path={["attachments", "max_bytes"]} label="Attachment size" help="Largest file a message can carry.">
          <NumberInput form={form} path={["attachments", "max_bytes"]} integer scale={1 / 1048576} suffix="MB" />
        </Row>
      </Section>
    </>
  );
}

// ---- approvals -----------------------------------------------------------------------------------------------------

const STATE_TEXT = {
  forever: "",
  active: "",
  soon: "Ends soon",
  expired: "Expired",
  invalid: "Not a date",
} as const;

function GrantRow({ form, g }: { form: Form; g: Grant }): JSX.Element {
  const path = g.scope === "tool" ? ["tools", g.owner, "allow", g.key] : ["mcp", g.owner, "allow", g.key];
  const forever = g.state === "forever";
  return (
    <tr class={`gr-${g.state}`}>
      <td class="mono">{g.scope === "mcp" ? <span title="MCP server">{g.owner}</span> : g.owner}</td>
      <td>
        <input
          class="cf-text mono bare"
          aria-label={`What ${g.owner} may do`}
          title={g.key}
          value={g.key}
          onChange={(e) => {
            const k = e.currentTarget.value.trim();
            if (k !== "" && k !== g.key) form.replace(renameGrant(valueOf(form), g, k));
          }}
        />
      </td>
      <td>
        <div class="gr-date">
          {STATE_TEXT[g.state] !== "" && <span class={`gr-state ${g.state}`}>{STATE_TEXT[g.state]}</span>}
          {!forever && (
            <input
              type="date"
              class="cf-text bare"
              aria-label={`Allowed until, for ${g.key}`}
              value={g.until.slice(0, 10)}
              onChange={(e) => e.currentTarget.value !== "" && form.replace(setGrantUntil(valueOf(form), g, e.currentTarget.value))}
            />
          )}
          <button
            class={`cf-chip${forever ? " on" : ""}`}
            aria-pressed={forever}
            title={forever ? "Give it an end date" : "Never expires"}
            onClick={() => form.replace(setGrantUntil(valueOf(form), g, forever ? inDays(new Date(), 30) : FOREVER))}
          >
            Always
          </button>
        </div>
      </td>
      <td class="gr-end">
        <button
          class="icon-button"
          title="Remove this approval"
          aria-label={`Remove ${g.key}`}
          onClick={() => form.replace(removeGrant(valueOf(form), g))}
        >
          <Icon name="x" size={12} />
        </button>
        <Issues form={form} path={path} />
      </td>
    </tr>
  );
}

export function ApprovalsPage({ form, tools, now }: { form: Form; tools: readonly string[]; now: Date }): JSX.Element {
  const rows = grants(valueOf(form), now);
  const owners = grantOwners(valueOf(form), tools);
  const [scope, setScope] = useState<"tool" | "mcp">("tool");
  const choices = scope === "tool" ? owners.tool : owners.mcp;
  const [owner, setOwner] = useState("");
  const [key, setKey] = useState("");
  const [days, setDays] = useState("always");
  const chosen = choices.includes(owner) ? owner : (choices[0] ?? "");
  const add = (): void => {
    if (chosen === "" || key.trim() === "") return;
    form.replace(addGrant(valueOf(form), scope, chosen, key.trim(), days === "always" ? FOREVER : inDays(now, Number(days))));
    setKey("");
  };
  const expired = rows.filter((r) => r.state === "expired").length;
  const clean = (): void => {
    let v = valueOf(form);
    for (const r of rows) if (r.state === "expired") v = removeGrant(v, r);
    form.replace(v);
  };
  return (
    <>
      <Section title="Approvals" hint="Calls that match a row run without asking. Everything else asks first. A row can end on a date.">
        <div class="tb-wrap">
          <table class="tb">
            <thead>
              <tr>
                <th>Tool or server</th>
                <th class="wide">Allowed</th>
                <th>Ends</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <GrantRow key={`${g.scope}/${g.owner}/${g.key}`} form={form} g={g} />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} class="cf-empty">
                    Nothing is pre-approved.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr class="tb-add">
                <td>
                  <div class="tb-pair">
                    <select aria-label="Kind" value={scope} onChange={(e) => setScope(e.currentTarget.value === "mcp" ? "mcp" : "tool")}>
                      <option value="tool">tool</option>
                      <option value="mcp">MCP</option>
                    </select>
                    <select aria-label="Tool or server" value={chosen} onChange={(e) => setOwner(e.currentTarget.value)}>
                      {choices.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                </td>
                <td>
                  <input
                    class="cf-text mono"
                    aria-label="What to allow"
                    placeholder="git status, src/**, search_*"
                    value={key}
                    onInput={(e) => setKey(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                  />
                </td>
                <td>
                  <select aria-label="For how long" value={days} onChange={(e) => setDays(e.currentTarget.value)}>
                    <option value="always">Always</option>
                    <option value="1">1 day</option>
                    <option value="7">1 week</option>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                  </select>
                </td>
                <td class="gr-end">
                  <button class="secondary" disabled={chosen === "" || key.trim() === ""} onClick={add}>
                    Add
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {expired > 0 && (
          <button class="link" onClick={clean}>
            Remove {expired} expired {expired === 1 ? "row" : "rows"}
          </button>
        )}
      </Section>
      <Section title="Environment" hint="Variables from your environment that tools can see. Anything else is hidden from them.">
        <Row form={form} path={["tools", "env"]} label="Passed to tools">
          <Lines form={form} path={["tools", "env"]} placeholder="PATH" />
        </Row>
      </Section>
    </>
  );
}

// ---- MCP servers ---------------------------------------------------------------------------------------------------

function McpRow({ form, name }: { form: Form; name: string }): JSX.Element {
  const e = objectOf(at(valueOf(form), ["mcp", name]));
  const t = mcpTransport(e);
  const [open, setOpen] = useState(false);
  const base = ["mcp", name];
  const bad = [...form.issues.value.keys()].some((k) => k.startsWith(base.join(".")));
  return (
    <>
      <tr class={bad ? "bad" : ""}>
        <td>
          <button class="disclosure" aria-expanded={open} aria-label={`Details of ${name}`} onClick={() => setOpen(!open)}>
            <Icon name="chevron" size={12} />
          </button>
          <span class="mono">{name}</span>
        </td>
        <td>
          <span class={`cf-chip static ${t.kind}`}>{t.kind === "command" ? "program" : t.kind === "url" ? "remote" : "unset"}</span>
        </td>
        <td class="mono ellipsis" title={t.text}>
          {t.text}
        </td>
        <td>
          <select
            aria-label={`Scope of ${name}`}
            value={typeof e["scope"] === "string" ? e["scope"] : "thread"}
            onChange={(ev) => form.set([...base, "scope"], ev.currentTarget.value)}
          >
            <option value="thread">thread</option>
            <option value="project">project</option>
          </select>
        </td>
        <td class="gr-end">
          <button class="icon-button" title={`Remove ${name}`} aria-label={`Remove ${name}`} onClick={() => form.remove(base)}>
            <Icon name="trash" size={12} />
          </button>
        </td>
      </tr>
      {open && (
        <tr class="tb-detail">
          <td colSpan={5}>
            <div class="pv-fields">
              {typeof e["url"] === "string" || t.kind === "none" ? (
                <>
                  <Row form={form} path={[...base, "url"]} label="Address">
                    <TextInput form={form} path={[...base, "url"]} placeholder="https://…" mono />
                  </Row>
                  <Row form={form} path={[...base, "bearer_env"]} label="Token from" help="The name of an environment variable.">
                    <TextInput form={form} path={[...base, "bearer_env"]} mono />
                  </Row>
                </>
              ) : (
                <>
                  <Row form={form} path={[...base, "command"]} label="Program">
                    <TextInput form={form} path={[...base, "command"]} mono />
                  </Row>
                  <Row form={form} path={[...base, "args"]} label="Arguments">
                    <Lines form={form} path={[...base, "args"]} />
                  </Row>
                  <Row form={form} path={[...base, "env_from"]} label="Environment" help="Variables passed on to the program.">
                    <Lines form={form} path={[...base, "env_from"]} placeholder="GITHUB_TOKEN" />
                  </Row>
                </>
              )}
              <Row form={form} path={[...base, "only"]} label="Only these tools" help="Leave empty to offer all of them.">
                <Lines form={form} path={[...base, "only"]} />
              </Row>
              <Row form={form} path={[...base, "skip"]} label="Never these tools">
                <Lines form={form} path={[...base, "skip"]} />
              </Row>
              <Issues form={form} path={base} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function McpPage({ form }: { form: Form }): JSX.Element {
  const names = keysOf(valueOf(form)["mcp"]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"command" | "url">("command");
  const [target, setTarget] = useState("");
  const add = (): void => {
    const n = name.trim();
    const x = target.trim();
    if (n === "" || x === "" || names.includes(n)) return;
    const [command, ...args] = x.split(/\s+/);
    form.set(["mcp", n], kind === "url" ? { url: x } : { command, ...(args.length > 0 ? { args } : {}) });
    setName("");
    setTarget("");
  };
  return (
    <Section
      title="MCP servers"
      hint="Programs or services that give the agent more tools. Their calls ask for approval unless a row on the Approvals page allows them."
    >
      <div class="tb-wrap">
        <table class="tb">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Runs</th>
              <th>Scope</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {names.map((n) => (
              <McpRow key={n} form={form} name={n} />
            ))}
            {names.length === 0 && (
              <tr>
                <td colSpan={5} class="cf-empty">
                  No servers.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr class="tb-add">
              <td>
                <input
                  class="cf-text mono"
                  aria-label="Server name"
                  placeholder="name"
                  value={name}
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              </td>
              <td>
                <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.currentTarget.value === "url" ? "url" : "command")}>
                  <option value="command">program</option>
                  <option value="url">remote</option>
                </select>
              </td>
              <td colSpan={2}>
                <input
                  class="cf-text mono"
                  aria-label={kind === "url" ? "Address" : "Command line"}
                  placeholder={kind === "url" ? "https://…" : "npx -y some-server"}
                  value={target}
                  onInput={(e) => setTarget(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && add()}
                />
              </td>
              <td class="gr-end">
                <button class="secondary" disabled={name.trim() === "" || target.trim() === ""} onClick={add}>
                  Add
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Issues form={form} path={["mcp"]} />
    </Section>
  );
}

// ---- subagents -----------------------------------------------------------------------------------------------------

export function SubagentsPage({ form }: { form: Form }): JSX.Element {
  const models = keysOf(at(valueOf(form), ["subagent", "models"]));
  const [name, setName] = useState("");
  const add = (): void => {
    const n = name.trim();
    if (n === "" || models.includes(n)) return;
    form.set(["subagent", "models", n], {});
    setName("");
  };
  return (
    <>
      <Section title="Delegated threads" hint="Work an agent hands to a thread of its own.">
        <Row form={form} path={["subagent", "merge"]} label="Results come back">
          <Choice
            form={form}
            path={["subagent", "merge"]}
            fallback="auto"
            options={[
              {
                value: "auto",
                label: "Automatically",
                hint: "A finished thread merges into its parent",
              },
              {
                value: "review",
                label: "After review",
                hint: "You merge it when you are happy",
              },
            ]}
          />
        </Row>
        <Row form={form} path={["subagent", "mcp"]} label="MCP tools">
          <Choice
            form={form}
            path={["subagent", "mcp"]}
            fallback="inherit"
            options={[
              {
                value: "inherit",
                label: "Same as parent",
                hint: "Every server the parent has",
              },
              {
                value: "none",
                label: "None",
                hint: "No MCP tools in subagents",
              },
            ]}
          />
        </Row>
      </Section>
      <Section title="Models a subagent may use" hint="The description is what the parent agent reads when it chooses.">
        <div class="tb-wrap">
          <table class="tb">
            <thead>
              <tr>
                <th>Model (provider/model)</th>
                <th>Description</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m}>
                  <td class="mono">{m}</td>
                  <td>
                    <TextInput form={form} path={["subagent", "models", m, "description"]} placeholder="What it is good for" />
                    <Issues form={form} path={["subagent", "models", m]} />
                  </td>
                  <td class="gr-end">
                    <button
                      class="icon-button"
                      aria-label={`Remove ${m}`}
                      title="Remove"
                      onClick={() => form.remove(["subagent", "models", m])}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr class="tb-add">
                <td>
                  <input
                    class="cf-text mono"
                    aria-label="Model"
                    placeholder="anthropic/claude-haiku-5-5"
                    value={name}
                    onInput={(e) => setName(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                  />
                </td>
                <td />
                <td class="gr-end">
                  <button class="secondary" disabled={name.trim() === ""} onClick={add}>
                    Add
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <Issues form={form} path={["subagent", "models"]} />
      </Section>
    </>
  );
}

// ---- context -------------------------------------------------------------------------------------------------------

export function ContextPage({ form }: { form: Form }): JSX.Element {
  const rules = keysOf(at(valueOf(form), ["injections", "rules"]));
  return (
    <>
      <Section title="Compaction" hint="Long conversations are shortened so they keep fitting in the model's window.">
        <Row form={form} path={["compaction", "auto"]} label="When it is long">
          <Choice
            form={form}
            path={["compaction", "auto"]}
            fallback="off"
            options={[
              { value: "off", label: "Leave it", hint: "Only when you ask" },
              {
                value: "trim",
                label: "Trim",
                hint: "Shorten old tool output; free",
              },
              {
                value: "full",
                label: "Summarise",
                hint: "Replace old turns with a summary",
              },
            ]}
          />
        </Row>
        <Row form={form} path={["compaction", "threshold_tokens"]} label="Start at">
          <NumberInput form={form} path={["compaction", "threshold_tokens"]} integer suffix="tokens" placeholder="automatic" />
        </Row>
        <Row form={form} path={["compaction", "keep_recent"]} label="Keep recent">
          <NumberInput form={form} path={["compaction", "keep_recent"]} integer suffix="entries" placeholder="12" />
        </Row>
      </Section>
      <Section title="Skills">
        <Row form={form} path={["skills", "follow"]} label="Changed skills">
          <Choice
            form={form}
            path={["skills", "follow"]}
            fallback="ask"
            options={[
              { value: "ask", label: "Ask", hint: "Offer to take the change" },
              {
                value: "auto",
                label: "Take it",
                hint: "Use the new version at once",
              },
              {
                value: "off",
                label: "Ignore",
                hint: "Stay on the version in use",
              },
            ]}
          />
        </Row>
      </Section>
      <Section title="Reminders" hint="Text added to the conversation as it goes.">
        <Row form={form} path={["injections", "usage"]} label="Cost so far">
          <Switch form={form} path={["injections", "usage"]} fallback />
        </Row>
        <Row form={form} path={["injections", "environment"]} label="Where it is running">
          <Switch form={form} path={["injections", "environment"]} fallback />
        </Row>
        <div class="tb-wrap">
          <table class="tb">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Every</th>
                <th>Text</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r}>
                  <td class="mono">{r}</td>
                  <td>
                    <NumberInput form={form} path={["injections", "rules", r, "every"]} integer suffix="turns" />
                  </td>
                  <td>
                    <TextInput form={form} path={["injections", "rules", r, "text"]} />
                    <Issues form={form} path={["injections", "rules", r]} />
                  </td>
                  <td class="gr-end">
                    <button
                      class="icon-button"
                      aria-label={`Remove ${r}`}
                      title="Remove"
                      onClick={() => form.remove(["injections", "rules", r])}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr>
                  <td colSpan={4} class="cf-empty">
                    No rules.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

// ---- repository ----------------------------------------------------------------------------------------------------

export function RepositoryPage({ form }: { form: Form }): JSX.Element {
  return (
    <>
      <Section title="Housekeeping" hint="Conversations are Git history; this keeps the repository small and quick.">
        <Row form={form} path={["maintenance", "auto"]} label="Tidy automatically">
          <Switch form={form} path={["maintenance", "auto"]} fallback />
        </Row>
        <Row form={form} path={["maintenance", "loose_objects"]} label="Tidy after" help="Loose objects that trigger a clean-up.">
          <NumberInput form={form} path={["maintenance", "loose_objects"]} integer suffix="objects" placeholder="1000" />
        </Row>
        <Row form={form} path={["maintenance", "packs"]} label="Merge packs at">
          <NumberInput form={form} path={["maintenance", "packs"]} integer suffix="packs" placeholder="20" />
        </Row>
        <Row form={form} path={["maintenance", "check_every"]} label="Check every">
          <NumberInput form={form} path={["maintenance", "check_every"]} integer suffix="commits" placeholder="200" />
        </Row>
      </Section>
      <Section title="Threads and jobs">
        <Row form={form} path={["threads", "siblings"]} label="Sibling threads" help="Let a thread see what its siblings have done.">
          <Switch form={form} path={["threads", "siblings"]} />
        </Row>
        <Row
          form={form}
          path={["background", "resume"]}
          label="Resume on job end"
          help="A finished background job restarts an idle thread. This spends money without being asked."
        >
          <Switch form={form} path={["background", "resume"]} />
        </Row>
      </Section>
    </>
  );
}
