#!/usr/bin/env -S node --no-warnings
import { main } from "./main.ts";
import { nodeIo } from "./io.ts";

process.exitCode = await main(process.argv.slice(2), nodeIo());
