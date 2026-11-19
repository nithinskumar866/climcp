import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { kindDir } from "./paths.js";
import { NOTE_STATUSES, type Note, type NoteKind, type NoteMeta } from "./types.js";

// A note file looks like this:
//
//   ---                      <- start of frontmatter
//   title: Payment webhook
//   status: active
//   ...
//   ---                      <- end of frontmatter
//
//   ## Goal                  <- the body (normal Markdown)
//   ...

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Thrown when a note file is broken, with a message a human can act on. */
export class NoteFormatError extends Error {}

// ---------- small helpers ----------

/** Today's date in the user's own time zone, as YYYY-MM-DD. */
export function todayISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "Payment Webhook: retries!" -> "payment-webhook-retries" (safe to use in a file name). */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // anything that isn't a letter or digit becomes "-"
    .replace(/^-+|-+$/g, "") // no "-" at the start or end
    .slice(0, 50)
    .replace(/-+$/g, "");
  return slug || "note";
}

// ---------- text <-> note ----------

/** Turns frontmatter + body into the text of a .md file. */
export function serializeNote(meta: NoteMeta, body: string): string {
  // Fixed key order, so files always look the same and git diffs stay tidy.
  const ordered = {
    title: meta.title,
    author: meta.author,
    date: meta.date,
    status: meta.status,
    related_files: meta.related_files,
    commit: meta.commit,
    last_confirmed: meta.last_confirmed,
  };
  return `---\n${YAML.stringify(ordered)}---\n\n${body.trim()}\n`;
}

/** Reads the text of a .md file and checks that its frontmatter is valid. */
export function parseNote(text: string): { meta: NoteMeta; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new NoteFormatError("missing frontmatter (the file must start with a --- block)");
  }
  const [, yamlText, body] = match;

  let raw: unknown;
  try {
    raw = YAML.parse(yamlText);
  } catch (err) {
    throw new NoteFormatError(`frontmatter is not valid YAML: ${(err as Error).message}`);
  }
  return { meta: validateMeta(raw), body: body.trim() };
}

/** Checks each frontmatter field, fills in safe defaults where possible, and complains clearly otherwise. */
function validateMeta(raw: unknown): NoteMeta {
  if (typeof raw !== "object" || raw === null) {
    throw new NoteFormatError("frontmatter is empty");
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.title !== "string" || r.title.trim() === "") {
    throw new NoteFormatError("'title' is missing");
  }
  if (typeof r.date !== "string" || !DATE_PATTERN.test(r.date)) {
    throw new NoteFormatError("'date' must look like 2026-11-19");
  }
  const status = r.status ?? "active";
  if (!NOTE_STATUSES.includes(status as never)) {
    throw new NoteFormatError(`'status' must be one of: ${NOTE_STATUSES.join(", ")}`);
  }
  const related = r.related_files ?? [];
  if (!Array.isArray(related) || !related.every((f) => typeof f === "string")) {
    throw new NoteFormatError("'related_files' must be a list of file paths");
  }
  const commit = r.commit ?? null;
  if (commit !== null && typeof commit !== "string") {
    throw new NoteFormatError("'commit' must be a commit hash or null");
  }
  const lastConfirmed = r.last_confirmed ?? r.date;
  if (typeof lastConfirmed !== "string" || !DATE_PATTERN.test(lastConfirmed)) {
    throw new NoteFormatError("'last_confirmed' must look like 2026-11-19");
  }

  return {
    title: r.title.trim(),
    author: typeof r.author === "string" && r.author.trim() ? r.author.trim() : "unknown",
    date: r.date,
    status: status as NoteMeta["status"],
    related_files: related as string[],
    commit: commit as string | null,
    last_confirmed: lastConfirmed,
  };
}

// ---------- disk ----------

/**
 * Writes a brand-new note file and never overwrites an existing one.
 *
 * SAFETY: this does NOT remove secrets. Only the core's saveNote() (Step 3)
 * should call it, and saveNote() runs the secret scrubber first.
 */
export async function writeNewNoteFile(
  repoRoot: string,
  kind: NoteKind,
  meta: NoteMeta,
  body: string,
): Promise<Note> {
  const dir = kindDir(repoRoot, kind);
  await mkdir(dir, { recursive: true });

  const base = `${meta.date}-${slugify(meta.title)}`;
  const text = serializeNote(meta, body);

  // If the name is taken, try -2, -3, ...  The "wx" flag means
  // "fail if the file already exists", so we can never overwrite a note by accident.
  for (let n = 1; n < 1000; n++) {
    const fileName = n === 1 ? `${base}.md` : `${base}-${n}.md`;
    const path = join(dir, fileName);
    try {
      await writeFile(path, text, { encoding: "utf8", flag: "wx" });
      return { kind, path, fileName, meta, body: body.trim() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`too many notes named ${base}`);
}

/**
 * Replaces the content of an EXISTING note file (e.g. after confirming it or changing its status).
 *
 * SAFETY: like writeNewNoteFile, this does NOT remove secrets. Only store.ts should call it.
 */
export async function overwriteNoteFile(note: Note): Promise<void> {
  // "r+" = open an existing file for writing; fails if it doesn't exist, so it never creates a stray file.
  const handle = await open(note.path, "r+");
  try {
    await handle.truncate(0);
    await handle.writeFile(serializeNote(note.meta, note.body), "utf8");
  } finally {
    await handle.close();
  }
}

/** Loads one note file. */
export async function readNote(path: string, kind: NoteKind): Promise<Note> {
  const text = await readFile(path, "utf8");
  const fileName = path.split(/[\\/]/).pop()!;
  try {
    const { meta, body } = parseNote(text);
    return { kind, path, fileName, meta, body };
  } catch (err) {
    if (err instanceof NoteFormatError) {
      throw new NoteFormatError(`${fileName}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Loads every note of one kind, newest first.
 * A broken file doesn't stop the others from loading: it's reported in `broken`.
 */
export async function listNotes(
  repoRoot: string,
  kind: NoteKind,
): Promise<{ notes: Note[]; broken: { fileName: string; error: string }[] }> {
  const dir = kindDir(repoRoot, kind);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { notes: [], broken: [] };
    throw err;
  }

  const notes: Note[] = [];
  const broken: { fileName: string; error: string }[] = [];
  for (const fileName of files) {
    try {
      notes.push(await readNote(join(dir, fileName), kind));
    } catch (err) {
      if (!(err instanceof NoteFormatError)) throw err;
      broken.push({ fileName, error: err.message });
    }
  }

  // Newest date first; on the same day, the later file name first.
  notes.sort((a, b) => b.meta.date.localeCompare(a.meta.date) || b.fileName.localeCompare(a.fileName));
  return { notes, broken };
}
