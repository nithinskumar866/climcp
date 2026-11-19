#!/usr/bin/env node
// The line above tells your computer "run this file with Node" when you type `contextbaton`.

import { Command } from "commander";
import { getVersion } from "./version.js";

const program = new Command();

program
  .name("contextbaton")
  .description("Safe, local-first handoff notes for developers and their AI assistants.")
  .version(getVersion());

// The commands (init, save, check, status, mcp) will be added here in later steps.

program.parse();
