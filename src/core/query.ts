import { relative } from "node:path";
import { listNotes } from "./notes.js";
import type { Note, NoteKind } from "./types.js";

// Read-only questions about notes, shared by the CLI and the MCP server.

/** All notes of the given kinds (default: both), newest first. Broken files are skipped. */
export async function allNotes(root: string, kinds: NoteKind[] = ["handoff", "decision"]): Promise<Note[]> {
  const notes: Note[] = [];
  for (const kind of kinds) notes.push(...(await listNotes(root, kind)).notes);
  return notes.sort((a, b) => b.meta.date.localeCompare(a.meta.date) || b.fileName.localeCompare(a.fileName));
}

/** The newest handoff whose status is "active", or null if there is none. */
export async function latestActiveHandoff(root: string): Promise<Note | null> {
  const { notes } = await listNotes(root, "handoff"); // already newest first
  return notes.find((n) => n.meta.status === "active") ?? null;
}

export class NoteNotFoundError extends Error {}

/**
 * Finds one note from what a person types: a file name, a path, or the start of a file name.
 *   "2026-11-19-payment-webhook.md", ".context/handoffs/2026-11-19-payment-webhook.md", "2026-11-19-pay"
 */
export async function findNote(root: string, ref: string): Promise<Note> {
  const wanted = ref.replace(/\\/g, "/").replace(/^\.\//, "");
  const notes = await allNotes(root);
  const relPath = (n: Note) => relative(root, n.path).replace(/\\/g, "/");

  const exact = notes.filter((n) => n.fileName === wanted || relPath(n) === wanted || n.fileName === `${wanted}.md`);
  const matches = exact.length > 0 ? exact : notes.filter((n) => n.fileName.startsWith(wanted));

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new NoteNotFoundError(`No note matches "${ref}".`);
  throw new NoteNotFoundError(
    `"${ref}" matches ${matches.length} notes, please be more specific:\n` + matches.map((n) => `  ${relPath(n)}`).join("\n"),
  );
}

export interface SearchOptions {
  kinds?: NoteKind[];
  /** Also search notes whose status is "done" or "outdated". Default: only active notes. */
  includeInactive?: boolean;
  limit?: number;
}

/**
 * Simple word search: a note matches if EVERY word of the query appears in its
 * title, body or related files (ignoring upper/lower case). Title matches rank higher.
 * An empty query returns the newest notes.
 */
export async function searchNotes(root: string, query: string, opts: SearchOptions = {}): Promise<Note[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const notes = (await allNotes(root, opts.kinds)).filter((n) => opts.includeInactive || n.meta.status === "active");

  const scored = notes
    .map((note, index) => {
      const title = note.meta.title.toLowerCase();
      const text = `${title}\n${note.body}\n${note.meta.related_files.join("\n")}`.toLowerCase();
      if (!words.every((w) => text.includes(w))) return null;
      // 3 points for a word in the title, plus 1 per time it appears anywhere.
      const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 0) + text.split(w).length - 1, 0);
      return { note, score, index };
    })
    .filter((x): x is { note: Note; score: number; index: number } => x !== null);

  // Best score first; on a tie, keep newest first.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, opts.limit ?? 10).map((x) => x.note);
}

/** The text under one "## Heading" of a note body ("" if missing or not filled in). */
export function getSection(body: string, heading: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const text = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return text === "_(not filled in)_" ? "" : text;
}
