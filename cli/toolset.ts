/** The terminal's approval prompt: asks about a call and parses the typed answer. The tools themselves are `app/toolset.ts`. */
import type { Approval, ApprovalRequest } from "../harness/loop.ts";
import type { AskFn, Choice } from "./engine.ts";
import { describeCall } from "../app/tool-lines.ts";

/** The user's answer to "may this call run?", as a loop approval. */
export function parseAnswer(answer: string, request: Pick<ApprovalRequest, "keys">): "no" | Approval {
  const c = answer.trim().toLowerCase()[0] ?? "n";
  if (c === "y") return { allow: true };
  // The timed and forever answers only mean something when the request names keys to grant; otherwise they are a plain no.
  const grant = request.keys !== null && request.keys.length > 0;
  if (grant && c === "5") return { allow: true, grant: { seconds: 300 } };
  if (grant && c === "h") return { allow: true, grant: { seconds: 3600 } };
  if (grant && c === "f") return { allow: true, grant: { seconds: Infinity } };
  return "no";
}

/** Ask the user about a call. `ask` is the terminal's question; without one nothing is asked and the call is declined. */
export function makeApprover(ask: AskFn, label?: string): (request: Pick<ApprovalRequest, "name" | "args" | "keys">) => Promise<Approval> {
  return async (request) => {
    const keys = request.keys ?? [];
    const grant = keys.length > 0;
    const choices: Choice[] = grant
      ? [
          { key: "y", label: "yes, once" },
          { key: "5", label: "yes, for 5 minutes" },
          { key: "h", label: "yes, for 1 hour" },
          { key: "f", label: "yes, forever" },
          { key: "n", label: "no" },
        ]
      : [
          { key: "y", label: "yes, once" },
          { key: "n", label: "no" },
        ];
    const answer = await ask(
      `\nAllow this${label === undefined ? "" : ` (asked by ${label})`}?\n  ${describeCall(request.name, request.args).replace(/\n/g, "\n  ")}${grant ? `\n  (5, h and f allow: ${keys.join("; ")})` : ""}`,
      "n",
      choices,
    );
    const parsed = parseAnswer(answer, request);
    if (parsed !== "no") return parsed;
    const reason = (await ask("Why not? (sent to the model; Enter to skip)", "")).trim();
    return { allow: false, ...(reason === "" ? {} : { reason }) };
  };
}
