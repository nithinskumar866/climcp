#!/usr/bin/env node
// The line above tells your computer "run this file with Node" when you type `contextbaton`.

import { Command } from "commander";
import { getVersion } from "./version.js";
import { createInterface } from "node:readline/promises";
import { formatInitReport, runInit } from "./commands/init.js";
import { formatSaveResult, formatSnapshot, runSave } from "./commands/save.js";

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

program
  .command("save")
  .description("write a handoff note (git info is filled in for you)")
  .option("-t, --title <text>", "title of the note")
  .option("--done <text>", "what you did")
  .option("--next <text>", "the next step")
  .option("--risks <text>", "risks and warnings")
  .option("-y, --yes", "don't ask questions; use the flags and defaults")
  .action(async (flags: { title?: string; done?: string; next?: string; risks?: string; yes?: boolean }) => {
    // Only ask questions when a person is typing (not in scripts or CI).
    const interactive = !flags.yes && process.stdin.isTTY === true;
    const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    try {
      const result = await runSave(process.cwd(), {
        given: { title: flags.title, done: flags.done, next: flags.next, risks: flags.risks },
        ask: rl ? (q) => rl.question(`? ${q}`) : null,
        onSnapshot: (git) => console.log(formatSnapshot(git)),
      });
      console.log("\n" + formatSaveResult(result));
    } finally {
      rl?.close();
    }
  });

// More commands (check, status, mcp) will be added here in later steps.

// Run the command. Expected problems (like "not a git repository") are shown
// as a short message instead of a scary stack trace.
program.parseAsync().catch((err: Error) => {
  console.error(`contextbaton: ${err.message}`);
  process.exitCode = 1;
});
