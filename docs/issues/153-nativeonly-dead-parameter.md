# Issue #153: `renderedImageVerdict`'s `nativeOnly` Parameter Is Dead

- **Status**: Open
- **Type**: Technical Debt / Dead Code
- **Severity**: Low
- **Component(s)**: `navigator.ts`

---

## Description

`renderedImageVerdict(nativeOnly = false)` was introduced by Issue #143
(commit `38ce95d`) with a doc comment claiming `nativeOnly` "keeps the
native-pinned scroll gate structural". It never does:

```ts
private renderedImageVerdict(
  nativeOnly = false,
): Extract<ImageVerdict, { kind: "rendered" }> | null {
  ...
  if (nativeOnly && verdict.renderer !== "native") return null;
  return verdict;
}
```

`renderedImageVerdict()` has exactly one caller (`handleViewerInput`, line
1042) and never passes the flag; the native scroll gate is derived at the call
site from `renderedVerdict.renderer === "native"`. The `nativeOnly` branch is
therefore unreachable and the doc comment is inaccurate. Confirmed by an
open-code-review finding and by call-site inspection.

## Fix

Delete the parameter and its branch and fix the doc comment; no call-site
change. Behavior is identical (the removed branch cannot execute), and no test
references `nativeOnly`.

## Acceptance Criteria

- [ ] `renderedImageVerdict` takes no parameters; no `nativeOnly` reference
  remains in the source.
- [ ] The doc comment describes the one verdict read without the stale claim.
- [ ] `npm run typecheck` and `npm test` green; suite count unchanged.

## References

- #143 — added the one per-load verdict read and the parameter.
- #069 / #112 — the native scroll pin the comment referred to; the gate lives at
  the call site.
- Found by an open-code-review sweep over `3f1752a..ea25a83`
  (2026-10-04), finding 4 of 4.
