/**
 * The `harness.yml` editor. It takes the place of the transcript in the chat window (the header stays, with a way back),
 * so it has the whole panel: pages down the side or across the top as the width allows, the page, and a footer to save
 * with a commit message. Nothing is saved until Save; the controller says what is wrong as the person edits.
 */
import type { JSX } from "preact";
import type { ConfigModel } from "chattree/ui/model/config-model";
import { BUILTIN_TOOLS, PAGES } from "chattree/ui/model/config-sheet";
import { ApprovalsPage, ContextPage, LimitsPage, McpPage, ProvidersPage, RepositoryPage, SubagentsPage } from "./pages.tsx";
import type { Form } from "./controls.tsx";

type Model = InstanceType<typeof ConfigModel>;

function Page({ model, form }: { model: Model; form: Form }): JSX.Element | null {
  switch (model.page.value) {
    case "providers":
      return <ProvidersPage form={form} />;
    case "limits":
      return <LimitsPage form={form} />;
    case "approvals":
      return <ApprovalsPage form={form} tools={BUILTIN_TOOLS} now={model.now()} />;
    case "mcp":
      return <McpPage form={form} />;
    case "subagents":
      return <SubagentsPage form={form} />;
    case "context":
      return <ContextPage form={form} />;
    case "repository":
      return <RepositoryPage form={form} />;
    default:
      return null;
  }
}

export function ConfigView({ model }: { model: Model }): JSX.Element {
  const form = model.form.value;
  if (form === undefined) return <div class="config config-loading">Loading harness.yml…</div>;
  const { byPage, general } = model.counts.value;
  const problems = model.problems.value;
  const dirty = model.dirty.value;
  return (
    <div class="config">
      <div class="cf-body">
        <nav class="cf-pages" aria-label="Settings pages">
          {PAGES.map((p) => {
            const n = byPage.get(p.id) ?? 0;
            return (
              <button
                key={p.id}
                class={`cf-page${model.page.value === p.id ? " on" : ""}`}
                aria-current={model.page.value === p.id ? "page" : undefined}
                onClick={() => model.setPage(p.id)}
              >
                <span class="cf-page-title">{p.title}</span>
                <span class="cf-page-hint">{p.hint}</span>
                {n > 0 && (
                  <span class="cf-badge" title={`${n} ${n === 1 ? "problem" : "problems"}`}>
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div class="cf-page-body">
          {general.length > 0 && (
            <div class="cf-banner" role="alert">
              {general.map((i, n) => (
                <div key={n}>{i.path === "" ? i.message : `${i.path} ${i.message}`}</div>
              ))}
            </div>
          )}
          <Page model={model} form={form} />
        </div>
      </div>
      <footer class="cf-foot">
        <input
          class="cf-text"
          aria-label="Commit message"
          placeholder="Commit message (optional)"
          disabled={!dirty}
          value={model.message.value}
          onInput={(e) => model.setMessage(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && model.save()}
        />
        {problems > 0 && (
          <span class="cf-problems" role="status">
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
    </div>
  );
}
