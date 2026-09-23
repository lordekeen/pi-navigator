# Issue #115: Test-Count Drift Reintroduced After #110; #079 Dropped From the Category List

- **Status**: Resolved
- **Type**: Documentation
- **Severity**: Low
- **Components**: `README.md`, `AGENTS.md`, `docs/issues/issues_index.md`
- **Found by**: two-axis code review of `e2d8042...HEAD` (both axes, independently), 2026-09-22

## Description

Two documentation defects, both introduced by the #102–#112 batch:

1. **#110's own acceptance criterion was violated two commits after it was
   written.** #110 required "test counts in `README.md` and `AGENTS.md` align with
   `npm test` output". The count was corrected to 639; #111 (+4 cases) and #112
   (+4 cases) then took the suite to **647**, leaving README and AGENTS asserting
   a number that had been wrong for two commits.
2. **The index lost a category marker and misfiled an issue.** The batch edit that
   added the nine new markers replaced `#079` in the *Technical Debt & Code
   Robustness* list with `#110` — so `#079` (Technical Debt / Type Safety) lost
   its category marker entirely and `#110` (type *Documentation*) was filed under
   Technical Debt.

## Root Cause

The case count is hand-maintained in three places and nothing asserts it, so it
drifts on every commit that adds tests: it has now been wrong at 595 → 612 → 639
→ 647. The category lists have no ownership rule, so a batch edit that prepends a
marker can silently overwrite the neighbour above it.

## Potential Solution

Stop hand-maintaining the number: describe the suite by its *suite* count, which
is statically derivable, and guard that with a test. Restore `#079` to the
Technical Debt list and move `#110` to a category matching its type.

## Acceptance Criteria

- [x] `README.md` and `AGENTS.md` carry no hand-maintained case count.
- [x] The documented suite count matches the actual number of `test/*.test.ts` files.
- [x] A test fails if a hand-maintained case count is reintroduced into either doc.
- [x] `#079` appears in a category list; `#110` appears in a category matching its type.
- [x] The overview arithmetic matches the per-issue `Status` lines.

## Resolution

- `README.md` and `AGENTS.md` now say **19 vitest suites** / **19 suites** /
  **19 files**, with the `(639 cases)` / `(639 cases across 19 files)` counts
  retired rather than corrected — the number has drifted three times and the
  suite count carries the same "did the suite run fully?" signal without the
  maintenance burden.
- New `test/docs.test.ts` guards the invariant: the documented suite count must
  equal `readdirSync("test").filter(f => f.endsWith(".test.ts")).length`, and
  neither doc may reintroduce a `NNN cases` hand-maintained count.
- `issues_index.md`: `#079` restored to *Technical Debt & Code Robustness*;
  `#110` moved to *Bug Fixes & UI Consistency* (help-text drift is a UI-text
  defect, and every other help/UI-text issue lives there); `#113` filed under Bug
  Fixes, `#114` and `#115` under Technical Debt. Overview updated to
  3 pending / 112 resolved / 115 total.
- `#110`'s doc gained a post-resolution drift note pointing here, and `#107`'s
  Resolution claim that `padTo` alone kept its long label width-safe is corrected
  (see #113).
