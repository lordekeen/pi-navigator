import { defineConfig } from "vitest/config";

/**
 * Tests run against the real @earendil-works/pi-tui and pi-coding-agent
 * packages (devDependencies, pinned to the running pi version) so viewer wrap
 * math, width accounting and highlighting behave exactly as they do inside pi.
 * The only stubs are side-effectful surfaces such as copyToClipboard, mocked
 * per test file via vi.mock.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});