# Issue #105: Multi-Character Pasting and Non-BMP Unicode Ignored in Search and Filter Modes

- **Status**: Resolved
- **Type**: Bug / UX
- **Severity**: Medium
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L137-L140)

## Description

In [`navigator.ts:137-140`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L137-L140), printable character handling for the `/` filter and search modes is defined as:

```typescript
function printableChar(data: string): string | null {
  const decoded = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : null);
  return decoded && decoded.length === 1 ? decoded : null;
}
```

This helper is invoked by both `handleFilterInput` ([line 607](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L607)) and `handleSearchInput` ([line 634](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L634)).

Because the helper strictly requires `decoded.length === 1`:
1. **Pasting text**: When a user pastes a string or word (e.g., via terminal paste / `Shift+Insert` / `Ctrl+Shift+V`), the incoming chunk has `data.length > 1`. `printableChar` returns `null`, and the pasted input is silently dropped.
2. **Non-BMP Unicode Characters**: Characters outside the Basic Multilingual Plane (BMP)—such as emojis (`🚀`), symbols, and supplementary CJK characters—are represented in JavaScript UTF-16 as surrogate pairs with `.length === 2`. They are rejected by `decoded.length === 1` and cannot be typed or searched.

## Proposed Fix

Allow multi-character printable strings while rejecting terminal escape sequences (ESC `\x1b`) and ASCII control characters (except space):
```typescript
function printableText(data: string): string | null {
  const decoded = decodeKittyPrintable(data);
  if (decoded && decoded.length === 1) return decoded;
  if (!/[\x00-\x1f\x7f-\x9f\x1b]/.test(data) && data.length > 0) {
    return data;
  }
  return null;
}
```
Update `handleFilterInput` and `handleSearchInput` to append the validated text.

## Acceptance Criteria

- [x] Pasting multi-character words into filter and search inputs appends the full string.
- [x] Non-BMP Unicode characters (surrogate pairs) are accepted.
- [x] Terminal escape sequences (ANSI control sequences, arrow keys, function keys) continue to be filtered or handled by their respective key handlers.
- [x] Unit tests in `test/navigator.test.ts` verify multi-character paste and non-BMP character input in both filter and search modes.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

`printableChar` (single-code-unit only) became `printableText`: the Kitty
decoder's result is used when present, otherwise the raw chunk is accepted whole
unless it carries any C0/C1 control character — which rejects ESC sequences,
unmatched special keys, and DEL (`\x7f`, which the old `>= " "` test wrongly
admitted) while allowing pasted strings and surrogate pairs.

Backspace in both modes now deletes the last **full code point**
(`deleteLastCodePoint`), so deleting an emoji can no longer strand a lone
surrogate. All `matchesKey` branches stay first and unchanged.

Tests: multi-char paste and emoji input in both modes, surrogate-safe backspace
(asserted with a lone-surrogate regex), and rejection of escape-sequence and DEL
chunks.
