import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { searchNotes } from "../src/core/query.js";
import { saveNote } from "../src/core/store.js";
import { createTempRepo, lines, type TempRepo } from "./helpers/temp-repo.js";
import { FAKE_SECRETS } from "./fixtures/fake-secrets.js";

let repo: TempRepo;
let client: Client;

beforeEach(async () => {
  repo = await createTempRepo();
  await repo.write("src/webhook.ts", lines(20));
  repo.commit("base");

  // Connect a real MCP client to our server, in memory (exactly how an AI app talks to it).
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(repo.root).connect(serverSide);
  client = new Client({ name: "test-ai", version: "1.0.0" });
  await client.connect(clientSide);
});
afterEach(async () => {
  await client.close();
  await repo.cleanup();
});

/** Calls a tool like an AI would, and returns its text answer. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

const gh = FAKE_SECRETS.find((s) => s.type === "github")!;

describe("the MCP server", () => {
  it("offers exactly the 5 tools, with descriptions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["confirm_note", "get_latest_handoff", "record_decision", "search_notes", "write_handoff"],
    );
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(30);
  });

  it("tells the AI how to use it", () => {
    expect(client.getInstructions()).toContain("get_latest_handoff");
  });
});

describe("write_handoff + get_latest_handoff", () => {
  it("with no notes yet, says so", async () => {
    expect((await call("get_latest_handoff")).text).toContain("No active handoff yet");
  });

  it("an AI writes a handoff; the next session reads it back", async () => {
    await repo.write("src/webhook.ts", lines(25)); // some uncommitted work

    const saved = await call("write_handoff", {
      title: "Payment webhook retries",
      goal: "Make retries safe",
      done: "Added exponential backoff",
      tried_and_failed: "Fixed delays caused a thundering herd",
      next_step: "Test duplicate events",
    });
    expect(saved.isError).toBe(false);
    expect(saved.text).toMatch(/Saved \.context\/handoffs\/\d{4}-\d{2}-\d{2}-payment-webhook-retries\.md/);

    const latest = (await call("get_latest_handoff")).text;
    expect(latest).toContain("# Payment webhook retries");
    expect(latest).toContain("(with AI assistant)");
    expect(latest).toContain("related files: src/webhook.ts"); // filled in from git
    expect(latest).toContain("## What was tried and didn't work\n\nFixed delays caused a thundering herd");
    expect(latest).toContain("- `src/webhook.ts` (modified)"); // "Files changed" from git
    expect(latest).not.toContain("WARNING");
  });

  it("removes secrets the AI put in a note, and tells it so", async () => {
    const saved = await call("write_handoff", { title: "Deploy", current_state: `staging uses ${gh.text}` });
    expect(saved.text).toContain("Removed 1 secret(s)");
    expect(saved.text).not.toContain(gh.secret);

    const file = saved.text.match(/Saved (\S+)\./)![1];
    const onDisk = await readFile(join(repo.root, file), "utf8");
    expect(onDisk).not.toContain(gh.secret);
    expect((await call("get_latest_handoff")).text).toContain("[REDACTED: github]");
  });

  it("puts a clear WARNING at the top of an outdated note", async () => {
    await call("write_handoff", { title: "Webhook", related_files: ["src/webhook.ts"] });
    repo.commit("note");
    await repo.write("src/webhook.ts", lines(20) + lines(80, "new"));

    const latest = (await call("get_latest_handoff")).text;
    expect(latest.startsWith("⚠ WARNING: POSSIBLY OUTDATED")).toBe(true);
    expect(latest).toContain("related files changed by 80 lines");
    expect(latest).toContain("confirm_note");
  });

  it("rejects a handoff without a title", async () => {
    expect((await call("write_handoff", { done: "x" })).isError).toBe(true);
  });
});

describe("record_decision + search_notes", () => {
  it("records a decision that search can find", async () => {
    const saved = await call("record_decision", {
      title: "Use Postgres instead of MySQL",
      decision: "Postgres for all new services",
      why: "We need JSONB columns",
      alternatives: "MySQL JSON type was too slow in tests",
    });
    expect(saved.text).toContain("Saved .context/decisions/");

    const found = (await call("search_notes", { query: "jsonb postgres" })).text;
    expect(found).toContain("Found 1 note(s)");
    expect(found).toContain("kind: decision");
    expect(found).toContain("## Why\n\nWe need JSONB columns");
  });

  it("search can be limited to one kind", async () => {
    await call("record_decision", { title: "Retry policy", decision: "3 retries", why: "limits" });
    await call("write_handoff", { title: "Retry work", done: "retry code" });
    const handoffsOnly = (await call("search_notes", { query: "retry", kind: "handoff" })).text;
    expect(handoffsOnly).toContain("Found 1 note(s)");
    expect(handoffsOnly).toContain("# Retry work");
  });

  it("says when nothing matches", async () => {
    expect((await call("search_notes", { query: "kubernetes" })).text).toBe('No notes match "kubernetes".');
  });
});

describe("confirm_note", () => {
  it("confirms an outdated note so it stops warning (after commit)", async () => {
    await call("write_handoff", { title: "Webhook", related_files: ["src/webhook.ts"] });
    repo.commit("note");
    await repo.write("src/webhook.ts", lines(20) + lines(80, "new"));
    repo.commit("big change");

    const file = (await call("get_latest_handoff")).text.match(/file: \.context\/handoffs\/(\S+)/)![1];
    const confirmed = await call("confirm_note", { note: file });
    expect(confirmed.text).toContain('Confirmed "Webhook"');

    repo.commit("confirm");
    expect((await call("get_latest_handoff")).text).not.toContain("WARNING");
  });

  it("returns a readable error for an unknown note (the server keeps running)", async () => {
    const result = await call("confirm_note", { note: "does-not-exist" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No note matches "does-not-exist"');
    expect((await call("get_latest_handoff")).isError).toBe(false); // still alive
  });
});

describe("searchNotes ranking", () => {
  it("title matches rank above body-only matches; done notes are skipped unless asked", async () => {
    const save = (title: string, body: string, status?: "done") =>
      saveNote(repo.root, { kind: "handoff", title, author: "a", body, status, date: "2026-11-19" });
    await save("Unrelated title", "mentions webhook once");
    await save("Webhook retries", "retry logic");
    await save("Old webhook work", "webhook", "done");

    expect((await searchNotes(repo.root, "webhook")).map((n) => n.meta.title)).toEqual([
      "Webhook retries",
      "Unrelated title",
    ]);
    expect(await searchNotes(repo.root, "webhook", { includeInactive: true })).toHaveLength(3);
  });
});
