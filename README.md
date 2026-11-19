# contextbaton

**Safe, local-first handoff notes for developers and their AI assistants.**

When you stop working on something (end of day, going on leave, switching projects), the important context gets lost: what was done, why, what failed, and what's next. AI coding assistants make this worse, because every session starts from zero and each tool keeps its own memory.

contextbaton keeps short handoff notes and decisions **as Markdown files in your repo**, shared through normal git. It **removes secrets before anything is saved**, **warns when a note may be out of date**, and lets **any AI assistant read and write notes through MCP**.

- **Local-first:** no cloud, no account, no database, no tracking.
- **Plain files:** `.context/handoffs/*.md` and `.context/decisions/*.md`, reviewed in PRs like any other file.
- **Safe by default:** every write goes through a secret scrubber ([secretlint](https://github.com/secretlint/secretlint) plus generic password, token and JWT patterns), and a pre-commit hook blocks notes that contain secrets.
- **Honest about staleness:** a note is flagged *possibly outdated* when its related files change a lot, a related file is deleted, or nobody has confirmed it in 90 days.
- **Works with any MCP client**, such as Claude Code or Cursor. It builds on `AGENTS.md` rather than replacing it.

## Quick start

```sh
npm install -g contextbaton      # or use npx contextbaton ...
cd your-project
contextbaton init
```

`init` creates `.context/`, adds a short pointer to `AGENTS.md`, installs a git pre-commit hook, and prints the MCP setup for your editor. It's safe to run again.

Requires Node.js 20+ and git.

## Connect your AI assistant

**Claude Code**, run once in the project:

```sh
claude mcp add --scope project contextbaton -- npx -y contextbaton mcp
```

**Cursor**, create `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "contextbaton": {
      "command": "npx",
      "args": ["-y", "contextbaton", "mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

### MCP tools

| Tool | What it does |
|---|---|
| `get_latest_handoff` | The most recent active handoff. Call it at the start of a session. |
| `search_notes` | Word search over handoffs and decisions. |
| `write_handoff` | Saves a handoff, with one field per section. Files changed and git state are filled in automatically. |
| `record_decision` | Saves a decision, its reason, the alternatives and the consequences. |
| `confirm_note` | Marks a note as still true after checking it against the code. |

Notes that may be outdated are always returned with a `⚠ WARNING: POSSIBLY OUTDATED` header and the reasons.

## Commands

| Command | What it does |
|---|---|
| `contextbaton init` | Sets up `.context/`, the `AGENTS.md` pointer, the pre-commit hook and `config.json`. |
| `contextbaton save` | Creates a handoff: collects branch, changed files and recent commits, then asks 4 quick questions. Use `--title`, `--done`, `--next`, `--risks` and `--yes` for scripts. |
| `contextbaton check` | Removes secrets from all notes and lists possibly outdated ones. Exits with 1 if secrets were found, so it works in CI. |
| `contextbaton status` | Shows the latest handoff (next step, risks) and any outdated notes. |
| `contextbaton confirm <note>` | Marks a note as still true. Accepts a file name, a path, or the start of a file name. |
| `contextbaton mcp` | Starts the MCP server (your editor runs this). |

## How it works

### Notes

```
.context/
├── handoffs/2026-11-19-payment-webhook-retries.md
├── decisions/2026-11-19-use-postgres.md
└── config.json
```

Each note has frontmatter (`title`, `author`, `date`, `status: active | done | outdated`, `related_files`, `commit`, `last_confirmed`). A handoff has these sections: Goal · What's done · Current state · Files changed · Decisions and why · What was tried and didn't work · Tests passed / not run · Next step · Risks and warnings.

### Secrets

Every write goes through one function that scrubs **each field separately** and then scans the **finished file** once more. If anything remains, it refuses to save. Secrets are replaced with `[REDACTED: type]`, so `PASSWORD=hunter22` becomes `PASSWORD=[REDACTED: password]`. References such as `${DB_PASSWORD}` or `process.env.X` are left alone.

The pre-commit hook runs `contextbaton check --hook`. It cleans the note files and also checks the **staged** copies (what is actually committed), so the commit stays blocked until you `git add` the cleaned file.

contextbaton detects secrets (keys, tokens, passwords, private keys, connection strings). It does not detect personal data such as emails or phone numbers.

### Outdated notes

A note is measured from **the last commit that changed the note file**. Notes are normally committed with the code they describe, so that commit is the version of the code the note refers to. A note with uncommitted edits counts as fresh. Confirming a note and committing it starts the count again. Only `active` notes are checked.

Limits live in `.context/config.json`:

```json
{ "outdated": { "maxChangedLines": 50, "maxDaysUnconfirmed": 90 } }
```

## Development

```sh
npm install
npm test          # Vitest; most tests run real git in throwaway repos
npm run build
npm run dev -- status
```
