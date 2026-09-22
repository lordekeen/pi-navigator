# Issue #103: Inconsistent Card vs. Text Fallthrough in `viewer_view.ts` for Chafa Images with No Lines

- **Status**: Resolved
- **Type**: Bug / UI Consistency
- **Severity**: Medium
- **Component**: [`viewer_view.ts`](file:///home/jhonny/Sources/pi-navigator/viewer_view.ts#L168-L175), [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1331-L1336)

## Description

In [`viewer_view.ts:168-175`](file:///home/jhonny/Sources/pi-navigator/viewer_view.ts#L168-L175), the viewer pane renderer checks whether to render an image as a card:

```typescript
if (
  file.kind === "binary" ||
  file.kind === "error" ||
  (file.kind === "image" && (file.imageTier !== "chafa" || view.imageAsCard))
) {
  rows.push(...buildCard(file, width, area, view));
  return rows;
}
```

However, in [`navigator.ts:1331-1336`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1331-L1336):
```typescript
const isCard =
  file.kind === "binary" ||
  file.kind === "error" ||
  (file.kind === "image" &&
    (this.imageAsCard || (file.imageTier !== "chafa" && file.imageTier !== "native")));
```

When an image file has `kind: "image"` and `imageTier: "chafa"`, but `imageLines` is empty (`imageLines.length === 0`):
1. In `navigator.ts`, `renderedImage` is `false` because `(file.imageLines?.length ?? 0) > 0` is false.
2. `imageLines` remains `null`.
3. In `viewer_view.ts`, line 146 (`if (view.imageLines)`) does not trigger because `view.imageLines` is `null`.
4. Execution reaches line 171:
   - `file.kind === "image"` is true.
   - `file.imageTier !== "chafa"` is false.
   - `view.imageAsCard` is false.
   The condition evaluates to `false`.
5. The function skips `buildCard` and falls through to line 179 (`// Text-like content`), attempting to render line numbers, gutter, and empty text lines (`file.lines: []`) for an image file.

## Root Cause

`viewer_view.ts` historically differentiated Chafa images based on `file.imageTier !== "chafa"`. When native rendering was added in Issue #069 and view-models extracted in #064, lines 146–166 took over rendering when `view.imageLines` exists. If `view.imageLines` is null/empty, any image file reaching line 168 should render as a card.

## Acceptance Criteria

- [x] [`renderViewerPane`](file:///home/jhonny/Sources/pi-navigator/viewer_view.ts#L127) in `viewer_view.ts` routes any `file.kind === "image"` without rendered lines directly to `buildCard`.
- [x] No image file falls through to the text-like gutter and line numbering view.
- [x] Unit tests in `test/viewer_view.test.ts` verify that an image with `imageTier: "chafa"` and `imageLines: null` or empty array renders the metadata card.
- [x] `npm run typecheck` and `npm test` pass.

---

## Resolution

Two sites now agree that an image is a card whenever it has no rendered lines:

- `viewer_view.ts`: the rendered-image branch guards on a **non-empty**
  `imageLines` (an empty array is truthy and previously rendered blank rows),
  and the card condition below simplifies to `binary || error || image` —
  reaching it with `kind === "image"` means no rendered lines exist.
- `navigator.ts`: `isCard` became the complement of `renderedImage`, which
  already accounts for `imageAsCard` and a non-empty `imageLines`; an image with
  no lines no longer walks the text path (computing rows and mutating
  `viewScroll` for a file that will render as a card).

Tests: four `viewer_view` routing cases (chafa `null` / chafa `[]` / native
`null` → card; non-empty lines → image rows) and a `navigator` case asserting the
card title renders with no gutter rows.
