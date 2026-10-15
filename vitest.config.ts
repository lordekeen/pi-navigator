import { defineConfig } from "vitest/config";

/**
 * Tests run against the real @earendil-works/pi-tui and pi-coding-agent
 * packages (devDependencies, kept in step with the host pi version — see
 * the dev-pin note in AGENTS.md) so viewer wrap math, width accounting and
 * do inside pi. The only stubs are side-effectful surfaces such as
 * copyToClipboard, mocked per test file via vi.mock.
 *
 * Import resolution note: vitest resolves module ids itself; the tsc --noEmit
 * check compiles this file with moduleResolution "bundler", matching pi's
 * jiti-based extension loader.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
