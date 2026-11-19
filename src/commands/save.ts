import { userInfo } from "node:os";
import { relative } from "node:path";
import {
  currentBranch,
  filesInCommit,
  findRepoRoot,
  gitUserName,
  headCommit,
  recentCommits,
  workingChanges,
  type CommitInfo,
  type WorkingChange,
} from "../core/git.js";
import { CONTEXT_DIR } from "../core/paths.js";
import { saveNote, type SaveResult } from "../core/store.js";
import { handoffBody } from "../core/templates.js";

// `contextbaton save`: makes a handoff note in about a minute.
//   1. collect what git already knows (branch, changed files, recent commits)
//   2. ask a few quick questions (Enter skips any of them)
//   3. fill in the template and save it through saveNote(), which removes secrets

export class SaveError extends Error {}

/** What git tells us about the current work. */
export interface GitSnapshot {
  branch: string | null;
  head: string | null;
  changes: WorkingChange[];
  commits: CommitInfo[];
  /** Files touched by the latest commit (used when there are no uncommitted changes). */
  lastCommitFiles: string[];
}

/** The human part: answers to the quick questions. Empty = skipped. */
export interface Answers {
  title: string;
  done: string;
  next: string;
  risks: string;
}

// ---------- 1. collect ----------

export async function snapshotGit(root: string): Promise<GitSnapshot> {
  const [branch, head, changes, commits, lastCommitFiles] = await Promise.all([
    currentBranch(root),
    headCommit(root),
    workingChanges(root),
    recentCommits(root, 5),
    filesInCommit(root),
  ]);
  // Changes inside .context/ are notes, not code: leave them out.
  const isCode = (p: string) => !p.startsWith(`${CONTEXT_DIR}/`);
  return {
    branch,
    head,
    changes: changes.filter((c) => isCode(c.path)),
    commits,
    lastCommitFiles: lastCommitFiles.filter(isCode),
  };
}

// ---------- 2. ask ----------

/** A function that asks one question and returns the answer. In tests, a fake one is used. */
export type Ask = (question: string) => Promise<string>;

export function defaultTitle(git: GitSnapshot): string {
  return git.branch && git.branch !== "main" && git.branch !== "master" ? git.branch : "Handoff";
}

/** Asks the quick questions. Anything already given (e.g. from --title) is not asked again. */
export async function askQuestions(ask: Ask, git: GitSnapshot, given: Partial<Answers>): Promise<Answers> {
  const title = defaultTitle(git);
  return {
    title: given.title ?? ((await ask(`Title (${title}): `)).trim() || title),
    done: given.done ?? (await ask("What did you do? ")).trim(),
    next: given.next ?? (await ask("Next step? ")).trim(),
    risks: given.risks ?? (await ask("Risks / warnings? (Enter to skip) ")).trim(),
  };
}

// ---------- 3. build the note ----------

/** The files the note is about: uncommitted work if there is any, otherwise the latest commit's files. */
export function relatedFiles(git: GitSnapshot): string[] {
  // Deleted files are left out: a note about a file that's already gone would look outdated at once.
  const fromChanges = git.changes.filter((c) => c.kind !== "deleted").map((c) => c.path);
  const files = fromChanges.length > 0 ? fromChanges : git.lastCommitFiles;
  return [...new Set(files)].sort();
}

export function buildHandoff(git: GitSnapshot, answers: Answers): { title: string; body: string; related_files: string[] } {
  const filesChanged =
    git.changes.length > 0
      ? git.changes.map((c) => `- \`${c.path}\` (${c.kind}${c.staged ? ", staged" : ""})`).join("\n")
      : "No uncommitted changes.";

  const state = [
    `- Branch: \`${git.branch ?? "(detached)"}\``,
    `- Latest commit: ${git.head ? `\`${git.head}\`${git.commits[0] ? ` ${git.commits[0].subject}` : ""}` : "none yet"}`,
    `- Uncommitted files: ${git.changes.length}`,
  ];
  if (git.commits.length > 0) {
    state.push("", "Recent commits:", ...git.commits.map((c) => `- \`${c.hash}\` ${c.date} ${c.subject} (${c.author})`));
  }

  return {
    title: answers.title,
    related_files: relatedFiles(git),
    body: handoffBody({
      "What's done": answers.done,
      "Current state": state.join("\n"),
      "Files changed": filesChanged,
      "Next step": answers.next,
      "Risks and warnings": answers.risks,
    }),
  };
}

// ---------- putting it together ----------

export interface SaveOptions {
  /** Answers given as flags (--title, --done, ...). */
  given: Partial<Answers>;
  /** How to ask the rest. null = don't ask (use defaults). */
  ask: Ask | null;
  /** Called after git info is collected, before asking (the CLI prints a short summary). */
  onSnapshot?: (git: GitSnapshot) => void;
}

export async function runSave(cwd: string, opts: SaveOptions): Promise<SaveResult & { root: string }> {
  const root = await findRepoRoot(cwd);
  if (!root) throw new SaveError("This folder is not inside a git repository. Run `git init` first.");

  const git = await snapshotGit(root);
  opts.onSnapshot?.(git);

  // Drop flags that weren't given: `{ title: undefined }` would otherwise wipe out the default title.
  const given = Object.fromEntries(
    Object.entries(opts.given).filter(([, v]) => typeof v === "string" && v.trim() !== ""),
  ) as Partial<Answers>;

  const answers: Answers = opts.ask
    ? await askQuestions(opts.ask, git, given)
    : { title: defaultTitle(git), done: "", next: "", risks: "", ...given };

  const handoff = buildHandoff(git, answers);
  const author = (await gitUserName(root)) ?? userInfo().username;

  const result = await saveNote(root, {
    kind: "handoff",
    title: handoff.title,
    author,
    body: handoff.body,
    related_files: handoff.related_files,
    commit: git.head,
  });
  return { ...result, root };
}

export function formatSnapshot(git: GitSnapshot): string {
  const files = git.changes.length === 1 ? "1 file changed" : `${git.changes.length} files changed`;
  return `Branch: ${git.branch ?? "(detached)"}  (${files})`;
}

export function formatSaveResult(r: SaveResult & { root: string }): string {
  const out = [`✓ Saved ${relative(r.root, r.note.path).replace(/\\/g, "/")}`];
  if (r.redactions.length > 0) {
    out.push(`! Removed ${r.redactions.length} secret(s) before saving:`);
    for (const x of r.redactions) out.push(`    ${x.type} in ${x.field} (line ${x.line})`);
  }
  out.push("  Commit it with your code so your team (and their AI assistants) can see it.");
  return out.join("\n");
}
