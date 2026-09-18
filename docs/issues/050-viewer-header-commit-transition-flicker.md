# Issue #050: Viewer Header Flickers Raw `commit:<hash>` Identity During Commit Transitions

- **Status**: Open
- **Type**: Bug / UI Polish
- **Severity**: Low
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) · [`buildViewerHeader`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1404-L1429)

---

## Description

In [`NavigatorOverlay.buildViewerHeader`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1404-L1429), the header path is computed as:
```typescript
const isSwitching = this.viewLoading && this.viewTargetRelPath !== null && this.viewTargetRelPath !== this.viewFile?.relPath;
const currentPath = (isSwitching ? this.viewTargetRelPath : this.viewFile?.relPath) ?? "(no file)";
const file = isSwitching ? null : this.viewFile;
const headerPath =
  file?.kind === "diff" && file.commitHash ? `commit ${file.commitHash}` : this.shortPath(currentPath);
```

When switching commits, `this.viewTargetRelPath` is set to `"commit:<shortHash>"` and `isSwitching` is `true`. Because `file` is `null` while `isSwitching` is `true`, `headerPath` evaluates `this.shortPath(currentPath)` = `"commit:<shortHash>"`.

Once `loadCommit` resolves and `isSwitching` becomes `false`, `headerPath` evaluates to `"commit <shortHash>"`.

This causes an avoidable visual flicker where `"commit:abc1234"` is rendered while loading, then jumps to `"commit abc1234"` upon completion.

## Code References

- [`navigator.ts:1404-1429`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1404-L1429) — `buildViewerHeader`

## Potential Solution

Format commit header paths consistently regardless of whether the file object is already installed:

```typescript
const headerPath =
  (file?.kind === "diff" && file.commitHash) || currentPath.startsWith("commit:")
    ? `commit ${file?.commitHash ?? currentPath.slice("commit:".length)}`
    : this.shortPath(currentPath);
```

## Acceptance Criteria

- [ ] Header displays `"commit <shortHash>"` consistently while a commit load is in flight and after completion.
- [ ] No visual flicker from colon-prefixed `"commit:<shortHash>"` during commit transitions.
- [ ] `npm run typecheck` and `npm test` are green.
