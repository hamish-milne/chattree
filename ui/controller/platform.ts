import { AppError } from "../../app/errors.ts";

/** A file the person picked to attach to a message. */
export interface PickedFile {
  name: string;
  bytes: Uint8Array;
  mime?: string | undefined;
}

/**
 * What the controller needs from the program it runs in and cannot do itself: the editor, the clipboard, a file picker.
 * The extension host implements it with the VS Code API; a test or the browser host gives it a stub. Everything else
 * the controller does with files and git directly.
 */
export interface Platform {
  /** Show a file (an absolute path), at a line or range. `content` is a read-only copy of the file as an earlier commit had it. */
  openFile(file: {
    path: string;
    line?: number | undefined;
    endLine?: number | undefined;
    content?: { label: string; bytes: Uint8Array } | undefined;
  }): Promise<void>;
  copy(text: string): Promise<void>;
  /** Let the person pick files; none if they cancel. */
  pickFiles(): Promise<PickedFile[]>;
  /** Called before a message is put on the thread, so an editor can save what the person has open for the model to see. */
  beforeSend?(): Promise<void>;
}

const unavailable = (what: string): never => {
  throw new AppError(`${what} is not available here`);
};

/** For a host with no editor (a test, a browser tab): each thing says so. */
export const headlessPlatform: Platform = {
  openFile: () => Promise.resolve(unavailable("Opening a file")),
  copy: () => Promise.resolve(unavailable("Copying")),
  pickFiles: () => Promise.resolve(unavailable("Attaching a file")),
};
