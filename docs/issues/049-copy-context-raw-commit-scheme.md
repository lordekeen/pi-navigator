# Issue #049: `copyContext` Copies Raw `commit:<hash>` Identity String in Viewer Pane

- **Status**: Open
- **Type**: Bug / UX Consistency
- **Severity**: Medium
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) · [`copyContext`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L864-L882)

---

## Description

When the cursor is on a commit row in the git panel and the user presses `y`, `copyContext` copies the commit hash:
```typescript
else if (row?.kind === "commit") value = row.commit.shortHash;
```
This copies `"abc1234"` to the clipboard, which can be directly pasted into git commands (e.g. `git checkout abc1234`).

However, when the user opens the commit diff into the viewer pane and presses `y` while focus is on the viewer, `copyContext` executes:
```typescript
else if (this.focus === "viewer") {
  value = this.viewTargetRelPath ?? this.viewFile?.relPath ?? "";
}
```
Because the viewer's `relPath` for a diff is `"commit:<shortHash>"`, `value` becomes `"commit:abc1234"`.

Attempting to paste this into the shell (e.g., `git show commit:abc1234` or `git checkout commit:abc1234`) fails with git errors (`fatal: 'commit:abc1234' is not a commit`).

## Code References

- [`navigator.ts:864-875`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L864-L875) — `copyContext` extraction logic
- [`test/navigator.test.ts:680-690`](file:///home/jhonny/Sources/pi-navigator/test/navigator.test.ts#L680-L690) — existing test for copying from git history

## Potential Solution

When copying from the viewer pane and viewing a commit diff, extract the commit hash instead of the URI-like prefix:

```typescript
} else if (this.focus === "viewer") {
  if (this.viewFile?.kind === "diff" && this.viewFile.commitHash) {
    value = this.viewFile.commitHash;
  } else {
    value = this.viewTargetRelPath ?? this.viewFile?.relPath ?? "";
    if (value.startsWith("commit:")) {
      value = value.slice("commit:".length);
    }
  }
}
```

## Acceptance Criteria

- [ ] Pressing `y` while viewing a commit diff in the viewer pane copies the commit hash (e.g. `"abc1234"`), not `"commit:abc1234"`.
- [ ] Unit test in `test/navigator.test.ts` verifies `copyContext` (`y`) behavior while focused on the viewer with an open commit diff.
- [ ] `npm run typecheck` and `npm test` are green.
