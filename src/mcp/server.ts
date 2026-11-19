import { relative } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { filesChangedText, gitStateText, relatedFiles, snapshotGit } from "../commands/save.js";
import { loadConfig } from "../core/config.js";
import { gitUserName, headCommit } from "../core/git.js";
import { findNote, latestActiveHandoff, searchNotes } from "../core/query.js";
import { checkNote, describeReason } from "../core/staleness.js";
import { confirmNote, saveNote, type SaveResult } from "../core/store.js";
import { decisionBody, handoffBody } from "../core/templates.js";
import type { Note } from "../core/types.js";
import { getVersion } from "../version.js";

// The MCP server: lets AI assistants (Claude Code, Cursor, ...) read and write notes.
//
// It talks over "stdio": the AI app starts `contextbaton mcp` and sends messages
// through its input/output. That's why this file must NEVER use console.log:
// printing would mix junk into the messages. (console.error is fine.)
//
// Every tool here reuses the core: saving goes through saveNote() (secrets removed),
// and every note handed to the AI comes with a warning if it may be outdated.

const INSTRUCTIONS = `This project keeps handoff notes and decisions (written by developers and AI assistants) in .context/.
- At the start of a session, call get_latest_handoff to learn what was done and what's next.
- Use search_notes before changing an area, to find earlier decisions and failed attempts.
- A note marked POSSIBLY OUTDATED may be wrong: check the code first. If it's still true, call confirm_note.
- At the end of a session, call write_handoff. Use record_decision for important decisions and their reasons.
- Never put secrets in notes. They are removed automatically, but don't rely on that.`;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });

/** Runs a tool; any error becomes a readable message for the AI instead of crashing the server. */
async function safely(run: () => Promise<string>): Promise<ToolResult> {
  try {
    return text(await run());
  } catch (err) {
    return { ...text(`Error: ${(err as Error).message}`), isError: true };
  }
}

