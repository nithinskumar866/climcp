import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { contextDir } from "./paths.js";
import { DEFAULT_RULES, type StalenessRules } from "./staleness.js";

// Optional settings in .context/config.json. Everything has a default,
// so the file can be missing or contain only the values you want to change:
//
//   { "outdated": { "maxChangedLines": 50, "maxDaysUnconfirmed": 90 } }

export interface Config {
  outdated: StalenessRules;
}

export const DEFAULT_CONFIG: Config = { outdated: DEFAULT_RULES };

export class ConfigError extends Error {}

export function configPath(root: string): string {
  return join(contextDir(root), "config.json");
}

export async function loadConfig(root: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(configPath(root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(".context/config.json is not valid JSON");
  }

  const outdated = (raw as { outdated?: Record<string, unknown> })?.outdated ?? {};
  return {
    outdated: {
      maxChangedLines: positiveNumber(outdated.maxChangedLines, "maxChangedLines", DEFAULT_RULES.maxChangedLines),
      maxDaysUnconfirmed: positiveNumber(outdated.maxDaysUnconfirmed, "maxDaysUnconfirmed", DEFAULT_RULES.maxDaysUnconfirmed),
    },
  };
}

function positiveNumber(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`.context/config.json: "outdated.${name}" must be a number of 0 or more`);
  }
  return value;
}

export function defaultConfigText(): string {
  return JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
}
