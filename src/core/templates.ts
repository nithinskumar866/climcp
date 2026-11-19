// The empty "forms" a person (or an AI) fills in.
// Each section becomes a Markdown heading:  ## Goal

export const HANDOFF_SECTIONS = [
  "Goal",
  "What's done",
  "Current state",
  "Files changed",
  "Decisions and why",
  "What was tried and didn't work",
  "Tests passed / not run",
  "Next step",
  "Risks and warnings",
] as const;

export const DECISION_SECTIONS = [
  "Decision",
  "Why",
  "Alternatives considered",
  "Consequences",
] as const;

export type HandoffSection = (typeof HANDOFF_SECTIONS)[number];
export type DecisionSection = (typeof DECISION_SECTIONS)[number];

/** Shown in a section that hasn't been filled in yet. */
export const PLACEHOLDER = "_(not filled in)_";

/**
 * Builds the Markdown body from a list of sections.
 * Anything in `filled` is used as the text; missing sections get the placeholder.
 */
function buildBody(sections: readonly string[], filled: Partial<Record<string, string>>): string {
  return sections
    .map((section) => {
      const text = filled[section]?.trim();
      return `## ${section}\n\n${text ? text : PLACEHOLDER}\n`;
    })
    .join("\n");
}

export function handoffBody(filled: Partial<Record<HandoffSection, string>> = {}): string {
  return buildBody(HANDOFF_SECTIONS, filled);
}

export function decisionBody(filled: Partial<Record<DecisionSection, string>> = {}): string {
  return buildBody(DECISION_SECTIONS, filled);
}
