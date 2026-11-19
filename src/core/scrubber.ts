import { lintSource } from "@secretlint/core";
import { presetRecommend } from "@secretlint/core/builtin";
import { creator as patternRule } from "@secretlint/core/builtin/rules/pattern";

// The secret scrubber.
//
// We don't write our own scanner. secretlint does the detecting (it knows the
// exact shape of GitHub, AWS, Anthropic, OpenAI, Stripe, Slack, npm... keys).
// We only add a few "generic" patterns that secretlint's recommended rules
// skip on purpose, like `password=...`, because in handoff notes those matter.
//
// What this file does:  find each secret  ->  replace it with [REDACTED: type]

type SecretlintConfig = Parameters<typeof lintSource>[0]["options"]["config"];

/** One secret that was found. It deliberately does NOT contain the secret itself, so it's safe to print. */
export interface SecretFinding {
  /** e.g. "github", "password", "privatekey" */
  type: string;
  /** 1-based line and column, so you can find it in an editor. */
  line: number;
  column: number;
}

/** Thrown if a secret still remains after redacting (should never happen, but we check). */
export class ScrubError extends Error {}

export function redactionLabel(type: string): string {
  return `[REDACTED: ${type}]`;
}

// ---------- our extra patterns ----------
//
// Written with String.raw so backslashes stay exactly as typed.
// (?<![A-Za-z0-9])  = "not preceded by a letter or digit" (so `db_password` still counts)
// (?<=...)          = "preceded by ..." : we match only the VALUE, so the result
//                     reads `PASSWORD=[REDACTED: password]` and keeps its meaning.
// (?![$\[<{]|...)   = skip things that only POINT to a secret, like ${DB_PASS},
//                     process.env.X, <your-key>, or an earlier [REDACTED: ...]

const KEY_NAMES = String.raw`password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|auth[_-]?token|token|private[_-]?key`;
const NOT_A_REFERENCE = String.raw`(?![$\[<{]|process\.env|env\.)`;
const VALUE = String.raw`[^\s"'` + "`" + String.raw`,;]{6,}`;

const EXTRA_PATTERNS = [
  {
    // password=hunter22   api_key: "abc..."   "token": "abc..."
    name: "password",
    keywords: [], // [] = always run this pattern
    patterns: [
      String.raw`/(?<=(?<![A-Za-z0-9])(?:${KEY_NAMES})["']?\s*[:=]\s*["']?)${NOT_A_REFERENCE}${VALUE}/gi`,
      // "the password is Tr0ub4dor&3": only if the value has a digit or symbol,
      // so normal sentences like "the password is required" stay untouched.
      String.raw`/(?<=(?<![A-Za-z0-9])(?:password|passwd|pwd)\s+(?:is|was)\s*:?\s*["']?)${NOT_A_REFERENCE}(?=[^\s"']*[0-9!@#$%^&*])${VALUE}/gi`,
    ],
  },
  {
    // JSON Web Tokens (login sessions): three base64 parts, the first two start with "eyJ"
    name: "jwt",
    patterns: [String.raw`/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g`],
  },
  {
    // Authorization: Bearer abc...
    name: "bearer-token",
    keywords: [],
    patterns: [String.raw`/(?<=\bBearer\s+)[A-Za-z0-9._~+\/=-]{20,}/g`],
  },
];

/** Our own patterns: less precise than secretlint's built-in rules, so they lose a tie. */
const GENERIC_TYPES = new Set(EXTRA_PATTERNS.map((p) => p.name));

const CONFIG: SecretlintConfig = {
  rules: [
    {
      id: "@secretlint/secretlint-rule-preset-recommend",
      rule: presetRecommend,
      // Also catch AWS key IDs (AKIA...). Alone they aren't secret, but they don't belong in notes either.
      rules: [{ id: "@secretlint/secretlint-rule-aws", options: { enableIDScanRule: true } }],
    },
    {
      id: "@secretlint/secretlint-rule-pattern",
      rule: patternRule,
      options: { patterns: EXTRA_PATTERNS },
    },
  ],
};

// ---------- finding ----------

interface RawFinding extends SecretFinding {
  start: number;
  end: number;
}

async function scan(text: string): Promise<RawFinding[]> {
  const result = await lintSource({
    source: { content: text, filePath: "note.md", ext: ".md", contentType: "text" },
    // (We don't use maskSecrets: it would also hide our pattern names. That's fine,
    // because we never pass secretlint's raw data on; we only keep type, line and column.)
    options: { config: CONFIG, noPhysicFilePath: true },
  });
  const findings: RawFinding[] = result.messages.map((m) => {
    const short = m.ruleId.replace("@secretlint/secretlint-rule-", "");
    // For our own patterns, the type is the pattern's name ("password", "bearer-token").
    const patternName = (m.data as { PATTERN_NAME?: string } | undefined)?.PATTERN_NAME;
    return {
      type: short === "pattern" && patternName ? patternName : short,
      line: m.loc.start.line,
      column: m.loc.start.column + 1,
      start: m.range[0],
      end: m.range[1],
    };
  });

  // "token: ghp_..." is found twice: by the GitHub rule AND by our generic "token:" pattern.
  // Keep the specific one ("github"), drop the generic duplicate.
  const isGeneric = (f: RawFinding) => GENERIC_TYPES.has(f.type);
  const overlaps = (a: RawFinding, b: RawFinding) => a.start < b.end && b.start < a.end;
  return findings.filter((f) => !(isGeneric(f) && findings.some((o) => !isGeneric(o) && overlaps(f, o))));
}

/** Lists the secrets in a text, without changing it. */
export async function findSecrets(text: string): Promise<SecretFinding[]> {
  return (await scan(text)).map(({ type, line, column }) => ({ type, line, column }));
}

// ---------- redacting ----------

/** Replaces each finding with [REDACTED: type]. Overlapping findings are merged into one. */
function redact(text: string, findings: RawFinding[]): string {
  const sorted = [...findings].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number; type: string }[] = [];
  for (const f of sorted) {
    const last = merged[merged.length - 1];
    if (last && f.start <= last.end) {
      last.end = Math.max(last.end, f.end); // overlaps: grow the previous one
    } else {
      merged.push({ start: f.start, end: f.end, type: f.type });
    }
  }
  // Replace from the END backwards, so earlier positions don't shift.
  let out = text;
  for (const m of merged.reverse()) {
    out = out.slice(0, m.start) + redactionLabel(m.type) + out.slice(m.end);
  }
  return out;
}

/**
 * Finds every secret and replaces it with [REDACTED: type].
 * Afterwards it scans again to make sure nothing was missed. If something still
 * remains, it throws instead of returning text that might leak.
 */
export async function scrubSecrets(text: string): Promise<{ text: string; findings: SecretFinding[] }> {
  const all: SecretFinding[] = [];
  let current = text;
  for (let round = 0; round < 3; round++) {
    const found = await scan(current);
    if (found.length === 0) return { text: current, findings: all };
    all.push(...found.map(({ type, line, column }) => ({ type, line, column })));
    current = redact(current, found);
  }
  throw new ScrubError("secrets were still found after redacting 3 times; refusing to save");
}
