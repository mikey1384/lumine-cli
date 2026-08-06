#!/usr/bin/env node
import { main } from "../lib/commands.js";
import { formatAdminJsonError, isAdminJsonInvocation } from "../lib/admin.js";

main().catch((error) => {
  if (isAdminJsonInvocation(process.argv.slice(2))) {
    console.log(JSON.stringify(formatAdminJsonError(error)));
  } else {
    console.error(`lumine: ${error?.message || error}`);
  }
  process.exitCode = 1;
});
