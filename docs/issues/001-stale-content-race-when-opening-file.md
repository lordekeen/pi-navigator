# Issue #001: UI Renders Stale Content and Inconsistent State When Opening a File

- **Status**: Resolved
- **Type**: Bug
- **Severity**: High
- **Component**: [`NavigatorOverlay`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`handleFilesInput`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L421-L463) / [`openRelPath`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L192-L220)

---

## Description

When a user selects and opens a file in the files pane or git panel (via `Enter`), the navigator enters an inconsistent intermediate state while the file loads asynchronously. Stale content from the previously open file remains rendered in the viewer pane, and the file-row accent styling in the files pane continues highlighting the previously opened file instead of the newly selected target.

## Reproduction Steps

1. Launch pi-navigator.
2. Select and open file A (e.g., `README.md`).
3. Move cursor in the files pane to file B (e.g., `package.json`).
4. Press `Enter` to open file B.
5. Notice that while file B is loading:
   - Viewer pane displays the contents and dimensions of file A.
   - Viewer header displays `loading…` metadata tag while showing file A's path.
   - Files pane cursor is on file B, but file A retains the open-file accent highlighting (`isOpen`).

## Root Cause Analysis

1. In [`handleFilesInput`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L438-L444) (and [`handleGitInput`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L485-L486)), pressing `Enter` performs fire-and-forget invocation of `openRelPath`:
   ```typescript
   } else if (current && current.kind !== "dir") {
     this.focus = "viewer";
     void this.openRelPath(current.node.relPath);
   }
   ```
2. In [`openRelPath`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L192-L220), `this.viewLoading = true` is set, but `this.requestRender()` is only called in the `finally` block after `await this.loadFile(relPath)` resolves:
   ```typescript
   async openRelPath(relPath: string, keepScroll = false): Promise<void> {
     this.viewLoading = true;
     this.touch();
     try {
       const file = await this.loadFile(relPath);
       ...
     } finally {
       if (!this.disposed) {
         this.viewLoading = false;
         this.touch();
         this.requestRender();
       }
     }
   }
   ```
3. [`index.ts:194-197`](file:///home/jhonny/Sources/pi-navigator/index.ts#L194-L197) triggers `scheduleRender()` synchronously after handling the `Enter` keystroke.
4. During this intermediate render, `this.viewFile` still points to the old file (or `null` on first load).
5. In [`buildRightRows`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L956), loading placeholder text `(loading…)` is only rendered if `!file && this.viewLoading`. Because `this.viewFile` is not null, it continues rendering the old file's lines.
6. In [`buildFileRow`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L879-L881), `isOpen = row.node.relPath === this.viewFile?.relPath` checks against the old file, leaving the previous row styled as open.

---

## Potential Solution

Reset `this.viewFile` to a placeholder file record for the incoming file path at the start of `openRelPath`, and immediately trigger `this.requestRender()`:

```typescript
async openRelPath(relPath: string, keepScroll = false): Promise<void> {
  this.viewLoading = true;
  if (this.viewFile?.relPath !== relPath) {
    this.viewFile = { kind: "text", relPath, lines: [], sizeBytes: 0 };
  }
  this.touch();
  this.requestRender();

  try {
    const file = await this.loadFile(relPath);
    if (this.disposed) return;
    ...
```

Alternatively, update [`buildRightRows`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L956) to display a loading state whenever `this.viewLoading` is true and the target path differs from the currently displayed path.

---

## Acceptance Criteria

- [x] Selecting a file immediately updates the viewer header and file-row accent highlighting to the target file.
- [x] The viewer displays a loading indicator while the asynchronous read is in flight rather than stale contents.
- [x] No regression in scroll position retention when reloading the same file (`r` key).
