/**
 * chattree's identity on the wire. Kept in its own module, away from the adapters, so that http.ts can send it as the default
 * User-Agent without importing anything that could pull in provider code.
 */

/** What chattree says it is to a provider (the `User-Agent` of every request unless the provider's `headers` map overrides it). Kept equal to package.json's version by a test. */
export const VERSION = "0.0.1";
export const USER_AGENT = `chattree/${VERSION}`;
