/**
 * The wire between the controller and the webviews. Events go to every webview that is open, and the intents they post come
 * back through `parseIntent` (a webview is another context and is not trusted). Nothing here knows VS Code beyond the webview's
 * `postMessage` and `onDidReceiveMessage`, so it is the part a test can run without an editor. (The web host does the same
 * over a WebSocket.)
 */
import { parseIntent, type UiEvent, type UiIntent } from "../model/protocol.ts";

/** What the bridge needs of a webview. */
export interface Port {
  post(event: UiEvent): void;
}

export interface HostedController {
  handle(intent: UiIntent): void;
}

export class Bridge {
  readonly #ports = new Set<Port>();
  readonly #controller: HostedController;
  readonly #seen: (event: UiEvent) => void;
  readonly #onIntent: (intent: UiIntent) => void;

  /** `make` builds the controller around `emit`; `seen` also sees every event (the host shows notices natively). */
  constructor(
    make: (emit: (event: UiEvent) => void) => HostedController,
    seen: (event: UiEvent) => void = () => {},
    /** Sees every intent that passed the check, before the controller does (the host logs them, and brings the chat forward). */
    onIntent: (intent: UiIntent) => void = () => {},
  ) {
    this.#seen = seen;
    this.#onIntent = onIntent;
    this.#controller = make((e) => this.emit(e));
  }

  emit(event: UiEvent): void {
    this.#seen(event);
    for (const p of this.#ports) p.post(event);
  }

  /** A webview opened. The result removes it again. */
  attach(port: Port): () => void {
    this.#ports.add(port);
    return () => void this.#ports.delete(port);
  }

  /** A message a webview posted: checked, then handed to the controller. A bad one is answered with an error notice. */
  receive(raw: unknown): void {
    const parsed = parseIntent(raw);
    if (!parsed.ok) {
      this.emit({
        type: "notice",
        level: "error",
        message: `A view sent something chattree does not understand: ${parsed.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      });
      return;
    }
    try {
      this.#onIntent(parsed.value);
      this.#controller.handle(parsed.value);
    } catch (e) {
      this.emit({ type: "notice", level: "error", message: `${parsed.value.type} failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
}
