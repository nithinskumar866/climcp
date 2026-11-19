import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkNote, checkAllNotes, describeReason, daysBetween } from "../src/core/staleness.js";
import { confirmNote, saveNote, updateNote } from "../src/core/store.js";
import type { Note } from "../src/core/types.js";
import { createTempRepo, lines, type TempRepo } from "./helpers/temp-repo.js";

let repo: TempRepo;
beforeEach(async () => {
  repo = await createTempRepo();
  await repo.write("src/webhook.ts", lines(20));
  await repo.write("src/retry.ts", lines(20));
  await repo.write("src/other.ts", lines(20));
  repo.commit("base code");
});
afterEach(async () => {
  await repo.cleanup();
});

const TODAY = "2026-11-19";

/** Saves a note about webhook.ts + retry.ts, the way `contextbaton save` would. */
async function saveWebhookNote(extra: { date?: string; status?: "active" | "done" } = {}): Promise<Note> {
  const { note } = await saveNote(repo.root, {
    kind: "handoff",
    title: "Webhook retries",
    author: "Test Person",
    body: "notes",
    related_files: ["src/webhook.ts", "src/retry.ts"],
    commit: repo.git("rev-parse", "--short", "HEAD").trim(),
    date: extra.date ?? TODAY,
    status: extra.status,
  });
  return note;
}

const check = (note: Note) => checkNote(repo.root, note, { today: TODAY });

describe("DONE-CRITERION: changing a related file flags the note", () => {
  it("fresh note: not outdated; after 60 changed lines: outdated", async () => {
    const note = await saveWebhookNote();
    repo.commit("code + note");
    expect((await check(note)).outdated).toBe(false);

    await repo.write("src/webhook.ts", lines(20) + lines(60, "new"));
    repo.commit("big change");

    const result = await check(note);
    expect(result.outdated).toBe(true);
    expect(result.reasons).toEqual([
      expect.objectContaining({ kind: "files-changed", lines: 60, files: [{ path: "src/webhook.ts", added: 60, removed: 0 }] }),
    ]);
  });
});

describe("the 50-line rule", () => {
  it("50 lines or fewer is fine; changes across related files add up", async () => {
    const note = await saveWebhookNote();
    repo.commit("code + note");

    await repo.write("src/webhook.ts", lines(20) + lines(30, "a")); // +30
    repo.commit("small change");
    expect((await check(note)).outdated).toBe(false);

    await repo.write("src/retry.ts", lines(20) + lines(21, "b")); // +21, not committed yet
    const result = await check(note);
    expect(result.outdated).toBe(true); // 51 > 50, and uncommitted work counts too
    expect(result.reasons[0]).toMatchObject({ kind: "files-changed", lines: 51 });
  });

  it("changes to files the note is NOT about don't count", async () => {
    const note = await saveWebhookNote();
    repo.commit("code + note");
    await repo.write("src/other.ts", lines(500, "x"));
    repo.commit("unrelated");
    expect((await check(note)).outdated).toBe(false);
  });

  it("binary files don't count as lines", async () => {
    await repo.write("logo.png", "\x00\x01");
    repo.commit("logo");
    const { note } = await saveNote(repo.root, {
      kind: "handoff", title: "Logo", author: "a", body: "x", related_files: ["logo.png"], date: TODAY,
    });
    repo.commit("note");
    await repo.write("logo.png", "\x00" + "\x02".repeat(5000));
    expect((await check(note)).outdated).toBe(false);
  });
});

