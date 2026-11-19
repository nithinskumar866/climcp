import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { runSave, snapshotGit, relatedFiles, buildHandoff, type Ask } from "../src/commands/save.js";
import { readNote } from "../src/core/notes.js";
import { createTempRepo, lines, type TempRepo } from "./helpers/temp-repo.js";
import { FAKE_SECRETS } from "./fixtures/fake-secrets.js";

let repo: TempRepo;
beforeEach(async () => {
  repo = await createTempRepo();
  await repo.write("src/webhook.ts", lines(10));
  await repo.write("src/old.ts", lines(10));
  repo.commit("add webhook");
});
afterEach(async () => {
  await repo.cleanup();
});

/** A fake person: answers each question with the next prepared answer, and remembers what was asked. */
function fakePerson(answers: string[]): Ask & { asked: string[] } {
  const asked: string[] = [];
  const ask = (async (q: string) => {
    asked.push(q);
    return answers.shift() ?? "";
  }) as Ask & { asked: string[] };
  ask.asked = asked;
  return ask;
}

describe("contextbaton save", () => {
  it("asks the quick questions and saves a filled-in handoff", async () => {
    repo.git("checkout", "-q", "-b", "feature/payments");
    await repo.write("src/webhook.ts", lines(15)); // uncommitted change

    const person = fakePerson(["Payment webhook retries", "Added retry with backoff", "Test duplicate events", ""]);
    const { note } = await runSave(repo.root, { given: {}, ask: person });

    expect(person.asked).toHaveLength(4);
    expect(person.asked[0]).toContain("feature/payments"); // suggested title
    expect(note.fileName).toMatch(/^\d{4}-\d{2}-\d{2}-payment-webhook-retries\.md$/);

    const saved = await readNote(note.path, "handoff");
    expect(saved.meta).toMatchObject({
      title: "Payment webhook retries",
      author: "Test Person",
      status: "active",
      related_files: ["src/webhook.ts"],
      commit: repo.git("rev-parse", "--short", "HEAD").trim(),
    });
    expect(saved.body).toContain("## What's done\n\nAdded retry with backoff");
    expect(saved.body).toContain("## Next step\n\nTest duplicate events");
    expect(saved.body).toContain("- `src/webhook.ts` (modified)");
    expect(saved.body).toMatch(/## Current state\n\nGit state when this note was saved \(\d{4}-\d{2}-\d{2}\):\n- Branch: `feature\/payments`/);
    expect(saved.body).toContain("add webhook"); // recent commit
    expect(saved.body).toContain("## Risks and warnings\n\n_(not filled in)_"); // skipped
  });

  it("pressing Enter on the title uses the suggestion", async () => {
    repo.git("checkout", "-q", "-b", "fix/login");
    const { note } = await runSave(repo.root, { given: {}, ask: fakePerson([]) });
    expect(note.meta.title).toBe("fix/login");
  });

  it("doesn't ask what was already given as a flag", async () => {
    const person = fakePerson(["did stuff", "next", ""]);
    const { note } = await runSave(repo.root, { given: { title: "From flag" }, ask: person });
    expect(person.asked).toHaveLength(3);
    expect(note.meta.title).toBe("From flag");
  });

  it("--yes mode: no questions, defaults used, missing flags don't break the title", async () => {
    const { note } = await runSave(repo.root, {
      given: { title: undefined, next: "Ship it" },
      ask: null,
    });
    expect(note.meta.title).toBe("Handoff"); // on main, so the generic title
    expect(note.body).toContain("## Next step\n\nShip it");
  });

  it("removes secrets typed into the answers", async () => {
    const pw = FAKE_SECRETS.find((s) => s.type === "password")!;
    const { note, redactions } = await runSave(repo.root, {
      given: {},
      ask: fakePerson(["Deploy", `used ${pw.text} on staging`, "", ""]),
    });
    expect(await readFile(note.path, "utf8")).not.toContain(pw.secret);
    expect(redactions.map((r) => r.type)).toEqual(["password"]);
  });

  it("fails clearly outside a git repo", async () => {
    await expect(runSave(join(repo.root, "..", ".."), { given: {}, ask: null })).rejects.toThrow(/git/);
  });
});

describe("which files the note is about", () => {
  it("uses uncommitted work, but not deleted files and not .context/ itself", async () => {
    await repo.write("src/webhook.ts", "changed");
    await repo.write("src/new.ts", "new");
    await unlink(join(repo.root, "src", "old.ts"));
    await repo.write(".context/handoffs/2026-01-01-x.md", "a note");

    const git = await snapshotGit(repo.root);
    expect(relatedFiles(git)).toEqual(["src/new.ts", "src/webhook.ts"]);
    expect(git.changes.map((c) => c.path)).not.toContain(".context/handoffs/2026-01-01-x.md");
  });

  it("with nothing uncommitted, uses the files of the latest commit", async () => {
    await repo.write("src/api.ts", "x");
    repo.commit("add api");
    expect(relatedFiles(await snapshotGit(repo.root))).toEqual(["src/api.ts"]);
  });

  it("says so when there are no uncommitted changes", async () => {
    const git = await snapshotGit(repo.root);
    const { body } = buildHandoff(git, { title: "t", done: "", next: "", risks: "" });
    expect(body).toContain("## Files changed\n\nNo uncommitted changes.");
  });
});
