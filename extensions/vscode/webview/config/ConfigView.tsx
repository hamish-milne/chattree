/**
 * The `harness.yml` editor. It takes the place of the transcript in the chat window (the header stays, with a way back),
 * so it has the whole panel: pages down the side or across the top as the width allows, the page, and a footer to save
 * with a commit message. Nothing is saved until Save; the controller says what is wrong as the person edits.
 */
import type { JSX } from "preact";
import type { ConfigModel } from "chattree/ui/model/config-model";
import { BUILTIN_TOOLS, GROUPS, PAGES } from "chattree/ui/model/config-sheet";
import {
  ApprovalsPage,
  ContextPage,
  InstructionsPage,
  LimitsPage,
  McpPage,
  ProvidersPage,
  RepositoryPage,
  SubagentsPage,
} from "./pages.tsx";
import type { Form } from "./controls.tsx";
import css from "./config.module.css";
import { cn } from "../cn.ts";

type Model = InstanceType<typeof ConfigModel>;

function Page({ model, form }: { model: Model; form: Form }): JSX.Element | null {
  switch (model.page.value) {
    case "providers":
      return <ProvidersPage form={form} model={model} />;
    case "limits":
      return <LimitsPage form={form} />;
    case "approvals":
      return <ApprovalsPage form={form} tools={BUILTIN_TOOLS} now={model.now()} />;
    case "mcp":
      return <McpPage form={form} />;
    case "subagents":
      return <SubagentsPage form={form} model={model} />;
    case "context":
      return <ContextPage form={form} />;
    case "repository":
      return <RepositoryPage form={form} />;
    case "instructions":
      return <InstructionsPage model={model} />;
    default:
      return null;
  }
}

export function ConfigView({ model }: { model: Model }): JSX.Element {
  const form = model.form.value;
  if (form === undefined) return <div class={cn(css.config, css["config-loading"])}>Loading harness.yml…</div>;
  const { byPage, general } = model.counts.value;
  const problems = model.problems.value;
  const dirty = model.dirty.value;
  return (
    <div class={css.config}>
      <div class={css["cf-body"]}>
        <nav class={css["cf-pages"]} aria-label="Settings pages">
          {GROUPS.map((g) => (
            <div key={g.id} class={css["cf-group"]}>
              <div class={css["cf-group-title"]}>{g.title}</div>
              {PAGES.filter((p) => p.group === g.id).map((p) => {
                const n = byPage.get(p.id) ?? 0;
                return (
                  <button
                    key={p.id}
                    class={cn(css["cf-page"], model.page.value === p.id && css.on)}
                    aria-current={model.page.value === p.id ? "page" : undefined}
                    onClick={() => model.setPage(p.id)}
                  >
                    <span class={css["cf-page-title"]}>{p.title}</span>
                    <span class={css["cf-page-hint"]}>{p.hint}</span>
                    {n > 0 && (
                      <span class={css["cf-badge"]} title={`${n} ${n === 1 ? "problem" : "problems"}`}>
                        {n}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div class={css["cf-page-body"]}>
          {general.length > 0 && (
            <div class={css["cf-banner"]} role="alert">
              {general.map((i, n) => (
                <div key={n}>{i.path === "" ? i.message : `${i.path} ${i.message}`}</div>
              ))}
            </div>
          )}
          <Page model={model} form={form} />
        </div>
      </div>
      {model.page.value === "instructions" && !dirty ? (
        <footer class={cn(css["cf-foot"], css.note)}>Instruction changes apply to this thread as soon as you make them.</footer>
      ) : (
        <footer class={css["cf-foot"]}>
          <input
            class={css["cf-text"]}
            aria-label="Commit message"
            placeholder="Commit message (optional)"
            disabled={!dirty}
            value={model.message.value}
            onInput={(e) => model.setMessage(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && model.save()}
          />
          {problems > 0 && (
            <span class={css["cf-problems"]} role="status">
              {problems} {problems === 1 ? "problem" : "problems"} to fix
            </span>
          )}
          <button class="secondary" disabled={!dirty} onClick={() => model.revert()}>
            Revert
          </button>
          <button class="primary" disabled={!dirty || problems > 0} onClick={() => model.save()}>
            {form.spec.value.saveLabel}
          </button>
        </footer>
      )}
    </div>
  );
}
