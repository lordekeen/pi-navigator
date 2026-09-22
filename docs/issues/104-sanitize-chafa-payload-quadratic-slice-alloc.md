# Issue #104: Quadratic Memory Slicing Allocation in `sanitizeChafaPayload`

- **Status**: Resolved
- **Type**: Performance / Memory Optimization
- **Severity**: Medium
- **Component**: [`images.ts`](file:///home/jhonny/Sources/pi-navigator/images.ts#L602-L628)

## Description

In [`sanitizeChafaPayload`](file:///home/jhonny/Sources/pi-navigator/images.ts#L602), raw terminal output from Chafa (up to 8 MiB as configured by [`IMAGE_MAX_BUFFER_BYTES`](file:///home/jhonny/Sources/pi-navigator/constants.ts#L106)) is parsed using an escape character loop:

```typescript
  // 1. ESC whitelist scan, left to right.
  let cleaned = "";
  let i = 0;
  for (;;) {
    const esc = raw.indexOf(ESC, i);
    if (esc === -1) {
      cleaned += raw.slice(i);
      break;
    }
    cleaned += raw.slice(i, esc);
    const rest = raw.slice(esc);
    const sgr = SGR_RE.exec(rest);
    if (sgr !== null && sgr[0] !== undefined) {
      cleaned += sgr[0];
      i = esc + sgr[0].length;
      continue;
    }
    if (rest.startsWith(CURSOR_HIDE) || rest.startsWith(CURSOR_SHOW)) {
      i = esc + CURSOR_HIDE.length;
      continue;
    }
    return { ok: false, reason: "unexpected escape sequence" };
  }
```

## Root Cause

`const rest = raw.slice(esc);` allocates a new string representing the entire suffix of `raw` on every single escape sequence. A large image rendered by Chafa contains thousands of SGR color and symbol transitions. Allocating an $O(N)$ string slice for each of $M$ escape sequences results in $O(N \cdot M)$ memory allocations, recreating the exact quadratic allocation defect identified and resolved in Issue #011 for `sliceStyled`.

## Proposed Fix

1. Use a sticky regular expression (`y` flag) for matching SGR sequences without string slicing:
   ```typescript
   const SGR_STICKY_RE = /\x1b\[[0-9;]*m/y;
   ```
2. Set `SGR_STICKY_RE.lastIndex = esc` directly on `raw`.
3. Use `raw.startsWith(CURSOR_HIDE, esc)` and `raw.startsWith(CURSOR_SHOW, esc)` using the position argument of `String.prototype.startsWith` instead of slicing `rest`.

## Acceptance Criteria

- [x] `sanitizeChafaPayload` eliminates `raw.slice(esc)` per iteration.
- [x] Valid SGR escape sequences and cursor hide/show sequences continue to be parsed byte-for-byte identically.
- [x] Unexpected escape sequences continue to reject the payload.
- [x] Unit tests in `test/images.test.ts` pass without regressions.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

`SGR_RE` (a `^`-anchored exec over a freshly sliced tail) became
`SGR_STICKY_RE` (`/y`): the loop sets `lastIndex = esc` and executes against
`raw` directly, and the cursor-hide/show checks use
`raw.startsWith(CURSOR_HIDE, esc)` — `raw.slice(esc)` is gone, so the per-escape
O(N) allocation (the #011 class) no longer exists.

Behavior is unchanged: SGR passes through, cursor hide/show is dropped, any
other ESC form still rejects the payload. A dense-SGR test pins byte-identical
output (hundreds of transitions, no reordering or added resets), and the
cursor-hide case now exercises an inline mid-payload occurrence.
