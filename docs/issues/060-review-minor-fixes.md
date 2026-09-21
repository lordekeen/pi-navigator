# Issue #060: Minor Findings Batch from Full Debugger Code Review

- **Status**: Resolved (v0.6.1)
- **Type**: Bug / Technical Debt (batch)
- **Severity**: Low (each)
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) / [`tree.ts`](file:///home/jhonny/Sources/pi-navigator/tree.ts) / [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) / `AGENTS.md`

---

## Description

Batched minor findings from the v0.6.0 full code review (see [`docs/exploration/debugger-code-review.md`](../exploration/debugger-code-review.md)). All were empirically reproduced; none are speculative.

## Findings

1. **`shortPath` missing `/` boundary** (`navigator.ts:2039`) — `path.startsWith(home)` matches prefix-only: home `/home/jhonny`, cwd `/home/jhonnyfoo/project` renders the title as `~foo/project` (a nonexistent path). Fix: `path === home || path.startsWith(home + "/")`.
2. **Haystack fold-length drift in search** (`viewer.ts:119/125` `markMatches`, `viewer.ts:451` `searchLines`) — `styled.toLowerCase()` can change string length (`İ` U+0130 → `i` + combining dot), so `indexOf` offsets from the folded haystack are applied to the unfolded one: `markMatches("İabc", "abc")` highlights `"bc"`. #035 fixed only the needle side. Fix: detect fold-length-changing characters and fall back to a scan with offset mapping.
3. **`filterRows` ignores hidden-dir ancestry** (`tree.ts:393`) — with showHidden off, filtering surfaces `.github/workflows/ci.yml` while `flattenVisible` hides the whole subtree (the common tracked-file case). Fix: skip hidden dirs in `filterRows` when `!showHidden`, mirroring `flattenVisible`.
4. **`git.ts` module docstring drift** (`git.ts:8`) — says `-uall`, code uses `-unormal` (since #024).
5. **`readCommitDiff` caps on UTF-16 length, not bytes** (`git.ts:376`) — comment claims bytes; `.slice` can also split a surrogate pair. Impact small (maxBuffer bound). Fix: byte-based cap or `decodeUtf8Head`-style handling after slicing.
6. **Icon width accounting** (`navigator.ts` `buildFileRow`) — `icon()` emits glyph+space (2 cells) but `iconW=1` is reserved; rows are 1 cell narrower with icons on (safe, but names truncate 1 cell early). Fix: reserve `iconW = 2`.
7. **`showNotice()` fired from `render()`** (icons one-time hint) — a render-path side effect mutating `this.notice`, starting a timer, and requesting a re-render mid-render (cf. #053). Fix: move the hint to the constructor or first `setTree`.
8. **AGENTS.md suite counts stale** — says six suites / ~169 cases; actual: **8 suites / 285 cases** (settings + images added in #057 without the doc update).

## Acceptance Criteria

- [x] Each finding fixed per its suggested fix (or explicitly dispositioned) — finding 6 adjusted: the icon lives inside `body`, so the fix removes the `iconW` reserve from room/gap instead of reserving 2 (reserving while the icon stays in `body` would double-count and truncate names even earlier).
- [x] Tests for: `shortPath` sibling-home boundary, fold-drift highlight offset, `filterRows` hidden ancestry.
- [x] Render suite stays green at 120×36 / 100×28 / 80×24 / narrow widths (icons-enabled width-safety added).
- [x] `npm run typecheck` and `npm test` green (8 suites / 302 cases).
