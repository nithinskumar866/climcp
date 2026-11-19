import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway git repository for tests, in a temporary folder. */
export interface TempRepo {
  root: string;
  git(...args: string[]): string;
  write(path: string, content: string): Promise<void>;
  /** Stages everything and commits; returns the short hash. */
  commit(message: string): string;
  cleanup(): Promise<void>;
}

export async function createTempRepo(): Promise<TempRepo> {
  // realpath: on Windows the temp folder can have a short "8.3" name (SATYA~1);
  // git always reports the long one, so we use the long one too.
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "contextbaton-repo-")));

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });

  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test Person");
  git("config", "user.email", "test@example.com");

  return {
    root,
    git,
    async write(path, content) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
    },
    commit(message) {
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "--short", "HEAD").trim();
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** n lines of text, handy for "make this file change a lot". */
export function lines(n: number, word = "line"): string {
  return Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join("\n") + "\n";
}
