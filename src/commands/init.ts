import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configPath, defaultConfigText } from "../core/config.js";
import { findRepoRoot, hooksDir, isIgnored } from "../core/git.js";
import { CONTEXT_DIR, contextDir, kindDir } from "../core/paths.js";

// `contextbaton init`: sets up a project in four parts.
//   1. .context/ folders (+ a short README so humans know what it is)
//   2. a pointer block in AGENTS.md, so AI assistants know the notes exist
//   3. a git pre-commit hook that blocks commits with secrets in notes
//   4. printed instructions to connect Claude Code and Cursor via MCP
//
// Running it again is safe: it only adds what's missing.

export class InitError extends Error {}

/** What happened to each part, so the CLI can print a clear summary. */
export type PartResult = "created" | "updated" | "unchanged" | "skipped";

export interface InitReport {
  root: string;
  context: PartResult;
  agentsMd: PartResult;
  hook: PartResult;
  hookPath: string;
  /** Problems the user should know about (never fatal). */
  warnings: string[];
}

// ---------- 1. .context folder ----------

const CONTEXT_README = `# .context

Handoff notes and decisions for this project, managed by [contextbaton](https://www.npmjs.com/package/contextbaton).

- \`handoffs/\`: what was done, what's left, and what to watch out for.
- \`decisions/\`: important decisions and why they were made.

Every note is scanned for secrets before it is saved. Notes can go out of date:
run \`npx contextbaton check\` to see which ones need checking.

\`config.json\` sets when a note counts as possibly outdated: more than
\`maxChangedLines\` changed lines in its related files, or not confirmed for
more than \`maxDaysUnconfirmed\` days.
`;

async function setUpContextDir(root: string): Promise<PartResult> {
  let created = false;
  for (const dir of [kindDir(root, "handoff"), kindDir(root, "decision")]) {
    // Each folder gets a .gitkeep so git tracks it even while it's still empty.
    await mkdir(dir, { recursive: true });
    created = (await writeIfMissing(join(dir, ".gitkeep"), "")) || created;
  }
  created = (await writeIfMissing(join(contextDir(root), "README.md"), CONTEXT_README)) || created;
  // The settings file, with the default limits, so it's easy to see what can be changed.
  created = (await writeIfMissing(configPath(root), defaultConfigText())) || created;
  return created ? "created" : "unchanged";
}

// ---------- 2. AGENTS.md pointer ----------

export const AGENTS_START = "<!-- contextbaton:start -->";
export const AGENTS_END = "<!-- contextbaton:end -->";

export const AGENTS_BLOCK = `${AGENTS_START}
## Handoff notes (contextbaton)

This project keeps short handoff notes and decisions in \`${CONTEXT_DIR}/\`.

- **Start of a session:** call the \`get_latest_handoff\` MCP tool (or read the newest file in \`${CONTEXT_DIR}/handoffs/\`).
- **Outdated notes** may be wrong: check the code before trusting them, then call \`confirm_note\` if they're still true.
- **End of a session:** call \`write_handoff\` to leave a note for whoever comes next. Use \`record_decision\` for important decisions.
- Never put secrets in notes. contextbaton redacts them, but don't rely on that.
${AGENTS_END}`;

async function setUpAgentsMd(root: string): Promise<PartResult> {
  const path = join(root, "AGENTS.md");
  const existing = await readIfExists(path);

  if (existing === null) {
    await writeFile(path, `# AGENTS.md\n\n${AGENTS_BLOCK}\n`, "utf8");
    return "created";
  }

  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start !== -1 && end > start) {
    // Our block is already there: replace just that part, keep everything else.
    const updated = existing.slice(0, start) + AGENTS_BLOCK + existing.slice(end + AGENTS_END.length);
    if (updated === existing) return "unchanged";
    await writeFile(path, updated, "utf8");
    return "updated";
  }

  // AGENTS.md exists without our block: add it at the end.
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(path, `${existing}${separator}${AGENTS_BLOCK}\n`, "utf8");
  return "updated";
}

