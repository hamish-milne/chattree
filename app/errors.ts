/**
 * A failure the person can act on, with the way out: what an application service (`init`, opening a project, setting up
 * the tools) throws when the problem is theirs (a missing key, a bad settings file) and not a bug. A host shows `message`
 * and `hint` in its own way: the CLI prints them, the extension host sends a notice.
 */
export class AppError extends Error {
  override name = "AppError";
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}
