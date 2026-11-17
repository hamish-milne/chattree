#!/usr/bin/env -S node --no-warnings
/**
 * Executable entry point for the `chattree` command. It does nothing but wire the real process I/O into `main` and pass
 * its result back as the exit code, so all behaviour lives in `main.ts` where it can be tested with fake I/O.
 */
import { main } from "./main.ts";
import { nodeIo } from "./io.ts";

process.exitCode = await main(process.argv.slice(2), nodeIo());
