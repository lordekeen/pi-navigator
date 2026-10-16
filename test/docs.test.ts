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

import { NAVIGATOR_CONFIG_FIELDS } from "../settings";

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

  it("documents every settings field id in both living docs (Issue #164)", () => {
    // A setting that ships without a line in either doc cannot be discovered
    // or changed by reading them (the `tree.respectGitignore` drift of #158).
    for (const field of NAVIGATOR_CONFIG_FIELDS) {
      expect(agents, `${field.id} is missing from AGENTS.md`).toContain(field.id);
      // README's settings table must carry the field as its own row.
      expect(readme, `${field.id} is missing from README.md`).toContain(`| \`${field.id}\` |`);
    }
  });

  it("keeps the npm publish jobs behind the npm-publish environment (Issue #183)", () => {
    // The token-bearing jobs must go through the protected environment: its
    // required reviewer gates the staging step, and its `main` branch policy is
    // the boundary that survives a dispatched ref that edits the workflow file.
    // Reference: github.com/lordekeen/pi-navigator/issues/183.
    for (const name of ["release-please.yml", "publish-manual.yml"]) {
      const workflow = readFileSync(join(repoRoot, ".github/workflows", name), "utf8");
      if (workflow.includes("secrets.NPM_TOKEN")) {
        expect(workflow, `${name} must gate its token on the environment`).toContain("environment: npm-publish");
      }
    }
    // The emergency path is also main-only: a branch dispatch must skip the job.
    const manual = readFileSync(join(repoRoot, ".github/workflows/publish-manual.yml"), "utf8");
    expect(manual).toContain("github.ref == 'refs/heads/main'");
  });

  it("keeps the publish workflows hardened (Issue #197)", () => {
    // A manual dispatch and an automatic release stage through one
    // concurrency group, every job is bounded, and Node reinstalls draw on
    // the npm cache.
    const release = readFileSync(join(repoRoot, ".github/workflows/release-please.yml"), "utf8");
    expect(release).toContain("group: npm-publish");
    for (const name of ["release-please.yml", "publish-manual.yml"]) {
      const workflow = readFileSync(join(repoRoot, ".github/workflows", name), "utf8");
      expect(workflow, `${name} must bound its jobs`).toContain("timeout-minutes:");
      expect(workflow, `${name} must cache npm downloads`).toContain("cache: npm");
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

describe("ci.yml (Issue #210)", () => {
  it("gates PRs and main pushes on typecheck + tests at both supported runtimes", () => {
    // Before this workflow, nothing gated a PR on the test suite — a broken
    // branch could merge and only surface after release. Both triggers matter:
    // the PR gate stops the break pre-merge, and the main push re-verifies what
    // landed. Both supported runtimes are exercised (the `engines` floor of 22
    // and the Node 24 the publish pipeline runs), so a regression that only
    // bites one of them is caught at PR time rather than at release.
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("node-version: ${{ matrix.node }}");
    expect(workflow).toMatch(/node:\s*\[22,\s*24\]/);
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("cancel-in-progress: true");
  });
});