// ---------- 3. pre-commit hook ----------

export const HOOK_MARKER = "# contextbaton-hook";

// A tiny shell script. Git runs it before every commit; if it exits with
// an error code, the commit is stopped. (On Windows, Git for Windows runs it with its own `sh`.)
export const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER}
# Blocks the commit if a note in ${CONTEXT_DIR}/ contains a secret.
# Installed by \`contextbaton init\`. Safe to delete if you stop using contextbaton.

if command -v contextbaton >/dev/null 2>&1; then
  exec contextbaton check --hook
elif [ -x node_modules/.bin/contextbaton ]; then
  exec node_modules/.bin/contextbaton check --hook
else
  echo "contextbaton: not installed, so notes were NOT checked for secrets." >&2
  exit 0
fi
`;

/** The line to add by hand when a project already has its own pre-commit hook. */
export const HOOK_MANUAL_LINE = "npx --no-install contextbaton check --hook";

async function setUpHook(root: string, warnings: string[]): Promise<{ result: PartResult; path: string }> {
  const path = join(await hooksDir(root), "pre-commit");
  const existing = await readIfExists(path);

  if (existing !== null && !existing.includes(HOOK_MARKER)) {
    // Someone else's hook. Never overwrite it.
    warnings.push(
      `A pre-commit hook already exists (${path}). It was left alone. ` +
        `To turn on the secret check, add this line to it:\n    ${HOOK_MANUAL_LINE}`,
    );
    return { result: "skipped", path };
  }
  if (existing === HOOK_SCRIPT) return { result: "unchanged", path };

  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, HOOK_SCRIPT, "utf8"); // "\n" line endings: sh needs them, even on Windows
  await chmod(path, 0o755); // make it executable (no effect on Windows, needed on Mac/Linux)
  return { result: existing === null ? "created" : "updated", path };
}

// ---------- 4. MCP instructions ----------

export function mcpInstructions(): string {
  return `Connect your AI assistant:

  Claude Code (run once in this folder):
    claude mcp add --scope project contextbaton -- npx -y contextbaton mcp

  Cursor (create .cursor/mcp.json):
    {
      "mcpServers": {
        "contextbaton": {
          "command": "npx",
          "args": ["-y", "contextbaton", "mcp", "--root", "\${workspaceFolder}"]
        }
      }
    }`;
}

// ---------- putting it together ----------

export async function runInit(cwd: string): Promise<InitReport> {
  const root = await findRepoRoot(cwd);
  if (!root) {
    throw new InitError("This folder is not inside a git repository. Run `git init` first, then try again.");
  }

  const warnings: string[] = [];
  const context = await setUpContextDir(root);
  if (await isIgnored(root, CONTEXT_DIR)) {
    warnings.push(`.gitignore ignores ${CONTEXT_DIR}/, so notes won't be shared with your team. Remove that line to share them.`);
  }
  const agentsMd = await setUpAgentsMd(root);
  const hook = await setUpHook(root, warnings);

  return { root, context, agentsMd, hook: hook.result, hookPath: hook.path, warnings };
}

export function formatInitReport(r: InitReport): string {
  const icon = (p: PartResult) => (p === "skipped" ? "!" : "✓");
  const word = (p: PartResult) => (p === "unchanged" ? "already set up" : p);
  const out = [
    `contextbaton set up in ${r.root}`,
    "",
    `  ${icon(r.context)} ${CONTEXT_DIR}/ folders: ${word(r.context)}`,
    `  ${icon(r.agentsMd)} AGENTS.md pointer: ${word(r.agentsMd)}`,
    `  ${icon(r.hook)} pre-commit secret check: ${word(r.hook)}`,
  ];
  for (const w of r.warnings) out.push("", `  ! ${w}`);
  out.push("", mcpInstructions(), "", "Next: run `contextbaton save` at the end of your session.");
  return out.join("\n");
}

// ---------- small file helpers ----------

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Creates the file only if it doesn't exist. Returns true if it was created. */
async function writeIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
