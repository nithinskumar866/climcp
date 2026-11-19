import { describe, it, expect } from "vitest";
import { getVersion } from "../src/version.js";

describe("getVersion", () => {
  it("returns the version from package.json", () => {
    // A version looks like 1.2.3
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
