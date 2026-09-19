# Issue #053: Horizontal Scroll Keys Mutate State During Render in Rendered Mode

- **Status**: Resolved
- **Type**: Bug / UI Polish
- **Severity**: Low
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) · [`handleViewerInput`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L873-L877) · [`buildRightRows`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1436-L1439)

---

## Description

In [`NavigatorOverlay.handleViewerInput`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L848-L851), the `w` (word wrap toggle) key is properly guarded when viewing rendered markdown because rendered markdown is inherently wrapped to `contentW`:

```typescript
// navigator.ts:848-851
} else if (data === "w") {
  if (this.viewRenderMarkdown && this.canRenderMarkdown(this.viewFile)) {
    return;
  }
  this.viewWrap = !this.viewWrap;
  this.viewHscroll = 0;
```

However, horizontal scroll keys (`h`, `l`, `Key.left`, `Key.right`) do not have an equivalent guard:

```typescript
// navigator.ts:873-877
} else if (matchesKey(data, Key.left) || data === "h") {
  this.viewHscroll = Math.max(0, this.viewHscroll - 4);
} else if (matchesKey(data, Key.right) || data === "l") {
  this.viewHscroll += 4;
}
```

When the user presses `h` or `l` in rendered markdown mode, `this.viewHscroll` is modified and `this.touch()` schedules a re-render.

During the render pass in [`buildRightRows`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1436-L1439), `this.viewHscroll` is unilaterally reset to `0`:

```typescript
// navigator.ts:1436-1439
if (useRendered && file) {
  contentW = Math.max(10, rightW - 2);
  this.viewHscroll = 0;
}
```

This mutates component state inside a rendering method and causes unnecessary render passes when users inadvertently hit horizontal scroll keys while viewing rendered markdown.

## Code References

- [`navigator.ts:873-877`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L873-L877) — `handleViewerInput` horizontal scrolling
- [`navigator.ts:1436-1439`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1436-L1439) — `buildRightRows` state mutation

## Potential Solution

Return early from horizontal scroll key handling in `handleViewerInput` when rendered markdown mode is active:

```typescript
} else if (matchesKey(data, Key.left) || data === "h") {
  if (this.viewRenderMarkdown && this.canRenderMarkdown(this.viewFile)) return;
  this.viewHscroll = Math.max(0, this.viewHscroll - 4);
} else if (matchesKey(data, Key.right) || data === "l") {
  if (this.viewRenderMarkdown && this.canRenderMarkdown(this.viewFile)) return;
  this.viewHscroll += 4;
}
```

## Acceptance Criteria

- [x] Pressing `h`, `l`, `Left`, or `Right` in rendered markdown mode is a no-op and does not call `touch()`.
- [x] No state mutation (`this.viewHscroll = 0`) occurs inside `buildRightRows`.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Guarded `Key.left`, `h`, `Key.right`, and `l` in `handleViewerInput` to return early when `this.viewRenderMarkdown && this.canRenderMarkdown(this.viewFile)` is true, matching the existing `w` key guard. Removed the side-effectful `this.viewHscroll = 0` assignment from `buildRightRows`. Added unit tests in `test/navigator.test.ts`.
