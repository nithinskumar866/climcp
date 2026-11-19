import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runInit,
  formatInitReport,
  InitError,
  AGENTS_START,
  AGENTS_END,
  HOOK_MARKER,
  HOOK_SCRIPT,
} from "../src/commands/init.js";
import { createTempRepo, type TempRepo } from "./helpers/temp-repo.js";

let repo: TempRepo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const read = (p: string) => readFile(join(repo.root, p), "utf8");
const count = (text: string, part: string) => text.split(part).length - 1;

describe("contextbaton init in a fresh repo", () => {
  it("sets up all three parts", async () => {
    const report = await runInit(repo.root);
    expect(report).toMatchObject({ context: "created", agentsMd: "created", hook: "created", warnings: [] });

    expect(existsSync(join(repo.root, ".context", "handoffs"))).toBe(true);
    expect(existsSync(join(repo.root, ".context", "decisions"))).toBe(true);
    expect(await read(".context/README.md")).toContain("Handoff notes");

    const agents = await read("AGENTS.md");
    expect(agents).toContain(AGENTS_START);
    expect(agents).toContain("get_latest_handoff");

    expect(await read(".git/hooks/pre-commit")).toBe(HOOK_SCRIPT);
  });

  it("works when run from a subfolder", async () => {
    await mkdir(join(repo.root, "src", "deep"), { recursive: true });
    const report = await runInit(join(repo.root, "src", "deep"));
    expect(existsSync(join(repo.root, ".context", "handoffs"))).toBe(true);
    expect(report.context).toBe("created");
  });

  it("makes the folders visible to git (so they get shared)", async () => {
    await runInit(repo.root);
    const status = repo.git("status", "--porcelain", "--untracked-files=all");
    expect(status).toContain(".context/handoffs/.gitkeep");
    expect(status).toContain(".context/decisions/.gitkeep");
  });

  it("the hook uses Unix line endings (needed by sh, also on Windows)", async () => {
    await runInit(repo.root);
    expect(await read(".git/hooks/pre-commit")).not.toContain("\r\n");
  });

  it.skipIf(process.platform === "win32")("the hook is executable", async () => {
    await runInit(repo.root);
    const mode = (await stat(join(repo.root, ".git", "hooks", "pre-commit"))).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});

describe("running init again", () => {
  it("is safe: nothing is duplicated", async () => {
    await runInit(repo.root);
    const second = await runInit(repo.root);
    expect(second).toMatchObject({ context: "unchanged", agentsMd: "unchanged", hook: "unchanged" });
    expect(count(await read("AGENTS.md"), AGENTS_START)).toBe(1);
  });

  it("refreshes an old pointer block instead of adding a second one", async () => {
    await writeFile(
      join(repo.root, "AGENTS.md"),
      `# My rules\n\nUse tabs.\n\n${AGENTS_START}\nold text\n${AGENTS_END}\n\n## More rules\n`,
    );
    const report = await runInit(repo.root);
    const agents = await read("AGENTS.md");

    expect(report.agentsMd).toBe("updated");
    expect(agents).not.toContain("old text");
    expect(agents).toContain("get_latest_handoff");
    expect(agents).toContain("Use tabs."); // the user's own text is kept
    expect(agents).toContain("## More rules");
    expect(count(agents, AGENTS_START)).toBe(1);
  });
});

describe("respecting what's already there", () => {
  it("adds to an existing AGENTS.md without changing its text", async () => {
    const original = "# AGENTS.md\n\nRun `npm test` before committing.\n";
    await writeFile(join(repo.root, "AGENTS.md"), original);
    await runInit(repo.root);
    const agents = await read("AGENTS.md");
    expect(agents.startsWith(original)).toBe(true);
    expect(agents).toContain(AGENTS_START);
  });

  it("never overwrites someone else's pre-commit hook", async () => {
    const theirHook = "#!/bin/sh\nnpm run lint\n";
    await writeFile(join(repo.root, ".git", "hooks", "pre-commit"), theirHook);

    const report = await runInit(repo.root);
    expect(report.hook).toBe("skipped");
    expect(await read(".git/hooks/pre-commit")).toBe(theirHook);
    expect(report.warnings.join()).toContain("contextbaton check --hook");
  });

  it("updates its own older hook", async () => {
    await writeFile(join(repo.root, ".git", "hooks", "pre-commit"), `#!/bin/sh\n${HOOK_MARKER}\nold version\n`);
    const report = await runInit(repo.root);
    expect(report.hook).toBe("updated");
    expect(await read(".git/hooks/pre-commit")).toBe(HOOK_SCRIPT);
  });

  it("puts the hook where the project keeps its hooks (core.hooksPath)", async () => {
    repo.git("config", "core.hooksPath", ".githooks");
    const report = await runInit(repo.root);
    expect(report.hookPath.replace(/\\/g, "/")).toMatch(/\.githooks\/pre-commit$/);
    expect(await read(".githooks/pre-commit")).toBe(HOOK_SCRIPT);
  });

  it("warns if .gitignore would hide the notes from the team", async () => {
    await writeFile(join(repo.root, ".gitignore"), ".context/\n");
    const report = await runInit(repo.root);
    expect(report.warnings.join()).toContain(".gitignore");
  });
});

describe("errors and output", () => {
  it("explains what to do outside a git repo", async () => {
    const notRepo = await mkdtemp(join(tmpdir(), "contextbaton-norepo-"));
    try {
      await expect(runInit(notRepo)).rejects.toThrow(InitError);
      await expect(runInit(notRepo)).rejects.toThrow("git init");
    } finally {
      await rm(notRepo, { recursive: true, force: true });
    }
  });

  it("prints MCP setup for Claude Code and Cursor", async () => {
    const text = formatInitReport(await runInit(repo.root));
    expect(text).toContain("claude mcp add");
    expect(text).toContain(".cursor/mcp.json");
  });
});
