import { sha256Hex } from "../../src/index.ts";

/**
 * A file's version: the first 8 hex digits of the SHA-256 of its bytes. `read` and `write` report it and `edit` requires it,
 * so line numbers can only be used on the file they were read from (docs/tools.md, 4.1).
 */
export const versionOf = async (bytes: Uint8Array): Promise<string> => (await sha256Hex(bytes)).slice(0, 8);
