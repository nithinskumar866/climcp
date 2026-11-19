import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadConfig } from "../core/config.js";
import { findRepoRoot, stagedContent, stagedFiles } from "../core/git.js";
import { NoteFormatError, readNote } from "../core/notes.js";
import { CONTEXT_DIR, kindDir } from "../core/paths.js";
import { findSecrets, type SecretFinding } from "../core/scrubber.js";
import { checkNote, describeReason, type Freshness } from "../core/staleness.js";
import { scrubRawNoteFile, updateNote } from "../core/store.js";
import type { Note } from "../core/types.js";

// `contextbaton check`:
//   1. removes secrets from every note file (and says what it removed)
//   2. lists notes that are possibly outdated, with the reason
//   3. reports note files that are broken
// With --hook (run by git before each commit) it also checks the STAGED copies,
// because those are what actually gets committed.
//
// Exit code 1 = secrets were found (this is what stops the commit). Outdated notes are only a warning.

export class CheckError extends Error {}

export interface FileSecrets {
  file: string;
  findings: SecretFinding[];
}

export interface CheckReport {
  root: string;
  notesChecked: number;
  /** Secrets found in note files on disk (already removed from them). */
  secrets: FileSecrets[];
  /** Hook mode: staged copies that contain secrets (the commit must be stopped). */
  stagedSecrets: FileSecrets[];
  outdated: Freshness[];
  broken: { file: string; error: string }[];
}

export interface CheckOptions {
  hook?: boolean;
  /** For tests: pretend today is this date. */
  today?: string;
}

export async function runCheck(cwd: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const root = await findRepoRoot(cwd);
  if (!root) throw new CheckError("This folder is not inside a git repository.");
  const config = await loadConfig(root);
  const rel = (p: string) => relative(root, p).replace(/\\/g, "/");

  const report: CheckReport = { root, notesChecked: 0, secrets: [], stagedSecrets: [], outdated: [], broken: [] };

  for (const kind of ["handoff", "decision"] as const) {
    for (const path of await noteFiles(root, kind)) {
      report.notesChecked++;

      let note: Note;
      try {
        note = await readNote(path, kind);
      } catch (err) {
        if (!(err instanceof NoteFormatError)) throw err;
        report.broken.push({ file: rel(path), error: err.message });
        // A broken file can still leak a secret: clean its raw text.
        const findings = await scrubRawNoteFile(path);
        if (findings.length > 0) report.secrets.push({ file: rel(path), findings });
        continue;
      }

      // 1. Secrets. (Someone may have edited the file by hand, outside contextbaton.)
      // Scan the RAW file: the parsed note leaves out things like YAML comments,
      // but those are still in the file that gets committed.
      const findings = await findSecrets(await readFile(path, "utf8"));
      if (findings.length > 0) {
        // Rewrite it cleanly, field by field...
        const { note: cleaned } = await updateNote(note, {});
        note = cleaned;
        // ...and double-check the raw file. If anything is somehow left, clean the raw text too.
        await scrubRawNoteFile(path);
        report.secrets.push({ file: rel(path), findings });
      }

      // 2. Outdated? (only active notes)
      if (note.meta.status === "active") {
        const freshness = await checkNote(root, note, { rules: config.outdated, today: opts.today });
        if (freshness.outdated) report.outdated.push(freshness);
      }
    }
  }

  // 3. Hook mode: check exactly what's about to be committed.
  if (opts.hook) {
    for (const file of await stagedFiles(root, CONTEXT_DIR)) {
      const findings = await findSecrets(await stagedContent(root, file));
      if (findings.length > 0) report.stagedSecrets.push({ file, findings });
    }
  }

  return report;
}

/** 1 = secrets were found (stop the commit / fail CI), 0 = fine. */
export function exitCodeFor(report: CheckReport): number {
  return report.secrets.length > 0 || report.stagedSecrets.length > 0 ? 1 : 0;
}

export function formatCheckReport(r: CheckReport, opts: { hook?: boolean } = {}): string {
  const out: string[] = [];
  const list = (f: SecretFinding[]) => f.map((x) => `${x.type} (line ${x.line})`).join(", ");

  if (r.secrets.length > 0) {
    out.push("Secrets found and REMOVED from these notes:");
    for (const s of r.secrets) out.push(`  ✗ ${s.file}: ${list(s.findings)}`);
    out.push("");
  }
  if (r.stagedSecrets.length > 0) {
    out.push("Secrets in the copies staged for this commit:");
    for (const s of r.stagedSecrets) out.push(`  ✗ ${s.file}: ${list(s.findings)}`);
    out.push("");
  }
  if (r.outdated.length > 0) {
    out.push("Possibly outdated notes (check them against the code):");
    for (const f of r.outdated) {
      out.push(`  ! ${relative(r.root, f.note.path).replace(/\\/g, "/")}  "${f.note.meta.title}"`);
      for (const reason of f.reasons) out.push(`      - ${describeReason(reason)}`);
    }
    out.push("  Still true? Run `contextbaton confirm <file name>`.", "");
  }
  if (r.broken.length > 0) {
    out.push("Note files that can't be read:");
    for (const b of r.broken) out.push(`  ! ${b.error}`);
    out.push("");
  }

  if (exitCodeFor(r) === 1) {
    out.push(
      opts.hook
        ? "✗ Commit stopped: secrets were found in notes. They have been removed from the files on disk.\n" +
            "  Review the changes, then run `git add .context` and commit again."
        : "✗ Secrets were found and removed. Review the changes before committing.",
    );
  } else {
    const n = r.notesChecked === 1 ? "1 note" : `${r.notesChecked} notes`;
    const o = r.outdated.length === 0 ? "none outdated" : `${r.outdated.length} possibly outdated`;
    out.push(`✓ ${n} checked: no secrets, ${o}.`);
  }
  return out.join("\n");
}

/** All .md files in one notes folder (including broken ones, which listNotes would skip). */
async function noteFiles(root: string, kind: "handoff" | "decision"): Promise<string[]> {
  const dir = kindDir(root, kind);
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => join(dir, f));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
