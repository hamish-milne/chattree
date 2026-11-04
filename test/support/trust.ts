import { nodeHost } from "../../hosts/node.ts";
import { Conversation } from "../../harness/conversation.ts";

/** The user approves the `harness.yml` a directory has now (the tests edit it by hand, as a person would; a thread uses it only once it is approved). */
export async function approve(dir: string): Promise<void> {
  const convo = await Conversation.open(nodeHost(), dir);
  try {
    await convo.approveConfig();
  } finally {
    await convo.close();
  }
}