export function createMcpServer(root: string): McpServer {
  const server = new McpServer({ name: "contextbaton", version: getVersion() }, { instructions: INSTRUCTIONS });
  const rel = (n: Note) => relative(root, n.path).replace(/\\/g, "/");

  /** A note as the AI sees it: a warning first (if outdated), then the facts, then the text. */
  async function present(note: Note, withBody = true): Promise<string> {
    const config = await loadConfig(root);
    const freshness = note.meta.status === "active" ? await checkNote(root, note, { rules: config.outdated }) : null;
    const lines: string[] = [];

    if (freshness?.outdated) {
      lines.push(
        "⚠ WARNING: POSSIBLY OUTDATED. Check the code before relying on this note:",
        ...freshness.reasons.map((r) => `  - ${describeReason(r)}`),
        "  If it is still true, call confirm_note with this file name.",
        "",
      );
    } else if (note.meta.status === "outdated") {
      lines.push("⚠ WARNING: this note is marked OUTDATED. Treat it as history, not as current truth.", "");
    }

    lines.push(
      `# ${note.meta.title}`,
      `file: ${rel(note)} | kind: ${note.kind} | status: ${note.meta.status} | author: ${note.meta.author} | ` +
        `date: ${note.meta.date} | last confirmed: ${note.meta.last_confirmed}`,
    );
    if (note.meta.related_files.length > 0) lines.push(`related files: ${note.meta.related_files.join(", ")}`);
    if (withBody) lines.push("", note.body);
    return lines.join("\n");
  }

  function savedMessage(result: SaveResult): string {
    const out = [`Saved ${rel(result.note)}.`];
    if (result.redactions.length > 0) {
      out.push(
        `Removed ${result.redactions.length} secret(s) before saving: ` +
          result.redactions.map((r) => `${r.type} in ${r.field}`).join(", ") +
          ". Please don't put secrets in notes.",
      );
    }
    out.push("Remind the user to commit it with their code so the team can see it.");
    return out.join("\n");
  }

  async function author(): Promise<string> {
    return `${(await gitUserName(root)) ?? "unknown"} (with AI assistant)`;
  }

  // ---------- 1. get_latest_handoff ----------
  server.registerTool(
    "get_latest_handoff",
    {
      title: "Get latest handoff",
      description:
        "Returns the most recent active handoff note: what was done, the current state, what was tried, the next step and risks. Call this at the start of a session.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      safely(async () => {
        const note = await latestActiveHandoff(root);
        return note ? present(note) : "No active handoff yet. At the end of this session, call write_handoff.";
      }),
  );

  // ---------- 2. search_notes ----------
  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Searches handoffs and decisions. Every word must appear (case-insensitive). An empty query lists the newest notes.",
      inputSchema: {
        query: z.string().describe("words to search for, e.g. 'payment webhook'"),
        kind: z.enum(["handoff", "decision", "all"]).default("all").describe("which notes to search"),
        include_inactive: z.boolean().default(false).describe("also search notes that are done or outdated"),
        limit: z.number().int().min(1).max(20).default(5),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, kind, include_inactive, limit }) =>
      safely(async () => {
        const notes = await searchNotes(root, query, {
          kinds: kind === "all" ? undefined : [kind],
          includeInactive: include_inactive,
          limit,
        });
        if (notes.length === 0) return `No notes match "${query}".`;
        const parts = await Promise.all(notes.map((n) => present(n)));
        return `Found ${notes.length} note(s):\n\n` + parts.join("\n\n---\n\n");
      }),
  );

  // ---------- 3. write_handoff ----------
  const section = (what: string) => z.string().optional().describe(what);
  server.registerTool(
    "write_handoff",
    {
      title: "Write handoff",
      description:
        "Saves a handoff note for whoever works on this next (a person or another AI session). Call it at the end of a session. " +
        "Fill in what you know; files changed and current git state are added automatically if you leave them out. Secrets are removed before saving.",
      inputSchema: {
        title: z.string().min(1).describe("short title, e.g. 'Payment webhook retries'"),
        goal: section("what this work is trying to achieve"),
        done: section("what was finished in this session"),
        current_state: section("where things stand right now"),
        files_changed: section("which files changed and how"),
        decisions: section("decisions made and why"),
        tried_and_failed: section("what was tried and didn't work, and why (saves the next person time)"),
        tests: section("which tests passed, failed or were not run"),
        next_step: section("the very next thing to do"),
        risks: section("risks, warnings, things that could break"),
        related_files: z.array(z.string()).optional().describe("repo-relative paths this note is about (default: the changed files)"),
      },
      annotations: { destructiveHint: false },
    },
    (input) =>
      safely(async () => {
        // What git knows fills in anything the AI left out.
        const git = await snapshotGit(root);
        const body = handoffBody({
          Goal: input.goal,
          "What's done": input.done,
          "Current state": input.current_state ?? gitStateText(git),
          "Files changed": input.files_changed ?? filesChangedText(git),
          "Decisions and why": input.decisions,
          "What was tried and didn't work": input.tried_and_failed,
          "Tests passed / not run": input.tests,
          "Next step": input.next_step,
          "Risks and warnings": input.risks,
        });

        const result = await saveNote(root, {
          kind: "handoff",
          title: input.title,
          author: await author(),
          body,
          related_files: input.related_files ?? relatedFiles(git),
          commit: git.head,
        });
        return savedMessage(result);
      }),
  );

  // ---------- 4. record_decision ----------
  server.registerTool(
    "record_decision",
    {
      title: "Record decision",
      description:
        "Saves an important decision and the reason for it, so later sessions don't undo it by accident. Secrets are removed before saving.",
      inputSchema: {
        title: z.string().min(1).describe("short title, e.g. 'Use Postgres instead of MySQL'"),
        decision: z.string().min(1).describe("what was decided"),
        why: z.string().min(1).describe("the reason"),
        alternatives: section("other options considered and why they were rejected"),
        consequences: section("what this means for the code from now on"),
        related_files: z.array(z.string()).optional().describe("repo-relative paths this decision affects"),
      },
      annotations: { destructiveHint: false },
    },
    (input) =>
      safely(async () => {
        const result = await saveNote(root, {
          kind: "decision",
          title: input.title,
          author: await author(),
          body: decisionBody({
            Decision: input.decision,
            Why: input.why,
            "Alternatives considered": input.alternatives,
            Consequences: input.consequences,
          }),
          related_files: input.related_files ?? [],
          commit: await headCommit(root),
        });
        return savedMessage(result);
      }),
  );

  // ---------- 5. confirm_note ----------
  server.registerTool(
    "confirm_note",
    {
      title: "Confirm note",
      description:
        "Marks a note as still true after you checked it against the code. Resets its outdated warning (once committed). Only call this if you actually verified it.",
      inputSchema: {
        note: z.string().min(1).describe("the note's file name (as shown in 'file:'), e.g. 2026-11-19-payment-webhook.md"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    ({ note }) =>
      safely(async () => {
        const found = await findNote(root, note);
        const { note: confirmed } = await confirmNote(root, found);
        return `Confirmed "${confirmed.meta.title}" (${rel(confirmed)}). Remind the user to commit this change.`;
      }),
  );

  return server;
}

/** Starts the server on stdin/stdout (this is what `contextbaton mcp` runs). */
export async function startMcpServer(root: string): Promise<void> {
  const server = createMcpServer(root);
  await server.connect(new StdioServerTransport());
  console.error(`contextbaton MCP server running for ${root}`); // stderr: safe, shows in the AI app's logs
}
