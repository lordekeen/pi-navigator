/**
 * ansi.ts suites: `sanitizeText`, the untrusted-input guard for
 * repo-controlled text (Issue #201). Every case drives the exported function
 * on plain strings, so no theme, pane or viewer fixture is involved.
 */

import { describe, expect, it } from "vitest";

import { sanitizeText } from "../ansi";

describe("sanitizeText (Issue #201)", () => {
  it("strips control characters, keeps \\n, and maps \\t to a space", () => {
    expect(sanitizeText("a\x1b[31mRED\x07b")).toBe("a[31mREDb");
    expect(sanitizeText("a\x1b]8;;http://x\x07L\x1b]8;;\x07")).toBe("a]8;;http://xL]8;;");
    expect(sanitizeText("tab\there\nnl\rret")).toBe("tab here\nnlret");
    expect(sanitizeText("nel\u0085\u009fdel\u007f")).toBe("neldel");
    expect(sanitizeText("ls\u2028ps\u2029")).toBe("lsps");
    expect(sanitizeText(sanitizeText("x\x1by"))).toBe(sanitizeText("x\x1by")); // idempotent
  });
});
