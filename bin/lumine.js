#!/usr/bin/env node
import { main } from "../lib/commands.js";

main().catch((error) => {
  console.error(`lumine: ${error?.message || error}`);
  process.exitCode = 1;
});
