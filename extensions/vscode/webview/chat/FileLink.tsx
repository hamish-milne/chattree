/**
 * A reference to a file as a button: a plain click does what the extension's setting says, and a right-click offers
 * both versions (the file as it is now, and as the thread had it after the change the reference is in). The same
 * button is used for a link in a message and for the path of a tool call.
 */
import type { ComponentChildren, JSX } from "preact";
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ChatModel } from "chattree/ui/model/chat-model";
import { refLabel, type FileRef } from "chattree/ui/model/file-ref";
import css from "./chat.module.css";
import { cn } from "../cn.ts";

type Model = InstanceType<typeof ChatModel>;

/** Where a reference is: the model that opens it and the commit of the block it is in. */
export interface FileLinks {
  model: Model;
  commit: string | undefined;
}
export const FileLinkContext = createContext<FileLinks | undefined>(undefined);

export function FileLink({ file, children }: { file: FileRef; children?: ComponentChildren }): JSX.Element {
  const ctx = useContext(FileLinkContext);
  const label = refLabel(file);
  if (ctx === undefined) return <span class={cn(css.file_link, css.plain)}>{children ?? label}</span>;
  return (
    <button
      class={css.file_link}
      title={label}
      onClick={() => ctx.model.openFile(file, ctx.commit)}
      onContextMenu={(e) => {
        e.preventDefault();
        ctx.model.openFileMenu(file, ctx.commit, e.clientX, e.clientY);
      }}
    >
      {children ?? label}
    </button>
  );
}

/** The menu a right-click on a reference opens. */
export function FileMenu({ model }: { model: Model }): JSX.Element | null {
  const m = model.fileMenu.value;
  if (m === undefined) return null;
  return (
    <>
      <div
        class="menu-scrim"
        onClick={() => model.closeFileMenu()}
        onContextMenu={(e) => {
          e.preventDefault();
          model.closeFileMenu();
        }}
      />
      <div
        class="menu"
        role="menu"
        style={{ left: `${m.x}px`, top: `${m.y}px` }}
        onKeyDown={(e) => e.key === "Escape" && model.closeFileMenu()}
      >
        <button class="menu-item" role="menuitem" onClick={() => model.openFile(m.ref, m.commit, "current")}>
          <span>Open the current file</span>
        </button>
        <button
          class="menu-item"
          role="menuitem"
          disabled={m.commit === undefined}
          title={m.commit === undefined ? "This message has no commit yet" : undefined}
          onClick={() => model.openFile(m.ref, m.commit, "after")}
        >
          <span>View the file after this change</span>
          {m.commit === undefined && <span class="reason">This message has no commit yet</span>}
        </button>
        <button
          class={cn("menu-item", "separated")}
          role="menuitem"
          onClick={() => {
            void navigator.clipboard.writeText(m.ref.path);
            model.closeFileMenu();
          }}
        >
          <span>Copy path</span>
        </button>
      </div>
    </>
  );
}
