import { describe, it, expect } from "vitest";
import { findSecrets, scrubSecrets, redactionLabel } from "../src/core/scrubber.js";
import { handoffBody } from "../src/core/templates.js";
import { FAKE_SECRETS, SAFE_TEXTS } from "./fixtures/fake-secrets.js";

describe("scrubber: every fake secret is removed", () => {
  it.each(FAKE_SECRETS.map((s) => [s.name, s] as const))("%s", async (_name, fake) => {
    const { text, findings } = await scrubSecrets(fake.text);

    // 1. The secret is gone. This is the most important check of the whole project.
    expect(text).not.toContain(fake.secret);
    // 2. A clear label is left in its place.
    expect(text).toContain(redactionLabel(fake.type));
    // 3. It was reported.
    expect(findings.map((f) => f.type)).toContain(fake.type);
  });
});

describe("scrubber: normal text is left alone", () => {
  it.each(SAFE_TEXTS)("%s", async (safe) => {
    expect(await findSecrets(safe)).toEqual([]);
    expect((await scrubSecrets(safe)).text).toBe(safe);
  });
});

describe("scrubber: real-world situations", () => {
  it("cleans several secrets inside a full handoff note", async () => {
    const [gh, , , , stripe, , , , db, , , pw] = FAKE_SECRETS;
    const body = handoffBody({
      Goal: "Fix the payment webhook",
      "Current state": `Tested with ${stripe.text}\nand ${db.text}`,
      "Risks and warnings": `${pw.text} is still on staging. ${gh.text}`,
    });
    const { text, findings } = await scrubSecrets(body);

    for (const s of [gh, stripe, db, pw]) expect(text).not.toContain(s.secret);
    expect(findings).toHaveLength(4);
    // The rest of the note is unchanged.
    expect(text).toContain("## Goal\n\nFix the payment webhook");
    expect(text).toContain("is still on staging.");
  });

  it("keeps the key name, so the note still makes sense", async () => {
    const { text } = await scrubSecrets("PASSWORD=" + "Tr0ub4dor" + "&3");
    expect(text).toBe("PASSWORD=[REDACTED: password]");
  });

  it("reports the line and column of each secret", async () => {
    const findings = await findSecrets("line one\nline two token: ghp_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z5A");
    expect(findings).toEqual([{ type: "github", line: 2, column: 17 }]);
  });

  it("findings never contain the secret, so they are safe to print", async () => {
    for (const fake of FAKE_SECRETS) {
      const findings = await findSecrets(fake.text);
      expect(JSON.stringify(findings)).not.toContain(fake.secret);
    }
  });

  it("works when emoji come before the secret", async () => {
    const gh = FAKE_SECRETS[0];
    const { text } = await scrubSecrets("🎉🎉 done! " + gh.text);
    expect(text).toBe("🎉🎉 done! token: [REDACTED: github]");
  });

  it("scrubbing twice changes nothing more (already-clean text stays clean)", async () => {
    const once = (await scrubSecrets(FAKE_SECRETS.map((s) => s.text).join("\n"))).text;
    const twice = await scrubSecrets(once);
    expect(twice.text).toBe(once);
    expect(twice.findings).toEqual([]);
  });
});
