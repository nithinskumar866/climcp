import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runCheck, exitCodeFor, formatCheckReport } from "../src/commands/check.js";
import { loadConfig, ConfigError, DEFAULT_CONFIG } from "../src/core/config.js";
import { saveNote } from "../src/core/store.js";
import { serializeNote } from "../src/core/notes.js";
import type { NoteMeta } from "../src/core/types.js";
import { createTempRepo, lines, type TempRepo } from "./helpers/temp-repo.js";
import { FAKE_SECRETS } from "./fixtures/fake-secrets.js";

let repo: TempRepo;
beforeEach(async () => {
  repo = await createTempRepo();
  await repo.write("src/webhook.ts", lines(20));
  repo.commit("base");
});
afterEach(async () => {
  await repo.cleanup();
});

const TODAY = "2026-11-19";
const gh = FAKE_SECRETS.find((s) => s.type === "github")!;
const key = FAKE_SECRETS.find((s) => s.type === "privatekey")!;

const meta = (extra: Partial<NoteMeta> = {}): NoteMeta => ({
  title: "Hand-written note",
  author: "a",
  date: TODAY,
  status: "active",
  related_files: [],
  commit: null,
  last_confirmed: TODAY,
  ...extra,
});

/** Writes a note file directly, the way a person editing by hand might (skipping contextbaton). */
async function handWrite(name: string, text: string): Promise<string> {
  const path = join(repo.root, ".context", "handoffs", name);
  await mkdir(join(repo.root, ".context", "handoffs"), { recursive: true });
  await writeFile(path, text);
  return path;
}

const check = (hook = false) => runCheck(repo.root, { today: TODAY, hook });

describe("contextbaton check: secrets", () => {
  it("all clean: exit code 0 and a short summary", async () => {
    await saveNote(repo.root, { kind: "handoff", title: "Fine", author: "a", body: "nothing secret", date: TODAY });
    const report = await check();
    expect(exitCodeFor(report)).toBe(0);
    expect(formatCheckReport(report)).toBe("✓ 1 note checked: no secrets, none outdated.");
  });

  it("removes a secret someone typed into a note by hand, and exits with 1", async () => {
    const path = await handWrite("2026-11-19-x.md", serializeNote(meta(), `## Goal\n\nuse ${gh.text}`));
    const report = await check();

    expect(exitCodeFor(report)).toBe(1);
    expect(report.secrets).toEqual([
      { file: ".context/handoffs/2026-11-19-x.md", findings: [expect.objectContaining({ type: "github" })] },
    ]);
    const onDisk = await readFile(path, "utf8");
    expect(onDisk).not.toContain(gh.secret);
    expect(onDisk).toContain("use token: [REDACTED: github]");
  });

  it("finds a secret hidden in a YAML comment (which the parser would skip)", async () => {
    const text = serializeNote(meta(), "body").replace("---\n", `---\n# ${gh.text}\n`);
    const path = await handWrite("2026-11-19-comment.md", text);
    expect(exitCodeFor(await check())).toBe(1);
    expect(await readFile(path, "utf8")).not.toContain(gh.secret);
  });

  it("cleans a BROKEN note file too, leaving no leftover bytes of a long secret", async () => {
    const path = await handWrite("2026-11-19-broken.md", `no frontmatter at all\n${key.secret}\n`);
    const report = await check();

    expect(report.broken).toHaveLength(1);
    expect(exitCodeFor(report)).toBe(1);
    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toBe("no frontmatter at all\n[REDACTED: privatekey]\n");
    expect(onDisk).not.toContain(key.secret.slice(-40)); // the end of the key is gone too
  });

  it("the error message never shows the secret", async () => {
    await handWrite("2026-11-19-x.md", serializeNote(meta(), gh.text));
    expect(formatCheckReport(await check())).not.toContain(gh.secret);
  });
});

describe("contextbaton check: outdated notes", () => {
  it("lists outdated notes with the reason, but exits 0 (a warning, not an error)", async () => {
    await saveNote(repo.root, {
      kind: "handoff", title: "Webhook", author: "a", body: "x",
      related_files: ["src/webhook.ts"], date: TODAY,
    });
    repo.commit("note");
    await repo.write("src/webhook.ts", lines(20) + lines(60, "new"));

    const report = await check();
    expect(exitCodeFor(report)).toBe(0);
    expect(report.outdated).toHaveLength(1);
    const text = formatCheckReport(report);
    expect(text).toContain('"Webhook"');
    expect(text).toContain("related files changed by 60 lines");
    expect(text).toContain("1 possibly outdated");
  });

  it("uses the limits from .context/config.json", async () => {
    await saveNote(repo.root, {
      kind: "handoff", title: "Webhook", author: "a", body: "x",
      related_files: ["src/webhook.ts"], date: TODAY,
    });
    repo.commit("note");
    await repo.write("src/webhook.ts", lines(20) + lines(20, "new")); // 20 lines: fine by default

    expect((await check()).outdated).toHaveLength(0);
    await writeFile(join(repo.root, ".context", "config.json"), '{ "outdated": { "maxChangedLines": 10 } }');
    expect((await check()).outdated).toHaveLength(1);
  });
});

describe("contextbaton check --hook (before a commit)", () => {
  it("stops the commit when the STAGED copy has a secret, until it's added again", async () => {
    await handWrite("2026-11-19-x.md", serializeNote(meta(), gh.text));
    repo.git("add", ".context");

    // First run: cleans the file on disk, but the staged copy still has the secret.
    const first = await check(true);
    expect(exitCodeFor(first)).toBe(1);
    expect(first.stagedSecrets.map((s) => s.file)).toEqual([".context/handoffs/2026-11-19-x.md"]);
    expect(formatCheckReport(first, { hook: true })).toContain("git add .context");

    // Still blocked if you forget to `git add` the cleaned file.
    const second = await check(true);
    expect(exitCodeFor(second)).toBe(1);
    expect(second.secrets).toEqual([]); // the file on disk is already clean
    expect(second.stagedSecrets).toHaveLength(1);

    // After `git add`, the commit may go ahead.
    repo.git("add", ".context");
    expect(exitCodeFor(await check(true))).toBe(0);
  });

  it("without --hook, staged copies are not looked at", async () => {
    await handWrite("2026-11-19-x.md", serializeNote(meta(), gh.text));
    repo.git("add", ".context");
    await check(); // cleans the file on disk
    expect((await check()).stagedSecrets).toEqual([]);
  });
});

describe("config file", () => {
  it("missing file = defaults", async () => {
    expect(await loadConfig(repo.root)).toEqual(DEFAULT_CONFIG);
  });

  it("a partial file keeps the other defaults", async () => {
    await mkdir(join(repo.root, ".context"), { recursive: true });
    await writeFile(join(repo.root, ".context", "config.json"), '{ "outdated": { "maxDaysUnconfirmed": 30 } }');
    expect((await loadConfig(repo.root)).outdated).toEqual({ maxChangedLines: 50, maxDaysUnconfirmed: 30 });
  });

  it.each([
    ["not JSON", "{ oops"],
    ["a word instead of a number", '{ "outdated": { "maxChangedLines": "fifty" } }'],
    ["a negative number", '{ "outdated": { "maxChangedLines": -1 } }'],
  ])("explains a mistake: %s", async (_name, text) => {
    await mkdir(join(repo.root, ".context"), { recursive: true });
    await writeFile(join(repo.root, ".context", "config.json"), text);
    await expect(loadConfig(repo.root)).rejects.toThrow(ConfigError);
  });
});
