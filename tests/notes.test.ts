import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugify,
  todayISO,
  serializeNote,
  parseNote,
  writeNewNoteFile,
  listNotes,
  NoteFormatError,
} from "../src/core/notes.js";
import { handoffBody, decisionBody, HANDOFF_SECTIONS, PLACEHOLDER } from "../src/core/templates.js";
import type { NoteMeta } from "../src/core/types.js";

function sampleMeta(overrides: Partial<NoteMeta> = {}): NoteMeta {
  return {
    title: "Payment webhook",
    author: "nithin",
    date: "2026-11-19",
    status: "active",
    related_files: ["src/payments/webhook.ts"],
    commit: "abc1234",
    last_confirmed: "2026-11-19",
    ...overrides,
  };
}

describe("templates", () => {
  it("a handoff has all 9 sections, in order", () => {
    const body = handoffBody();
    const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([...HANDOFF_SECTIONS]);
  });

  it("uses filled-in text and a placeholder for the rest", () => {
    const body = handoffBody({ Goal: "Fix retries" });
    expect(body).toContain("## Goal\n\nFix retries");
    expect(body).toContain(`## Next step\n\n${PLACEHOLDER}`);
  });

  it("a decision has its own sections", () => {
    expect(decisionBody()).toContain("## Why");
  });
});

describe("slugify", () => {
  it("makes a safe file name", () => {
    expect(slugify("Payment Webhook: retries!")).toBe("payment-webhook-retries");
  });
  it("never returns an empty string", () => {
    expect(slugify("!!!")).toBe("note");
  });
  it("keeps names short", () => {
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(50);
  });
});

describe("todayISO", () => {
  it("formats a date as YYYY-MM-DD", () => {
    expect(todayISO(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("serialize and parse", () => {
  it("round-trips: what we write is what we read back", () => {
    const meta = sampleMeta();
    const text = serializeNote(meta, handoffBody({ Goal: "Fix retries" }));
    const parsed = parseNote(text);
    expect(parsed.meta).toEqual(meta);
    expect(parsed.body).toContain("Fix retries");
  });

  it("keeps dates as plain text, not date objects", () => {
    const { meta } = parseNote(serializeNote(sampleMeta(), "body"));
    expect(typeof meta.date).toBe("string");
    expect(typeof meta.last_confirmed).toBe("string");
  });

  it("fills in safe defaults for optional fields", () => {
    const { meta } = parseNote("---\ntitle: Hi\ndate: 2026-11-19\n---\nbody");
    expect(meta).toMatchObject({
      author: "unknown",
      status: "active",
      related_files: [],
      commit: null,
      last_confirmed: "2026-11-19",
    });
  });

  it("works with Windows line endings", () => {
    const { meta } = parseNote("---\r\ntitle: Hi\r\ndate: 2026-11-19\r\n---\r\nbody");
    expect(meta.title).toBe("Hi");
  });

  it.each([
    ["no frontmatter", "just text"],
    ["missing title", "---\ndate: 2026-11-19\n---\n"],
    ["bad date", "---\ntitle: Hi\ndate: yesterday\n---\n"],
    ["bad status", "---\ntitle: Hi\ndate: 2026-11-19\nstatus: maybe\n---\n"],
    ["bad yaml", "---\ntitle: [unclosed\ndate: 2026-11-19\n---\n"],
  ])("rejects a broken note: %s", (_name, text) => {
    expect(() => parseNote(text)).toThrow(NoteFormatError);
  });
});

describe("writing and listing notes on disk", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "contextbaton-test-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("writes into .context/handoffs with a date-slug file name", async () => {
    const note = await writeNewNoteFile(repo, "handoff", sampleMeta(), handoffBody());
    expect(note.fileName).toBe("2026-11-19-payment-webhook.md");
    const text = await readFile(join(repo, ".context", "handoffs", note.fileName), "utf8");
    expect(text.startsWith("---\ntitle: Payment webhook\n")).toBe(true);
  });

  it("never overwrites: a second note with the same name gets -2", async () => {
    const first = await writeNewNoteFile(repo, "handoff", sampleMeta(), "first");
    const second = await writeNewNoteFile(repo, "handoff", sampleMeta(), "second");
    expect(second.fileName).toBe("2026-11-19-payment-webhook-2.md");
    expect(await readFile(first.path, "utf8")).toContain("first");
  });

  it("lists notes newest first", async () => {
    await writeNewNoteFile(repo, "handoff", sampleMeta({ title: "Old", date: "2026-01-01" }), "x");
    await writeNewNoteFile(repo, "handoff", sampleMeta({ title: "New", date: "2026-11-19" }), "x");
    const { notes } = await listNotes(repo, "handoff");
    expect(notes.map((n) => n.meta.title)).toEqual(["New", "Old"]);
  });

  it("keeps handoffs and decisions apart", async () => {
    await writeNewNoteFile(repo, "decision", sampleMeta({ title: "Use Postgres" }), decisionBody());
    expect((await listNotes(repo, "handoff")).notes).toHaveLength(0);
    expect((await listNotes(repo, "decision")).notes).toHaveLength(1);
  });

  it("returns an empty list when .context doesn't exist yet", async () => {
    expect(await listNotes(repo, "handoff")).toEqual({ notes: [], broken: [] });
  });

  it("reports a broken file without hiding the good ones", async () => {
    await writeNewNoteFile(repo, "handoff", sampleMeta(), "good");
    const dir = join(repo, ".context", "handoffs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-11-18-broken.md"), "no frontmatter here");
    const { notes, broken } = await listNotes(repo, "handoff");
    expect(notes).toHaveLength(1);
    expect(broken).toEqual([
      { fileName: "2026-11-18-broken.md", error: expect.stringContaining("missing frontmatter") },
    ]);
  });
});
