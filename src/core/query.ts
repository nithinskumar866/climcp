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
