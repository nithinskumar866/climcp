import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { commitExists, hasUncommittedChanges, lastCommitTouching, lineChangesSince } from "./git.js";
import { listNotes, todayISO } from "./notes.js";
import type { Note } from "./types.js";

// Finds notes that might be out of date. A note is "possibly outdated" if:
//   1. its related files changed by more than 50 lines since the note was last committed, or
//   2. one of its related files was deleted, or
//   3. nobody has confirmed it in 90 days.
//
// Why "since the note was last committed"? People usually save a note and then
// commit it together with the code. So that commit is the version of the code
// the note describes. Confirming or editing a note and committing it again
// moves this starting point forward, so the counting starts over.

export interface StalenessRules {
  /** More changed lines (added + removed) than this across related files = outdated. */
  maxChangedLines: number;
  /** More days than this since last_confirmed = outdated. */
  maxDaysUnconfirmed: number;
}

export const DEFAULT_RULES: StalenessRules = { maxChangedLines: 50, maxDaysUnconfirmed: 90 };

export type StaleReason =
  | { kind: "files-changed"; lines: number; since: string; files: { path: string; added: number; removed: number }[] }
  | { kind: "file-deleted"; path: string }
  | { kind: "not-confirmed"; days: number };

export interface Freshness {
  note: Note;
  outdated: boolean;
  reasons: StaleReason[];
  /** The commit we counted changes from (null if none could be used). */
  baseline: string | null;
}

export interface CheckOptions {
  rules?: StalenessRules;
  /** "Today" as YYYY-MM-DD; tests set this to pretend time has passed. */
  today?: string;
}

/** Checks one note. */
export async function checkNote(root: string, note: Note, opts: CheckOptions = {}): Promise<Freshness> {
  const rules = opts.rules ?? DEFAULT_RULES;
  const today = opts.today ?? todayISO();
  const reasons: StaleReason[] = [];

  // Rule 3: not confirmed for too long.
  const days = daysBetween(note.meta.last_confirmed, today);
  if (days > rules.maxDaysUnconfirmed) reasons.push({ kind: "not-confirmed", days });

  // Rule 2: a related file is gone.
  const existing: string[] = [];
  for (const file of note.meta.related_files) {
    if (existsSync(join(root, file))) existing.push(file);
    else reasons.push({ kind: "file-deleted", path: file });
  }

  // Rule 1: related files changed a lot.
  const baseline = await findBaseline(root, note);
  if (baseline && existing.length > 0) {
    const changes = await lineChangesSince(root, baseline, existing);
    const files = [...changes.entries()]
      .filter(([, c]) => !c.binary) // images etc. have no lines to count
      .map(([path, c]) => ({ path, added: c.added, removed: c.removed }));
    const lines = files.reduce((sum, f) => sum + f.added + f.removed, 0);
    if (lines > rules.maxChangedLines) {
      reasons.push({ kind: "files-changed", lines, since: baseline, files });
    }
  }

  return { note, outdated: reasons.length > 0, reasons, baseline };
}

/**
 * Which commit to count changes from:
 *  - the note has uncommitted edits  -> it's being worked on right now: null (don't count)
 *  - otherwise                       -> the last commit that changed the note file
 *  - never committed (e.g. ignored)  -> fall back to the `commit` field written in the note
 */
async function findBaseline(root: string, note: Note): Promise<string | null> {
  const notePath = relative(root, note.path).replace(/\\/g, "/");
  if (await hasUncommittedChanges(root, notePath)) return null;

  const fromHistory = await lastCommitTouching(root, notePath);
  if (fromHistory) return fromHistory;

  const fromField = note.meta.commit;
  return fromField && (await commitExists(root, fromField)) ? fromField : null;
}

/** Checks every ACTIVE handoff and decision. ("done" notes are history; "outdated" ones are already marked.) */
export async function checkAllNotes(root: string, opts: CheckOptions = {}): Promise<Freshness[]> {
  const results: Freshness[] = [];
  for (const kind of ["handoff", "decision"] as const) {
    const { notes } = await listNotes(root, kind);
    for (const note of notes.filter((n) => n.meta.status === "active")) {
      results.push(await checkNote(root, note, opts));
    }
  }
  return results;
}

/** A one-line explanation for people (and AI assistants). */
export function describeReason(r: StaleReason): string {
  switch (r.kind) {
    case "files-changed": {
      const top = [...r.files]
        .sort((a, b) => b.added + b.removed - (a.added + a.removed))
        .slice(0, 3)
        .map((f) => `${f.path} +${f.added} -${f.removed}`)
        .join(", ");
      return `related files changed by ${r.lines} lines since ${r.since} (${top})`;
    }
    case "file-deleted":
      return `related file was deleted: ${r.path}`;
    case "not-confirmed":
      return `not confirmed for ${r.days} days`;
  }
}

/** Whole days from one YYYY-MM-DD date to another. */
export function daysBetween(from: string, to: string): number {
  // Only the day part counts, even if a time is included.
  const ms = Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
