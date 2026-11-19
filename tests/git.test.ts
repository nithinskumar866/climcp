import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findRepoRoot,
  currentBranch,
  headCommit,
  commitExists,
  gitUserName,
  workingChanges,
  recentCommits,
  lineChangesSince,
} from "../src/core/git.js";
import { createTempRepo, lines, type TempRepo } from "./helpers/temp-repo.js";

let repo: TempRepo;
beforeEach(async () => {
  repo = await createTempRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

describe("about the repository", () => {
  it("finds the repo root, even from a subfolder", async () => {
    await repo.write("src/deep/file.ts", "x");
    const root = await findRepoRoot(join(repo.root, "src", "deep"));
    expect(resolve(root!)).toBe(resolve(repo.root));
  });

  it("returns null outside a git repo", async () => {
    const notRepo = await mkdtemp(join(tmpdir(), "contextbaton-norepo-"));
    try {
      expect(await findRepoRoot(notRepo)).toBeNull();
    } finally {
      await rm(notRepo, { recursive: true, force: true });
    }
  });

  it("works in a brand-new repo with no commits", async () => {
    expect(await currentBranch(repo.root)).toBe("main");
    expect(await headCommit(repo.root)).toBeNull();
    expect(await recentCommits(repo.root)).toEqual([]);
  });

  it("reads the branch, the latest commit and the user name", async () => {
    await repo.write("a.txt", "a");
    const hash = repo.commit("first");
    repo.git("checkout", "-q", "-b", "feature/payments");

    expect(await currentBranch(repo.root)).toBe("feature/payments");
    expect(await headCommit(repo.root)).toBe(hash);
    expect(await commitExists(repo.root, hash)).toBe(true);
    expect(await commitExists(repo.root, "deadbee")).toBe(false);
    expect(await gitUserName(repo.root)).toBe("Test Person");
  });
});

describe("workingChanges", () => {
  it("lists modified, added, deleted and untracked files", async () => {
    await repo.write("keep.txt", "1");
    await repo.write("edit.txt", "1");
    await repo.write("remove.txt", "1");
    repo.commit("base");

    await repo.write("edit.txt", "2");
    await unlink(join(repo.root, "remove.txt"));
    await repo.write("staged new.txt", "new"); // a space in the name
    repo.git("add", "staged new.txt");
    await repo.write("src/untracked.ts", "u");

    const changes = await workingChanges(repo.root);
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: "edit.txt", kind: "modified", staged: false },
        { path: "remove.txt", kind: "deleted", staged: false },
        { path: "staged new.txt", kind: "added", staged: true },
        { path: "src/untracked.ts", kind: "untracked", staged: false },
      ]),
    );
    expect(changes).toHaveLength(4);
  });

  it("handles a renamed file", async () => {
    await repo.write("old.txt", lines(20));
    repo.commit("base");
    repo.git("mv", "old.txt", "new.txt");
    expect(await workingChanges(repo.root)).toEqual([{ path: "new.txt", kind: "renamed", staged: true }]);
  });

  it("is empty when everything is committed", async () => {
    await repo.write("a.txt", "a");
    repo.commit("c");
    expect(await workingChanges(repo.root)).toEqual([]);
  });
});

describe("recentCommits", () => {
  it("returns the newest first, with messages intact", async () => {
    for (const msg of ["one", "two", "three: with | odd, characters"]) {
      await repo.write("f.txt", msg);
      repo.commit(msg);
    }
    const commits = await recentCommits(repo.root, 2);
    expect(commits.map((c) => c.subject)).toEqual(["three: with | odd, characters", "two"]);
    expect(commits[0]).toMatchObject({ author: "Test Person", date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });
});

describe("lineChangesSince", () => {
  it("counts committed and uncommitted line changes per file", async () => {
    await repo.write("src/a.ts", lines(10));
    await repo.write("src/b.ts", lines(10));
    await repo.write("src/c.ts", lines(10));
    const start = repo.commit("base");

    await repo.write("src/a.ts", lines(10) + lines(30, "more")); // +30, committed
    repo.commit("grow a");
    await repo.write("src/b.ts", lines(5)); // -5, not committed yet

    const changes = await lineChangesSince(repo.root, start, ["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(changes.get("src/a.ts")).toEqual({ added: 30, removed: 0, binary: false });
    expect(changes.get("src/b.ts")).toEqual({ added: 0, removed: 5, binary: false });
    expect(changes.has("src/c.ts")).toBe(false); // unchanged
  });

  it("counts a deleted file as all its lines removed", async () => {
    await repo.write("gone.ts", lines(12));
    const start = repo.commit("base");
    await unlink(join(repo.root, "gone.ts"));
    expect((await lineChangesSince(repo.root, start, ["gone.ts"])).get("gone.ts")).toEqual({
      added: 0,
      removed: 12,
      binary: false,
    });
  });

  it("marks binary files", async () => {
    await repo.write("logo.png", "\x00\x01\x02");
    const start = repo.commit("base");
    await repo.write("logo.png", "\x00\x09\x09\x09");
    expect((await lineChangesSince(repo.root, start, ["logo.png"])).get("logo.png")?.binary).toBe(true);
  });

  it("returns an empty map for no files", async () => {
    expect((await lineChangesSince(repo.root, "HEAD", [])).size).toBe(0);
  });
});
