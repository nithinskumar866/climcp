import { headCommit } from "./git.js";
import { overwriteNoteFile, serializeNote, todayISO, writeNewNoteFile } from "./notes.js";
import { findSecrets, scrubSecrets, ScrubError, type SecretFinding } from "./scrubber.js";
import type { Note, NoteKind, NoteMeta, NoteStatus } from "./types.js";

// THE ONLY PLACE THAT WRITES NOTES.
//
// The CLI and the MCP server call saveNote() / updateNote() and nothing else.
// Both functions remove secrets from every field before anything touches the
// disk, so there is no way to save a note that skips the scrubber.
// (tests/store.test.ts checks that no other file calls the raw write functions.)

export interface NewNote {
  kind: NoteKind;
  title: string;
  body: string;
  author: string;
  related_files?: string[];
  commit?: string | null;
  status?: NoteStatus;
  /** Defaults to today. */
  date?: string;
}

export interface SaveResult {
  note: Note;
  /** The secrets that were removed (type, line, column only: never the secret itself). */
  redactions: (SecretFinding & { field: string })[];
}

/** Creates a new note, with secrets removed. */
export async function saveNote(repoRoot: string, input: NewNote): Promise<SaveResult> {
  if (!input.title.trim()) throw new Error("a note needs a title");

  const date = input.date ?? todayISO();
  const meta: NoteMeta = {
    title: input.title,
    author: input.author,
    date,
    status: input.status ?? "active",
    related_files: input.related_files ?? [],
    commit: input.commit ?? null,
    last_confirmed: date,
  };

  const clean = await scrubNote(meta, input.body);
  const note = await writeNewNoteFile(repoRoot, input.kind, clean.meta, clean.body);
  return { note, redactions: clean.redactions };
}

/**
 * Saves changes to a note that already exists (new status, confirmed date, edited text...).
 * The note keeps its file; secrets are removed again before writing.
 */
export async function updateNote(note: Note, changes: { meta?: Partial<NoteMeta>; body?: string }): Promise<SaveResult> {
  const meta = { ...note.meta, ...changes.meta };
  const body = changes.body ?? note.body;

  const clean = await scrubNote(meta, body);
  const updated: Note = { ...note, meta: clean.meta, body: clean.body };
  await overwriteNoteFile(updated);
  return { note: updated, redactions: clean.redactions };
}

/**
 * Marks a note as "still true": sets last_confirmed to today, moves its commit to
 * the current one, and makes it active again. Once this change is committed,
 * the outdated check starts counting from here.
 */
export async function confirmNote(root: string, note: Note, today: string = todayISO()): Promise<SaveResult> {
  const head = await headCommit(root);
  return updateNote(note, {
    meta: { last_confirmed: today, commit: head ?? note.meta.commit, status: "active" },
  });
}

// ---------- the scrubbing ----------

/**
 * Removes secrets from every text field of a note, one field at a time.
 * Then it checks the complete file text once more as a final safety net.
 */
async function scrubNote(
  meta: NoteMeta,
  body: string,
): Promise<{ meta: NoteMeta; body: string; redactions: SaveResult["redactions"] }> {
  const redactions: SaveResult["redactions"] = [];

  async function clean(field: string, text: string): Promise<string> {
    const result = await scrubSecrets(text);
    redactions.push(...result.findings.map((f) => ({ ...f, field })));
    return result.text;
  }

  const cleanMeta: NoteMeta = {
    ...meta,
    title: await clean("title", meta.title),
    author: await clean("author", meta.author),
    related_files: await Promise.all(meta.related_files.map((f, i) => clean(`related_files[${i}]`, f))),
  };
  const cleanBody = await clean("body", body);

  // Final safety net: scan the exact text that will go to disk.
  const leftovers = await findSecrets(serializeNote(cleanMeta, cleanBody));
  if (leftovers.length > 0) {
    throw new ScrubError(`refusing to save: ${leftovers.length} secret(s) still found after scrubbing`);
  }

  return { meta: cleanMeta, body: cleanBody, redactions };
}
