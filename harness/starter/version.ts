/**
 * Version stamps for file tools. Kept separate so `read`, `write` and `edit` agree on one definition of a version.
 */
import { sha256Hex } from "../../src/index.ts";

/**
 * A file's version: the first 8 hex digits of the SHA-256 of its bytes. `read` and `write` report it and `edit` requires it
 * (any text containing the 8 digits will do), so line numbers can only be used on the file they were read from.
 */
export const versionOf = async (bytes: Uint8Array): Promise<string> => (await sha256Hex(bytes)).slice(0, 8);
