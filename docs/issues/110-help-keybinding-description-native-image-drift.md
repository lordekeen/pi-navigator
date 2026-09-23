# Issue #110: Keybinding Help Description and Documentation Drift Following Native Image Rendering

- **Status**: Resolved
- **Type**: Documentation
- **Severity**: Low
- **Component**: [`help.ts`](file:///home/jhonny/Sources/pi-navigator/help.ts#L63), [`README.md`](file:///home/jhonny/Sources/pi-navigator/README.md#L188), [`AGENTS.md`](file:///home/jhonny/Sources/pi-navigator/AGENTS.md#L62)

## Description

1. **Help Modal Key Description**:
   In [`help.ts:63`](file:///home/jhonny/Sources/pi-navigator/help.ts#L63), the description for the `i` key is:
   ```typescript
   { id: "image", keys: "i", description: "toggle image rendering / metadata card (chafa)" }
   ```
   Following Issue #069 and the implementation of native Kitty and iTerm2 terminal rendering, the `i` key toggles between rendered image and metadata card in *both* native and Chafa modes. The suffix `(chafa)` is outdated and confusing for users using native image mode.

2. **Test Suite Counts**:
   Both `README.md` (line 188) and `AGENTS.md` (line 62) document:
   `nineteen vitest suites (595 cases)`
   Following test cases added in Issues #100 and #101, the current count is 612 tests across 19 suites.

## Proposed Fix

1. Update the description in `help.ts` to `toggle image rendering / metadata card`.
2. Update the test count from 595 to 612 in `README.md` and `AGENTS.md`.

## Acceptance Criteria

- [x] Help modal key description for `i` reflects both native and Chafa rendering modes.
- [x] Test counts in `README.md` and `AGENTS.md` align with `npm test` output.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

- `help.ts`: the `i` row is now `"toggle image rendering / metadata card"` — the
  `(chafa)` suffix was wrong since the native kitty/iTerm2 tier landed.
- `README.md` / `AGENTS.md`: counts updated to the observed final suite —
  **19 suites / 639 cases** (they read 595). Verified against a fresh `npm test`
  run after every code change in this batch.

**Post-resolution drift (Issue #115):** the 639 count was correct when written and
wrong two commits later — #111 (+4 cases) and #112 (+4 cases) took the suite to
647 while `README.md` / `AGENTS.md` kept 639, violating this issue's first
acceptance criterion. The hand-maintained count has now drifted three times
(595 → 612 → 639 → 647), so it was retired rather than corrected again: the docs
state the suite count only, and `test/docs.test.ts` guards it. See
[#115](115-test-count-drift-and-index-bookkeeping.md).
