/**
 * The repository picker above the graph: a button naming the repository shown and a list of the workspace's
 * repositories. One that holds no chattree conversation is listed but cannot be chosen, and says why.
 */
import type { JSX } from "preact";
import type { GraphModel } from "chattree/ui/model/graph-model";
import { cn } from "../cn.ts";
import { Icon } from "../icons.tsx";
import css from "./graph.module.css";

type Model = InstanceType<typeof GraphModel>;

export function RepoPicker({ model }: { model: Model }): JSX.Element | null {
  const list = model.repos.value;
  if (list === undefined || list.repos.length === 0) return null;
  const open = model.repoMenuOpen.value;
  const current = list.repos.find((r) => r.id === list.current);
  return (
    <div
      class={css.repo_picker}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          model.closeRepoMenu();
        }
      }}
    >
      <button
        class={css.repo_button}
        aria-label={`Repository: ${current?.name ?? "none chosen"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current?.path}
        onClick={() => model.toggleRepoMenu()}
      >
        <Icon name="repo" size={14} />
        <span class={css.repo_name}>{current?.name ?? "Choose a repository"}</span>
        {current !== undefined && <span class={css.repo_path}>{current.path}</span>}
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <>
          <div class="menu-scrim" onClick={() => model.closeRepoMenu()} />
          <div class={css.repo_menu} role="listbox" aria-label="Repository">
            {list.repos
              .filter((r) => r.init === undefined)
              .map((r) => (
                <button
                  key={r.id}
                  class={css.repo_item}
                  role="option"
                  aria-selected={r.id === list.current}
                  aria-disabled={!r.chattree}
                  disabled={!r.chattree}
                  title={r.reason ?? r.path}
                  onClick={() => model.selectRepo(r.id)}
                >
                  <span class={css.repo_check}>{r.id === list.current && <Icon name="check" size={14} />}</span>
                  <span class={css.repo_text}>
                    <span class={css.repo_line}>
                      <span class={css.repo_name}>{r.name}</span>
                      <span class={css.repo_path}>{r.path}</span>
                    </span>
                    {r.reason !== undefined && <span class="reason">{r.reason}</span>}
                    {r.attachedAs !== undefined && <span class="reason">attached to the conversation above it</span>}
                  </span>
                </button>
              ))}
            {model.initializable.value.map((r, i) => (
              <button
                key={r.id}
                class={cn(css.repo_item, i === 0 && css.repo_separated)}
                role="menuitem"
                title={r.path}
                onClick={() => model.initRepo(r.id)}
              >
                <span class={css.repo_check}>
                  <Icon name="plus" size={14} />
                </span>
                <span class={css.repo_text}>
                  <span class={css.repo_line}>
                    <span>Initialize in</span>
                    <span class={css.repo_name}>{r.name}</span>
                    <span class={css.repo_path}>{r.path}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
