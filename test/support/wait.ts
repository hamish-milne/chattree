/** How long a test waits for something on screen before giving up. A ceiling, not a delay: a slow CI machine (Windows) needs far more than a laptop. */
export const WAIT_MS = process.env["CI"] === undefined ? 8000 : 40000;
