/**
 * Documentation and tracker guards (Issue #115).
 *
 * The suite's *case* count is deliberately not documented. Hand-maintaining it in
 * README.md / AGENTS.md drifted three times — 595 → 612 → 639 → 647 — because
 * every commit that adds a test must remember to update both documents. The docs
 * state the *suite* count instead, which is derivable, so this suite derives it
 * from the test inventory and fails when the docs or the inventory drift.
 *
 * The local tracker guards (issue docs + issues_index.md arithmetic) retired with
 * the local tracker itself: the issues moved to GitHub, so there is no local
 * index left to guard.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");

/** Test files vitest collects, as basenames without the `.test.ts` suffix. */
function suiteNames(): string[] {
  return readdirSync(join(repoRoot, "test"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => name.slice(0, -".test.ts".length))
    .sort();
}

describe("documentation guards (Issue #115)", () => {
  it("documents the real suite count in README.md and AGENTS.md", () => {
    const suites = suiteNames().length;
    expect(readme).toContain(`${suites} vitest suites`);
    expect(agents).toContain(`${suites} suites`);
    expect(agents).toContain(`(${suites} files)`);
  });

  it("lists every suite in the AGENTS.md test inventory", () => {
    const inventory = /- \*\*Tests:\*\* Vitest,[^(]*\(([^)]*)\)/.exec(agents)?.[1] ?? "";
    const listed = inventory.split(",").map((name) => name.trim().replace(/`/g, ""));
    expect(listed.length).toBeGreaterThan(0);
    for (const suite of suiteNames()) {
      expect(listed, `${suite} is missing from the AGENTS.md test inventory`).toContain(suite);
    }
  });

  it("keeps the package.json files allowlist complete and on disk (Issue #151)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { files: string[] };
    // Every publishable root module must be allowlisted, or the published
    // tarball cannot load (the `session.ts` gap of Issue #140/#151).
    const rootModules = readdirSync(repoRoot)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => name !== "vitest.config.ts");
    for (const module of rootModules) {
      expect(pkg.files, `${module} is missing from package.json "files"`).toContain(module);
    }
    // Deletion direction: a stale entry means `files` promises a file that
    // npm will not find.
    for (const entry of pkg.files) {
      expect(existsSync(join(repoRoot, entry)), `package.json "files" entry "${entry}" does not exist on disk`).toBe(true);
    }
  });

  it("does not reintroduce a hand-maintained case count", () => {
    // A case count is only honest for the commit that wrote it; historical ones
    // belong in the resolution record of the original issue, not in current docs.
    expect(readme).not.toMatch(/\b\d[\d,]*\s+cases\b/i);
    expect(agents).not.toMatch(/\b\d[\d,]*\s+cases\b/i);
  });

  it("reads the README status badge from the registry, not a hand-pinned version (Issue #155)", () => {
    // The release PR bumps package.json but cannot rewrite README (Issue
    // #162), so a hand-pinned badge desyncs on every release. The npm-version
    // badge tracks what is actually published, and this guard keeps a
    // hand-pinned one from creeping back.
    expect(readme).toContain("img.shields.io/npm/v/@lordekeen/pi-navigator");
    expect(readme).not.toMatch(/badge\/status-v\d+\.\d+\.\d+/);
  });
});
