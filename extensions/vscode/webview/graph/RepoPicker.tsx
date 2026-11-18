/**
 * The repository picker above the graph: a button naming the repository shown and a list of the workspace's
 * repositories. One that holds no chattree conversation is listed but cannot be chosen, and says why.
 */
import type { JSX } from "preact";
import type { GraphModel } from "chattree/ui/model/graph-model";
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
      class={css["repo-picker"]}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          model.closeRepoMenu();
        }
      }}
    >
      <button
        class={css["repo-button"]}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current?.path}
        onClick={() => model.toggleRepoMenu()}
      >
        <Icon name="repo" size={14} />
        <span class={css["repo-name"]}>{current?.name ?? "Choose a repository"}</span>
        {current !== undefined && <span class={css["repo-path"]}>{current.path}</span>}
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <>
          <div class="menu-scrim" onClick={() => model.closeRepoMenu()} />
          <div class={css["repo-menu"]} role="listbox" aria-label="Repository">
            {list.repos.map((r) => (
              <button
                key={r.id}
                class={css["repo-item"]}
                role="option"
                aria-selected={r.id === list.current}
                aria-disabled={!r.chattree}
                disabled={!r.chattree}
                title={r.reason ?? r.path}
                onClick={() => model.selectRepo(r.id)}
              >
                <span class={css["repo-check"]}>{r.id === list.current && <Icon name="check" size={14} />}</span>
                <span class={css["repo-text"]}>
                  <span class={css["repo-line"]}>
                    <span class={css["repo-name"]}>{r.name}</span>
                    <span class={css["repo-path"]}>{r.path}</span>
                  </span>
                  {r.reason !== undefined && <span class="reason">{r.reason}</span>}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