describe("the problem we designed around", () => {
  it("a note saved with lots of uncommitted work is NOT outdated straight away", async () => {
    await repo.write("src/webhook.ts", lines(20) + lines(100, "wip")); // 100 lines, not committed
    const note = await saveWebhookNote();

    // Before committing: the note itself is uncommitted, so it's "being worked on".
    expect((await check(note)).outdated).toBe(false);

    // After committing code + note together: the note's commit already contains the 100 lines.
    repo.commit("feature + handoff");
    expect((await check(note)).outdated).toBe(false);
  });

  it("confirming the note and committing resets the count", async () => {
    const note = await saveWebhookNote();
    repo.commit("code + note");
    await repo.write("src/webhook.ts", lines(20) + lines(80, "new"));
    repo.commit("big change");
    expect((await check(note)).outdated).toBe(true);

    // Confirmed on the SAME day it was written: the commit field still changes, so there's something to commit.
    const { note: confirmed } = await confirmNote(repo.root, note, TODAY);
    expect(confirmed.meta.commit).toBe(repo.git("rev-parse", "--short", "HEAD").trim());
    expect((await check(confirmed)).outdated).toBe(false); // edited, not yet committed: being worked on
    repo.commit("confirm note");
    expect((await check(confirmed)).outdated).toBe(false); // new starting point

    // ...and later changes are counted from there.
    await repo.write("src/webhook.ts", lines(20) + lines(80, "new") + lines(51, "more"));
    expect((await check(confirmed)).outdated).toBe(true);
  });

  it("confirming an old note resets the 90-day clock and makes it active again", async () => {
    const note = await saveWebhookNote({ date: "2026-01-01" });
    repo.commit("note");
    const { note: marked } = await updateNote(note, { meta: { status: "outdated" } });
    repo.commit("mark outdated");

    const { note: confirmed } = await confirmNote(repo.root, marked, TODAY);
    expect(confirmed.meta).toMatchObject({ status: "active", last_confirmed: TODAY });
    expect((await check(confirmed)).outdated).toBe(false);
  });

  it("falls back to the note's `commit` field when the note isn't in git history", async () => {
    await writeFile(join(repo.root, ".gitignore"), ".context/\n");
    repo.commit("ignore notes");
    const note = await saveWebhookNote(); // ignored: never committed, never "uncommitted"
    await repo.write("src/webhook.ts", lines(20) + lines(60, "new"));
    repo.commit("big change");

    const result = await check(note);
    expect(result.baseline).toBe(note.meta.commit);
    expect(result.outdated).toBe(true);
  });
});

describe("other reasons", () => {
  it("a deleted related file makes the note outdated", async () => {
    const note = await saveWebhookNote();
    repo.commit("code + note");
    await unlink(join(repo.root, "src", "retry.ts"));

    const result = await check(note);
    expect(result.outdated).toBe(true);
    expect(result.reasons).toContainEqual({ kind: "file-deleted", path: "src/retry.ts" });
  });

  it("not confirmed for more than 90 days", async () => {
    const note = await saveWebhookNote({ date: "2026-08-20" }); // exactly 91 days before TODAY
    repo.commit("note");
    expect((await check(note)).reasons).toEqual([{ kind: "not-confirmed", days: 91 }]);
  });

  it("exactly 90 days is still fine", async () => {
    const note = await saveWebhookNote({ date: "2026-08-21" });
    repo.commit("note");
    expect((await check(note)).outdated).toBe(false);
  });
});

describe("checkAllNotes", () => {
  it("only checks active notes", async () => {
    await saveWebhookNote({ date: "2025-01-01" }); // old + active  -> checked
    await saveWebhookNote({ date: "2025-01-01", status: "done" }); // old + done -> skipped
    repo.commit("notes");
    const results = await checkAllNotes(repo.root, { today: TODAY });
    expect(results).toHaveLength(1);
    expect(results[0].note.meta.status).toBe("active");
    expect(results[0].outdated).toBe(true);
  });
});

describe("helpers", () => {
  it("explains reasons in plain words", () => {
    expect(
      describeReason({
        kind: "files-changed", lines: 73, since: "abc1234",
        files: [{ path: "a.ts", added: 40, removed: 30 }, { path: "b.ts", added: 3, removed: 0 }],
      }),
    ).toBe("related files changed by 73 lines since abc1234 (a.ts +40 -30, b.ts +3 -0)");
    expect(describeReason({ kind: "file-deleted", path: "x.ts" })).toBe("related file was deleted: x.ts");
    expect(describeReason({ kind: "not-confirmed", days: 120 })).toBe("not confirmed for 120 days");
  });

  it("counts days correctly across months and years", () => {
    expect(daysBetween("2026-11-19", "2026-11-19")).toBe(0);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2); // leap year
  });
});
