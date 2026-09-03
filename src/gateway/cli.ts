#!/usr/bin/env node
import { runGatewayCli } from './agent-gateway.js';

runGatewayCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = Number.isInteger(code) ? code : 0;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[kitt-agent-gateway] ${message}`);
    process.exitCode = 1;
  });
