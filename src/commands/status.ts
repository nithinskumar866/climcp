import { relative } from "node:path";
import { loadConfig } from "../core/config.js";
import { findRepoRoot } from "../core/git.js";
import { allNotes, findNote, getSection, latestActiveHandoff } from "../core/query.js";
import { checkAllNotes, checkNote, describeReason, type Freshness } from "../core/staleness.js";
import { confirmNote } from "../core/store.js";
import type { Note } from "../core/types.js";

// `contextbaton status`  : the latest handoff + any notes that may be outdated. Read-only.
// `contextbaton confirm` : marks a note as still true.

export class StatusError extends Error {}

async function requireRoot(cwd: string): Promise<string> {
  const root = await findRepoRoot(cwd);
  if (!root) throw new StatusError("This folder is not inside a git repository.");
  return root;
}

// ---------- status ----------

export interface StatusReport {
  root: string;
  latest: Freshness | null;
  outdated: Freshness[];
  counts: { handoffs: number; decisions: number };
}

export async function runStatus(cwd: string, opts: { today?: string } = {}): Promise<StatusReport> {
  const root = await requireRoot(cwd);
  const config = await loadConfig(root);
  const check = { rules: config.outdated, today: opts.today };

  const notes = await allNotes(root);
  const latestNote = await latestActiveHandoff(root);

  return {
    root,
    latest: latestNote ? await checkNote(root, latestNote, check) : null,
    outdated: (await checkAllNotes(root, check)).filter((f) => f.outdated),
    counts: {
      handoffs: notes.filter((n) => n.kind === "handoff").length,
      decisions: notes.filter((n) => n.kind === "decision").length,
    },
  };
}

export function formatStatus(r: StatusReport): string {
  const rel = (n: Note) => relative(r.root, n.path).replace(/\\/g, "/");
  const out: string[] = [];

  if (!r.latest) {
    out.push("No active handoff yet. Run `contextbaton save` at the end of your session.");
  } else {
    const { note } = r.latest;
    out.push(`Latest handoff: "${note.meta.title}"`, `  ${note.meta.author}, ${note.meta.date}  ·  ${rel(note)}`);
    if (r.latest.outdated) {
      out.push("  ! POSSIBLY OUTDATED, check it against the code before trusting it:");
      for (const reason of r.latest.reasons) out.push(`      - ${describeReason(reason)}`);
    }
    const next = getSection(note.body, "Next step");
    const risks = getSection(note.body, "Risks and warnings");
    if (next) out.push("", "  Next step:", indent(next, 4));
    if (risks) out.push("", "  Risks and warnings:", indent(risks, 4));
  }

  // Other outdated notes (the latest one was already shown above).
  const others = r.outdated.filter((f) => f.note.path !== r.latest?.note.path);
  if (others.length > 0) {
    out.push("", "Possibly outdated notes:");
    for (const f of others) {
      out.push(`  ! ${rel(f.note)}  "${f.note.meta.title}"`);
      for (const reason of f.reasons) out.push(`      - ${describeReason(reason)}`);
    }
  }
  if (r.outdated.length > 0) {
    out.push("", "  Still true? Run `contextbaton confirm <file name>`.");
  }

  out.push("", `${r.counts.handoffs} handoff(s), ${r.counts.decisions} decision(s) in .context/`);
  return out.join("\n");
}

function indent(text: string, spaces: number): string {
  return text
    .split("\n")
    .map((l) => (l.trim() ? " ".repeat(spaces) + l : ""))
    .join("\n");
}

// ---------- confirm ----------

export async function runConfirm(cwd: string, ref: string, opts: { today?: string } = {}): Promise<{ root: string; note: Note }> {
  const root = await requireRoot(cwd);
  const note = await findNote(root, ref);
  const { note: confirmed } = await confirmNote(root, note, opts.today);
  return { root, note: confirmed };
}

export function formatConfirm(r: { root: string; note: Note }): string {
  return (
    `✓ Confirmed "${r.note.meta.title}" (${relative(r.root, r.note.path).replace(/\\/g, "/")})\n` +
    "  Commit this change: the outdated check will count from that commit."
  );
}
