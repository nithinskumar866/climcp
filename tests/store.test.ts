import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveNote, updateNote } from "../src/core/store.js";
import { readNote, listNotes } from "../src/core/notes.js";
import { handoffBody } from "../src/core/templates.js";
import { FAKE_SECRETS } from "./fixtures/fake-secrets.js";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "contextbaton-store-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const ghToken = FAKE_SECRETS.find((s) => s.type === "github")!;

describe("saveNote", () => {
  it("DONE-CRITERION: no fake secret ever reaches the file on disk", async () => {
    const allSecrets = FAKE_SECRETS.map((s) => s.text).join("\n\n");
    const { note } = await saveNote(repo, {
      kind: "handoff",
      title: "Webhook work " + ghToken.secret,
      author: "nithin " + ghToken.secret,
      related_files: ["src/a.ts", ghToken.secret],
      body: handoffBody({ "Current state": allSecrets }),
    });

    // Read the raw bytes from disk: exactly what git would share.
    const onDisk = await readFile(note.path, "utf8");
    for (const fake of FAKE_SECRETS) {
      expect(onDisk, `${fake.name} leaked`).not.toContain(fake.secret);
    }
  });

  it("reports what was removed, and from which field", async () => {
    const { redactions } = await saveNote(repo, {
      kind: "handoff",
      title: "Deploy " + ghToken.secret,
      author: "nithin",
      body: "PASSWORD=" + "Tr0ub4dor" + "&3",
    });
    expect(redactions.map((r) => [r.field, r.type])).toEqual([
      ["title", "github"],
      ["body", "password"],
    ]);
  });

  it("a title that is ONLY a secret still makes a valid file", async () => {
    // "[REDACTED: github]" at the start of a YAML value could be read as a list.
    // This checks the file can still be read back correctly.
    const { note } = await saveNote(repo, { kind: "handoff", title: ghToken.secret, author: "a", body: "x" });
    const reloaded = await readNote(note.path, "handoff");
    expect(reloaded.meta.title).toBe("[REDACTED: github]");
  });

  it("the file name doesn't contain the secret either", async () => {
    const { note } = await saveNote(repo, { kind: "decision", title: ghToken.secret, author: "a", body: "x" });
    expect(note.fileName).not.toContain(ghToken.secret.slice(4));
  });

  it("fills in sensible defaults", async () => {
    const { note } = await saveNote(repo, {
      kind: "decision",
      title: "Use Postgres",
      author: "nithin",
      body: "Because of JSON support",
      date: "2026-11-19",
    });
    expect(note.meta).toEqual({
      title: "Use Postgres",
      author: "nithin",
      date: "2026-11-19",
      status: "active",
      related_files: [],
      commit: null,
      last_confirmed: "2026-11-19",
    });
    expect(note.path).toContain(join(".context", "decisions"));
  });

  it("refuses a note without a title", async () => {
    await expect(saveNote(repo, { kind: "handoff", title: "  ", author: "a", body: "x" })).rejects.toThrow("title");
  });

  it("clean notes are saved unchanged", async () => {
    const body = handoffBody({ Goal: "Fix retries" });
    const { note, redactions } = await saveNote(repo, { kind: "handoff", title: "Retries", author: "a", body });
    expect(redactions).toEqual([]);
    expect((await readNote(note.path, "handoff")).body).toBe(body.trim());
  });
});

describe("updateNote", () => {
  it("updates fields and keeps the same file", async () => {
    const { note } = await saveNote(repo, { kind: "handoff", title: "T", author: "a", body: "x", date: "2026-01-01" });
    const { note: updated } = await updateNote(note, { meta: { last_confirmed: "2026-11-19", status: "done" } });

    expect(updated.path).toBe(note.path);
    const reloaded = await readNote(note.path, "handoff");
    expect(reloaded.meta.last_confirmed).toBe("2026-11-19");
    expect(reloaded.meta.status).toBe("done");
    expect((await listNotes(repo, "handoff")).notes).toHaveLength(1);
  });

  it("removes secrets from the new text too", async () => {
    const { note } = await saveNote(repo, { kind: "handoff", title: "T", author: "a", body: "x" });
    await updateNote(note, { body: "now with " + ghToken.text });
    const onDisk = await readFile(note.path, "utf8");
    expect(onDisk).not.toContain(ghToken.secret);
    expect(onDisk).toContain("[REDACTED: github]");
  });

  it("a shorter new text leaves no leftovers from the old one", async () => {
    const { note } = await saveNote(repo, { kind: "handoff", title: "T", author: "a", body: "a long body ".repeat(50) });
    await updateNote(note, { body: "short" });
    expect((await readNote(note.path, "handoff")).body).toBe("short");
  });

  it("fails if the note file was deleted (never creates a stray file)", async () => {
    const { note } = await saveNote(repo, { kind: "handoff", title: "T", author: "a", body: "x" });
    await unlink(note.path);
    await expect(updateNote(note, { body: "y" })).rejects.toThrow();
  });
});

describe("safety rule: only store.ts writes notes", () => {
  it("no other source file calls the raw write functions", async () => {
    const srcDir = join(import.meta.dirname, "..", "src");
    const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const normalized = file.replace(/\\/g, "/");
      if (normalized === "core/notes.ts" || normalized === "core/store.ts") continue;
      const text = await readFile(join(srcDir, file), "utf8");
      if (/\b(writeNewNoteFile|overwriteNoteFile)\b/.test(text)) offenders.push(normalized);
    }
    expect(offenders, "these files must use saveNote()/updateNote() instead").toEqual([]);
  });
});
