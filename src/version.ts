import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Reads the version number from package.json, so it is written in one place only.
 * This file lives in src/ (during development) or dist/ (after building);
 * in both cases package.json is one folder up.
 */
export function getVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  return pkg.version;
}
