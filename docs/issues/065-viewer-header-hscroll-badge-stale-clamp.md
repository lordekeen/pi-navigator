# Issue #065: Viewer Header `col N` Badge Shows the Requested Offset, Not the Clamped One

- **Status**: Open
- **Type**: Bug / UI Consistency
- **Severity**: Low
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) (`buildRightRows`) / [`viewer_view.ts`](file:///home/jhonny/Sources/pi-navigator/viewer_view.ts) (`buildViewerHeader`)

---

## Description

With word wrap off, the viewer header renders a `col N` badge whenever `viewHscroll > 0`, where `N = viewHscroll + 1` (`viewer_view.ts`, `buildViewerHeader`). The class then clamps `viewHscroll` to the file's real overflow:

```ts
const maxH = Math.max(0, this.cachedMaxLineWidth(file) - contentW);
this.viewHscroll = Math.max(0, Math.min(this.viewHscroll, maxH));
```

The header is built from the **pre-clamp** offset while the body rows are computed from the **clamped** one. When the requested scroll exceeds what the file can offer, the badge reports a column the body never reaches — the indicator and the content disagree.

## Reproduction

1. Open a file whose longest line is narrower than the viewer pane (any short file, e.g. the four-line Markdown fixture in `test/navigator.test.ts`).
2. Leave wrap off and press `l` twice (hscroll += 4 per press).
3. Render: the header shows `col 9`, while the body stays at column 1 (`viewHscroll` is 0 after the clamp).

## Root Cause

`buildRightRows` captures the header's value before the clamp runs (`const hscrollForHeader = this.viewHscroll;`), then computes `display` from the clamped `this.viewHscroll`. That ordering is **pre-existing** (it dates to the original implementation) and was deliberately preserved by the Issue #064 extraction, which was a behavior-identical refactor: `test/navigator.test.ts` ("markdown rendered view" → "resets hscroll on mode toggle …") asserts the badge appears after two `l` presses on a file that cannot scroll, so the badge is currently a *pinned contract*.

The test reaches for the badge as a proxy for "hscroll is live", which is why the artifact went unnoticed: at HEAD the body was already clamped, so the assertion only ever described the badge.

## Potential Solution

Decide which side is the contract, then pin it directly:

1. **Preferred — badge follows the content.** Clamp once, then derive both the badge and the rows from the clamped value (drop the pre-clamp capture in `buildRightRows`). Update the test to assert the *body* scrolls (and the badge appears) on a file that is actually wider than the pane, and that neither scrolls nor badges on a narrow one.
2. **Keep the badge as "requested offset".** Then document it as intentional in the header's doc comment and stop using it as the hscroll liveness proxy in tests.

Either way the fix is small and localized; the only real work is choosing the contract and rewriting one assertion pair so it tests the behavior rather than the artifact.

## Acceptance Criteria

- [ ] Badge and body agree on the effective column offset (or the divergence is documented as intentional in `buildViewerHeader`).
- [ ] The hscroll-reset test in `test/navigator.test.ts` asserts the chosen contract directly on a file wider than the pane, and on a narrow file asserts the badge/scroll are absent.
- [ ] `npm run typecheck` and `npm test` green.

## References

- Found while preserving behavior for [#064](064-navigator-decomposition.md) (`buildRightRows` / `buildViewerHeader` seam)
- Related: [#053](053-horizontal-scroll-rendered-markdown-mutation.md) (hscroll keys in rendered mode), [#059](059-nowrap-wide-char-hscroll-lock.md) (nowrap hscroll cell counting)
- Pre-existing at least since the v1 `buildRightRows` implementation — not a #064 regression
