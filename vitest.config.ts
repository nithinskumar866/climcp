import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many tests run real git commands in throwaway repos. Starting git is slow
    // on Windows (antivirus scans each new process), so allow more than the default 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
