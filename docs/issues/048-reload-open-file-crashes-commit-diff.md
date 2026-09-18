# Issue #048: `reloadOpenFile` Routes Commit Diffs to Filesystem Loader, Crashing the Viewer

- **Status**: Open
- **Type**: Bug
- **Severity**: High
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) · [`reloadOpenFile`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L266-L270)

---

## Description

When viewing a commit diff in the viewer pane (the v3 feature from #034), `viewFile.kind` is `"diff"` and `viewFile.relPath` is `"commit:<shortHash>"`.

When the user presses `r` to refresh the tree and git state, `handleNormalInput` calls:
```typescript
if (data === "r") {
  this.refresh();
  this.reloadOpenFile();
  this.showNotice("refreshing tree and git");
  return;
}
```

However, `reloadOpenFile` blindly passes `this.viewFile.relPath` to `openRelPath`:
```typescript
reloadOpenFile(): void {
  const relPath = this.viewFile?.relPath;
  if (!relPath) return;
  void this.openRelPath(relPath, true);
}
```

`openRelPath` invokes `loadFile("commit:<shortHash>")`. In `index.ts`, `loadFileCached` attempts to `stat(join(cwd, "commit:<shortHash>"))`. Because `"commit:<shortHash>"` is not a filesystem path, `stat` fails with `ENOENT`, and `loadFile` generates an error card:
```
┌──────────────────────────────────────┐
│ commit:abc1234                       │
│ cannot read file                     │
│ (deleted or permission denied)       │
│ press Tab, then pick another file    │
└──────────────────────────────────────┘
```

The diff view is wiped out and replaced with an error card.

## Code References

- [`navigator.ts:266-270`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L266-L270) — `reloadOpenFile`
- [`navigator.ts:657-662`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L657-L662) — `r` key handler invoking `reloadOpenFile`
- [`navigator.ts:324-362`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L324-L362) — `openCommit` loader
- [`index.ts:121-131`](file:///home/jhonny/Sources/pi-navigator/index.ts#L121-L131) — `loadFileCached` failing `stat` on `"commit:..."`

## Potential Solution

Check whether the open file is a commit diff. If so, reload via `this.openCommit(hash, true)`, or preserve the existing diff without re-querying if `loadCommit` is not provided:

```typescript
reloadOpenFile(): void {
  const file = this.viewFile;
  if (!file) return;
  if (file.kind === "diff" || file.relPath.startsWith("commit:")) {
    const hash = file.commitHash ?? file.relPath.slice("commit:".length);
    if (hash && this.loadCommit) {
      void this.openCommit(hash, true);
    }
    return;
  }
  void this.openRelPath(file.relPath, true);
}
```

Add an optional `keepScroll: boolean = false` parameter to `openCommit` parallel to `openRelPath` so that refreshing does not reset scroll position.

## Acceptance Criteria

- [ ] Pressing `r` while viewing a commit diff preserves the diff view instead of showing an error card.
- [ ] Scroll position and active search in the diff view are preserved across `r` reload when `keepScroll` is true.
- [ ] Unit test in `test/navigator.test.ts` verifies `reloadOpenFile` / `r` on an active commit diff.
- [ ] `npm run typecheck` and `npm test` are green.
