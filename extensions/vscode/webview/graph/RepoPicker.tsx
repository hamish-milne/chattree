/**
 * The repository picker above the graph: a button naming the repository shown and a list of the workspace's
 * repositories. One that holds no chattree conversation is listed but cannot be chosen, and says why.
 */
import type { JSX } from "preact";
import type { GraphModel } from "chattree/ui/model/graph-model";
import { Icon } from "../icons.tsx";

type Model = InstanceType<typeof GraphModel>;

export function RepoPicker({ model }: { model: Model }): JSX.Element | null {
  const list = model.repos.value;
  if (list === undefined || list.repos.length === 0) return null;
  const open = model.repoMenuOpen.value;
  const current = list.repos.find((r) => r.id === list.current);
  return (
    <div
      class="repo-picker"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          model.closeRepoMenu();
        }
      }}
    >
      <button class="repo-button" aria-haspopup="listbox" aria-expanded={open} title={current?.path} onClick={() => model.toggleRepoMenu()}>
        <Icon name="repo" size={14} />
        <span class="repo-name">{current?.name ?? "Choose a repository"}</span>
        {current !== undefined && <span class="repo-path">{current.path}</span>}
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <>
          <div class="menu-scrim" onClick={() => model.closeRepoMenu()} />
          <div class="repo-menu" role="listbox" aria-label="Repository">
            {list.repos.map((r) => (
              <button
                key={r.id}
                class={`repo-item${r.id === list.current ? " current" : ""}`}
                role="option"
                aria-selected={r.id === list.current}
                aria-disabled={!r.chattree}
                disabled={!r.chattree}
                title={r.reason ?? r.path}
                onClick={() => model.selectRepo(r.id)}
              >
                <span class="repo-check">{r.id === list.current && <Icon name="check" size={14} />}</span>
                <span class="repo-text">
                  <span class="repo-line">
                    <span class="repo-name">{r.name}</span>
                    <span class="repo-path">{r.path}</span>
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
