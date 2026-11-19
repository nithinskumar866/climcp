import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Small helpers that ask git questions. Each one runs a normal git command,
// the same one you could type yourself, and turns the answer into data.
//
// We use `-z` on commands that print file names: it separates names with an
// invisible "\0" character, so file names with spaces or accents can't confuse us.

const run = promisify(execFile);

export class GitError extends Error {}

/** Runs `git <args>` inside `cwd` and returns what it printed. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 50 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message: string };
    if (e.code === "ENOENT") throw new GitError("git is not installed (or not on your PATH)");
    throw new GitError(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`);
  }
}

/** Like git(), but returns null instead of throwing (for questions where "no" is a normal answer). */
async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch (err) {
    if (err instanceof GitError && err.message.startsWith("git is not installed")) throw err;
    return null;
  }
}

// ---------- about the repository ----------

/** The top folder of the git repository that contains `cwd`, or null if it isn't inside one. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  const out = await gitOrNull(cwd, ["rev-parse", "--show-toplevel"]);
  return out ? out.trim() : null;
}

/** The current branch name, e.g. "main". null when "detached" (not on any branch). */
export async function currentBranch(root: string): Promise<string | null> {
  // symbolic-ref works even in a brand-new repo with no commits yet.
  const out = await gitOrNull(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return out ? out.trim() : null;
}

/** The short hash of the latest commit, e.g. "5d150b3". null if there are no commits yet. */
export async function headCommit(root: string): Promise<string | null> {
  const out = await gitOrNull(root, ["rev-parse", "--short", "HEAD"]);
  return out ? out.trim() : null;
}

/** true if `commit` is a commit this repository knows about. */
export async function commitExists(root: string, commit: string): Promise<boolean> {
  return (await gitOrNull(root, ["cat-file", "-e", `${commit}^{commit}`])) !== null;
}

/**
 * The folder where git looks for hooks. Usually <repo>/.git/hooks, but a project
 * can move it (core.hooksPath, used by tools like husky), so we ask git.
 */
export async function hooksDir(root: string): Promise<string> {
  const out = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])).trim();
  return out;
}

/** true if git would ignore this path (because of .gitignore). */
export async function isIgnored(root: string, path: string): Promise<boolean> {
  // check-ignore prints the path and exits 0 if ignored; exits 1 if not.
  return (await gitOrNull(root, ["check-ignore", "-q", path])) !== null;
}

/** Your name from git config (used as the note's author). */
export async function gitUserName(root: string): Promise<string | null> {
  const out = await gitOrNull(root, ["config", "user.name"]);
  return out?.trim() || null;
}

// ---------- what's going on right now ----------

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface WorkingChange {
  path: string;
  kind: ChangeKind;
  /** true if this change is staged (git add'ed). */
  staged: boolean;
}

/** Uncommitted work: files changed, added, deleted or not yet tracked. */
export async function workingChanges(root: string): Promise<WorkingChange[]> {
  // Each entry looks like "XY path". X = staged state, Y = unstaged state.
  // For a rename, the OLD name follows as an extra entry.
  const out = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = out.split("\0").filter(Boolean);
  const changes: WorkingChange[] = [];

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);

    if (x === "?") {
      changes.push({ path, kind: "untracked", staged: false });
      continue;
    }
    if (x === "R" || x === "C") i++; // skip the old name that follows

    const code = x !== " " ? x : y;
    const kind: ChangeKind =
      code === "A" ? "added" : code === "D" ? "deleted" : code === "R" || code === "C" ? "renamed" : "modified";
    changes.push({ path, kind, staged: x !== " " });
  }
  return changes;
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

/** The last `count` commits, newest first. Empty if there are no commits yet. */
export async function recentCommits(root: string, count = 5): Promise<CommitInfo[]> {
  // %x1f is an invisible "unit separator": it won't appear in a commit message.
  const out = await gitOrNull(root, ["log", `-n${count}`, "--date=short", "--format=%h%x1f%an%x1f%ad%x1f%s"]);
  if (!out) return [];
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, subject] = line.split("\x1f");
      return { hash, author, date, subject };
    });
}

/** Files touched by one commit (default: the latest). Empty if there are no commits yet. */
export async function filesInCommit(root: string, commit = "HEAD"): Promise<string[]> {
  // --root makes this also work for the very first commit of a repo.
  const out = await gitOrNull(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit]);
  return out ? out.split("\0").filter(Boolean) : [];
}

// ---------- how much changed (used to find outdated notes) ----------

export interface LineChanges {
  added: number;
  removed: number;
  /** Binary files (images...) have no "lines"; git only says they changed. */
  binary: boolean;
}

/**
 * How many lines were added/removed in each file since `commit`,
 * counting committed AND not-yet-committed changes.
 * Files that didn't change are not in the result.
 */
export async function lineChangesSince(root: string, commit: string, files: string[]): Promise<Map<string, LineChanges>> {
  const result = new Map<string, LineChanges>();
  if (files.length === 0) return result;

  // `git diff --numstat <commit> -- files` compares that commit with the files as they are now.
  // Each entry looks like "12\t3\tpath" (binary files show "-\t-\tpath").
  const out = await git(root, ["diff", "--numstat", "-z", "--no-renames", commit, "--", ...files]);
  for (const entry of out.split("\0").filter(Boolean)) {
    const [added, removed, ...pathParts] = entry.split("\t");
    const binary = added === "-";
    result.set(pathParts.join("\t"), {
      added: binary ? 0 : Number(added),
      removed: binary ? 0 : Number(removed),
      binary,
    });
  }
  return result;
}
