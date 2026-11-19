#!/usr/bin/env node
// The line above tells your computer "run this file with Node" when you type `contextbaton`.

import { Command } from "commander";
import { getVersion } from "./version.js";
import { formatInitReport, runInit } from "./commands/init.js";

const program = new Command();

program
  .name("contextbaton")
  .description("Safe, local-first handoff notes for developers and their AI assistants.")
  .version(getVersion());

program
  .command("init")
  .description("set up contextbaton in this git repository")
  .action(async () => {
    const report = await runInit(process.cwd());
    console.log(formatInitReport(report));
  });

// More commands (save, check, status, mcp) will be added here in later steps.

// Run the command. Expected problems (like "not a git repository") are shown
// as a short message instead of a scary stack trace.
program.parseAsync().catch((err: Error) => {
  console.error(`contextbaton: ${err.message}`);
  process.exitCode = 1;
});
