/**
 * What the end-to-end journey may do to the product: look at it and use it as a person does, by what a person sees (a
 * control's role and name, a label, some text) and never by class name or position. Two runners give it hands: a real
 * browser over the web host (`playwright-driver.ts`), and, later, VS Code's own webview. The journey is written once.
 *
 * A target is the first element in the page that matches; say more (a name) when there could be several.
 */
export type Target =
  | { role: string; name?: string | RegExp; expanded?: boolean; disabled?: boolean }
  | { label: string | RegExp }
  | { text: string | RegExp };

export interface Driver {
  click(target: Target): Promise<void>;
  rightClick(target: Target): Promise<void>;
  /** Replace the text of a field. */
  type(target: Target, text: string): Promise<void>;
  /** Wait for it to be there (the product answers in its own time). */
  expectVisible(target: Target, timeoutMs?: number): Promise<void>;
  expectGone(target: Target, timeoutMs?: number): Promise<void>;
  /** The text of an element. */
  text(target: Target): Promise<string>;
  /** Keep a picture, for a person to look at when a step fails or to see the flow. */
  screenshot(name: string): Promise<void>;
}
