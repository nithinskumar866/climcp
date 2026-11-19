import { join } from "node:path";
import type { NoteKind } from "./types.js";

// Every folder name is written once here, so we never mistype it somewhere else.

export const CONTEXT_DIR = ".context";

const KIND_FOLDERS: Record<NoteKind, string> = {
  handoff: "handoffs",
  decision: "decisions",
};

/** <repo>/.context */
export function contextDir(repoRoot: string): string {
  return join(repoRoot, CONTEXT_DIR);
}

/** <repo>/.context/handoffs or <repo>/.context/decisions */
export function kindDir(repoRoot: string, kind: NoteKind): string {
  return join(contextDir(repoRoot), KIND_FOLDERS[kind]);
}
