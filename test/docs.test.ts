/**
 * Documentation and tracker guards (Issue #115).
 *
 * The suite's *case* count is deliberately not documented. Hand-maintaining it in
 * README.md / AGENTS.md / issues_index.md drifted three times — 595 → 612 → 639
 * → 647 — because every commit that adds a test must remember to update three
 * documents. The docs state the *suite* count instead, which is derivable, so
 * this suite derives it from the test inventory and fails when the docs, the
 * inventory, or the tracker arithmetic drift.
 *
 * The tracker guards exist because the same class of error hit issues_index.md:
 * a batch edit replaced `#079`'s category marker with `#110`'s, and four issues
 * had no marker at all, while the overview counts are hand-maintained on every
 * resolution.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const issuesDir = join(repoRoot, "docs", "issues");
const issuesIndexPath = join(issuesDir, "issues_index.md");
// `docs/` is a local-only, gitignored development tree, so a fresh clone and
// CI have no tracker to guard: the tracker suites skip there instead of failing
// on a missing file, and run in full on a working tree that has one.
const hasTracker = existsSync(issuesIndexPath);
const index = hasTracker ? readFileSync(issuesIndexPath, "utf8") : "";
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");

/** Test files vitest collects, as basenames without the `.test.ts` suffix. */
function suiteNames(): string[] {
  return readdirSync(join(repoRoot, "test"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => name.slice(0, -".test.ts".length))
    .sort();
}

/**
 * `Status` / `Severity` in either header format the tracker uses: the modern
 * `- **Status**: X` bullet list, or the older `| Status | X |` table that
 * #031/#032/#033 still carry. Literal patterns, not interpolated ones.
 */
const STATUS_PATTERNS = [/^- \*\*Status\*\*: (.+)$/m, /^\| Status \| ([^|]+) \|$/m];
const SEVERITY_PATTERNS = [/^- \*\*Severity\*\*: (.+)$/m, /^\| Severity \| ([^|]+) \|$/m];

const OVERVIEW_ROWS = {
  pending: /^\| \*\*Pending \/ Open\*\* \| (.+)$/m,
  resolved: /^\| \*\*Resolved\*\* \| (.+)$/m,
  total: /^\| \*\*Total\*\* \| (.+)$/m,
} as const;

function firstMatch(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const value = pattern.exec(text)?.[1];
    if (value !== undefined) return value;
  }
  return "";
}

interface IssueFacts {
  id: string;
  status: string;
  severity: string;
}

/** Every numbered issue doc, with its declared status and severity. */
function issues(): IssueFacts[] {
  return readdirSync(issuesDir)
    .filter((name) => /^\d{3}-.*\.md$/.test(name))
    .map((name) => {
      const text = readFileSync(join(issuesDir, name), "utf8");
      return {
        id: name.slice(0, 3),
        status: firstMatch(text, STATUS_PATTERNS),
        severity: firstMatch(text, SEVERITY_PATTERNS),
      };
    });
}

const isResolved = (issue: IssueFacts): boolean => /^Resolved/i.test(issue.status.replace(/\*/g, ""));
const countOf = (list: IssueFacts[], level: string): number =>
  list.filter((issue) => issue.severity.startsWith(level)).length;

/** An overview row's cells as [high, medium, low, total]. */
function overviewRow(pattern: RegExp): number[] {
  return (pattern.exec(index)?.[1] ?? "")
    .split("|")
    .map((cell) => cell.replace(/\*/g, "").trim())
    .filter((cell) => cell !== "")
    .map(Number);
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
    // belong in the resolution record of an issue doc, not in current docs.
    expect(readme).not.toMatch(/\b\d[\d,]*\s+cases\b/i);
    expect(agents).not.toMatch(/\b\d[\d,]*\s+cases\b/i);
  });

  it("pins the README status badge to the shipped version (Issue #155)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
    expect(readme).toContain(`status-v${pkg.version}-`);
  });
});

describe.skipIf(!hasTracker)("issue tracker guards (Issue #115)", () => {
  it("keeps the overview arithmetic true against the issue docs", () => {
    const all = issues();
    const open = all.filter((issue) => !isResolved(issue));
    const done = all.filter(isResolved);
    const levels = ["High", "Medium", "Low"];

    expect(open.length + done.length).toBe(all.length);
    expect(overviewRow(OVERVIEW_ROWS.pending)).toEqual([...levels.map((l) => countOf(open, l)), open.length]);
    expect(overviewRow(OVERVIEW_ROWS.resolved)).toEqual([...levels.map((l) => countOf(done, l)), done.length]);
    expect(overviewRow(OVERVIEW_ROWS.total)).toEqual([...levels.map((l) => countOf(all, l)), all.length]);
  });

  it("files every issue in exactly one category list", () => {
    const categorySection = index.slice(index.indexOf("## 📂 Issues by Category"));
    const markers = [...categorySection.matchAll(/^- \[#(\d{3})/gm)].map((match) => match[1] ?? "");
    const listed = new Set(markers);

    expect(markers.length, "an issue has two category markers").toBe(listed.size);
    for (const { id } of issues()) {
      expect(listed.has(id), `#${id} has no category marker in issues_index.md`).toBe(true);
    }
  });
});
