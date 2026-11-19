// The "shapes" of our data. TypeScript uses these to catch mistakes,
// e.g. a typo like status: "actve" becomes an error before the code even runs.

/** There are two kinds of notes, and each kind has its own folder. */
export type NoteKind = "handoff" | "decision";

/** active = still true and in use, done = finished, outdated = no longer trustworthy. */
export type NoteStatus = "active" | "done" | "outdated";

export const NOTE_STATUSES: readonly NoteStatus[] = ["active", "done", "outdated"];

/** The frontmatter: the facts stored at the top of every note file. */
export interface NoteMeta {
  title: string;
  author: string;
  /** The date the note was written, as YYYY-MM-DD. */
  date: string;
  status: NoteStatus;
  /** Files this note talks about. Used later to tell whether the note is outdated. */
  related_files: string[];
  /** The git commit the code was at when the note was written (null if unknown). */
  commit: string | null;
  /** The last day someone confirmed the note is still true, as YYYY-MM-DD. */
  last_confirmed: string;
}

/** A note as loaded from disk. */
export interface Note {
  kind: NoteKind;
  /** The full path to the .md file. */
  path: string;
  /** Just the file name, e.g. 2026-11-19-payment-webhook.md */
  fileName: string;
  meta: NoteMeta;
  /** The Markdown text below the frontmatter. */
  body: string;
}
