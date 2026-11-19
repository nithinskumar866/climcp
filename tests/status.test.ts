import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runStatus, formatStatus, runConfirm, formatConfirm } from "../src/commands/status.js";
import { findNote, getSection, latestActiveHandoff, NoteNotFoundError } from "../src/core/query.js";
import { saveNote } from "../src/core/store.js";
import { handoffBody } from "../src/core/templates.js";
import type { NoteStatus } from "../src/core/types.js";
import { createTempRepo, lines, type TempRepo } from "./helpers/temp-repo.js";

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

function handoff(title: string, opts: { date?: string; status?: NoteStatus; next?: string; files?: string[] } = {}) {
  return saveNote(repo.root, {
    kind: "handoff",
    title,
    author: "Priya",
    date: opts.date ?? TODAY,
    status: opts.status,
    related_files: opts.files ?? [],
    body: handoffBody({ "Next step": opts.next ?? "", "Risks and warnings": "" }),
  });
}

describe("contextbaton status", () => {
  it("with no notes, says how to start", async () => {
    const text = formatStatus(await runStatus(repo.root, { today: TODAY }));
    expect(text).toContain("No active handoff yet");
    expect(text).toContain("0 handoff(s), 0 decision(s)");
  });

  it("shows the newest ACTIVE handoff and its next step", async () => {
    await handoff("Older work", { date: "2026-11-10", next: "old next" });
    await handoff("Current work", { date: "2026-11-18", next: "Test duplicate events" });
    await handoff("Finished thing", { date: "2026-11-19", status: "done" }); // newer, but done

    const text = formatStatus(await runStatus(repo.root, { today: TODAY }));
    expect(text).toContain('Latest handoff: "Current work"');
    expect(text).toContain("Priya, 2026-11-18");
    expect(text).toContain("Next step:\n    Test duplicate events");
    expect(text).not.toContain("Risks and warnings:"); // empty sections are hidden
    expect(text).toContain("3 handoff(s), 0 decision(s)");
  });

  it("warns loudly when the latest handoff is outdated", async () => {
    await handoff("Webhook", { files: ["src/webhook.ts"] });
    repo.commit("note");
    await repo.write("src/webhook.ts", lines(20) + lines(70, "new"));

    const text = formatStatus(await runStatus(repo.root, { today: TODAY }));
    expect(text).toContain("POSSIBLY OUTDATED");
    expect(text).toContain("related files changed by 70 lines");
    expect(text).toContain("contextbaton confirm");
  });

  it("lists other outdated notes separately", async () => {
    await handoff("Ancient", { date: "2025-01-01" });
    await handoff("Fresh", { date: TODAY });
    repo.commit("notes");
    const report = await runStatus(repo.root, { today: TODAY });
    const text = formatStatus(report);
    expect(text).toContain('Latest handoff: "Fresh"');
    expect(text).toContain('Possibly outdated notes:\n  ! .context/handoffs/2025-01-01-ancient.md  "Ancient"');
    expect(text).toContain("not confirmed for");
  });
});

describe("contextbaton confirm", () => {
  it("confirms by the start of a file name, and the note stops being outdated", async () => {
    await handoff("Ancient", { date: "2025-01-01" });
    repo.commit("note");
    expect((await runStatus(repo.root, { today: TODAY })).outdated).toHaveLength(1);

    const result = await runConfirm(repo.root, "2025-01-01-anc", { today: TODAY });
    expect(result.note.meta.last_confirmed).toBe(TODAY);
    expect(formatConfirm(result)).toContain('✓ Confirmed "Ancient"');

    repo.commit("confirm");
    expect((await runStatus(repo.root, { today: TODAY })).outdated).toHaveLength(0);
  });
});

describe("finding a note by name", () => {
  beforeEach(async () => {
    await handoff("Payment webhook", { date: "2026-11-19" });
    await handoff("Payment refunds", { date: "2026-11-19" });
  });

  it.each([
    ["full file name", "2026-11-19-payment-webhook.md"],
    ["file name without .md", "2026-11-19-payment-webhook"],
    ["path from the repo root", ".context/handoffs/2026-11-19-payment-webhook.md"],
    ["Windows-style path", ".context\\handoffs\\2026-11-19-payment-webhook.md"],
    ["unique start of the name", "2026-11-19-payment-w"],
  ])("by %s", async (_name, ref) => {
    expect((await findNote(repo.root, ref)).meta.title).toBe("Payment webhook");
  });

  it("asks you to be more specific when several match", async () => {
    await expect(findNote(repo.root, "2026-11-19-payment")).rejects.toThrow(/matches 2 notes/);
  });

  it("says when nothing matches", async () => {
    await expect(findNote(repo.root, "nope")).rejects.toThrow(NoteNotFoundError);
  });
});

describe("helpers", () => {
  it("getSection reads one section, and treats the placeholder as empty", () => {
    const body = handoffBody({ Goal: "Fix it\nproperly", "Next step": "" });
    expect(getSection(body, "Goal")).toBe("Fix it\nproperly");
    expect(getSection(body, "Next step")).toBe("");
    expect(getSection(body, "No such section")).toBe("");
  });

  it("latestActiveHandoff is null when every handoff is done", async () => {
    await handoff("Done", { status: "done" });
    expect(await latestActiveHandoff(repo.root)).toBeNull();
  });
});
