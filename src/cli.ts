#!/usr/bin/env node
import { main } from "./run.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`stp: ${message}\n`);
    process.exitCode = 1;
  });
