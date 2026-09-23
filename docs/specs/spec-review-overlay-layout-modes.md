# Review: `overlay-layout-modes.md` Spec

**Evaluation**: The specification is exceptionally thorough, structurally sound, and closely aligned with the codebase's existing architecture and conventions (Issue #061 settings, Issue #063 single-source help table, Issue #064 pure view-model seam).

This review validates the spec against the live implementation in `/home/jhonny/Sources/pi-navigator` and identifies critical edge cases and precision adjustments needed prior to implementation.

---

## 🔍 Key Findings & Precision Adjustments

### 1. `render()` separator condition when `filesH === 0` (Git-Viewer)
- **Current code** ([`navigator.ts#L1233`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1233)):
  ```typescript
  if (i === filesH) {
    lines.push(T.frame("├") + T.frame("─".repeat(leftW)) + T.frame("┼") + rightRows[i] + T.frame("│"));
  }
  ```
- **Risk**: In `git-viewer` layout, `filesH === 0`. Without guarding on the layout mode, row `i === 0` would match `i === filesH`, erroneously rendering a horizontal separator at the top of the pane instead of the git header.
- **Spec status**: §7 correctly mandates drawing the separator only in the default layout (`layout === "files-git-viewer"`).
- **Recommendation**: Ensure the spec explicitly instructs:
  ```typescript
  const showSeparator = layout === "files-git-viewer";
  if (showSeparator && i === filesH) { ... }
  ```

### 2. `filesArea(termRows, layout)` call sites and zero-height behavior
- **Call sites verified**:
  1. [`navigator.ts#L740`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L740) in `handleFilesInput` (used for `Ctrl+d` / `Ctrl+u` half-page jumps in the files pane).
  2. [`navigator.ts#L1333`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1333) in `ensureFilesCursorVisible()`, invoked by `alignFilesCursor()` when selecting a changed file from the git pane.
  3. [`test/frame.test.ts#L46-L47`](file:///home/jhonny/Sources/pi-navigator/test/frame.test.ts#L46-L47) in the unit test suite.
- **Zero-height behavior**: In `git-viewer` layout, `layoutRows(body, "git-viewer").filesH` is `0`.
  The spec formula `filesArea(termRows, layout) = Math.max(2, layoutRows(...).filesH - 1)` evaluates to `Math.max(2, -1) = 2`.
  This is safe because it guarantees `ensureFilesCursorVisibleFor(total, area)` never receives `area <= 0`, preventing divide-by-zero or negative scroll bounds if `alignFilesCursor()` is invoked while in `git-viewer`.

### 3. `buildLeftRows` row emission accounting
- **Current code** ([`navigator.ts#L1271-L1324`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1271-L1324)):
  Emits:
  1. Files header (1 row) + `filesAreaRows = filesH - 1`
  2. Separator placeholder: `padTo("", leftW)` (1 row)
  3. Git header (1 row) + `gitArea = body - filesH - 2`
  Total rows: `1 + (filesH - 1) + 1 + 1 + (body - filesH - 2) = body`.
- **In single-pane layouts**:
  - `files-viewer`: Emits files header (1 row) + `filesH - 1` (where `filesH = body`). Emits 0 rows for separator and git. Total: `body` rows.
  - `git-viewer`: Emits 0 rows for files and separator. Emits git header (1 row) + `gitH - 1` (where `gitH = body`). Total: `body` rows.
- **Contract verified**: In all three layouts, `buildLeftRows` returns exactly `body` rows, matching `rightRows.length`.

### 4. `single-source derivations` in `test/help.test.ts`
- **Current test** ([`test/help.test.ts#L157-L162`](file:///home/jhonny/Sources/pi-navigator/test/help.test.ts#L157-L162)):
  ```typescript
  it("parses every subcommand token to its own kind", () => {
    for (const sub of NAVIGATOR_SUBCOMMANDS) {
      const token = sub.cmd.slice(NAVIGATOR_CMD_PREFIX.length);
      expect(parseNavigatorArgs(token)).toEqual({ kind: token });
    }
  });
  ```
- **Change required**: With `NAVIGATOR_SUBCOMMANDS` gaining `all`, `files`, and `git` carrying `layout: NavigatorLayout`, `parseNavigatorArgs` will return `{ kind: "layout", layout: sub.layout }` for these three, and `{ kind: token }` for `settings` / `help`. The test loop must test `{ kind: "layout", layout: sub.layout }` when `sub.layout !== undefined`.

### 5. `parseLayoutMode` contract and warning format
- **Convention** ([`env.ts#L40`](file:///home/jhonny/Sources/pi-navigator/env.ts#L40)):
  Warning messages adhere to:
  ```
  ${trimmed} is not a valid ${NAVIGATOR_LAYOUT_ENV} value; using the file/default setting
  ```
- **Spec §3 D11 & §9 alignment**:
  Empty/whitespace -> `{ layout: undefined }` (no override, no warning).
  Exact match in `NAVIGATOR_LAYOUTS` -> `{ layout: value }`.
  Anything else -> `{ layout: undefined, warning: "${trimmed} is not a valid PI_NAV_LAYOUT value; using the file/default setting" }`.
  This exactly mirrors `parseImageMode` and `parseIconMode`.

### 6. Settings Registry & Menu Wiring
- Appending `layout.default` to `NAVIGATOR_CONFIG_FIELDS`:
  - `buildDefaultSettings`, `normalizeNavigatorSettings`, `serializeNavigatorSettings`, and `applyFieldEdit` automatically handle the new field without custom branching.
  - In `settings_menu.ts`, `buildSettingItems()` formats enum options into the submenu automatically.
  - In `index.ts` (`runSettings`), adding `overrides["layout.default"] = NAVIGATOR_LAYOUT_ENV` when `process.env[NAVIGATOR_LAYOUT_ENV]` is non-empty completes the `— overridden by PI_NAV_LAYOUT (env wins)` annotation.
  - `test/settings.test.ts` sync-guard assertion changes from 5 to 6 fields.

---

## 📋 Acceptance & Commit Slicing Validation

The commit breakdown in §13 ensures `npm run typecheck` and `npm test` pass at each milestone:

| Step | Commit | Status & Verification |
|:---|:---|:---|
| 1 | `feat(frame)` | Add `NavigatorLayout` to `types.ts`; pure derivations (`layoutPanes`, `layoutRows`, `visiblePanes`, `initialFocus`, `cycleFocus`) in `frame.ts`; update `filesArea` and `buildFooterRow` signatures with backward-compatible defaults or updated call sites; add unit tests to `test/frame.test.ts`. |
| 2 | `feat(navigator)` | Add `initialLayout?: NavigatorLayout` to `NavigatorOptions`; update `render()` and `buildLeftRows()` to branch on `layoutPanes`; update Tab/Shift+Tab to use `cycleFocus`; update keybinding descriptions in `help.ts` (Tab and `t`); update `test/navigator.test.ts` and `test/render.test.ts`. |
| 3 | `feat(settings)` | Add `NavigatorLayoutSettings` to `NavigatorSettings`; add `layout.default` to `NAVIGATOR_CONFIG_FIELDS`; add `NAVIGATOR_LAYOUT_ENV` in `constants.ts`; add `parseLayoutMode` in `settings.ts`; wire env in `loadNavigatorSettings` and `runSettings`; update `test/settings.test.ts` (6 fields) and `test/settings_menu.test.ts`. |
| 4 | `feat(commands)` | Add `all`, `files`, `git` subcommands to `NAVIGATOR_SUBCOMMANDS`; update `ParsedNavigatorArgs` and `parseNavigatorArgs`; update command handler in `index.ts` to route `{ kind: "layout" }` to `runNavigator(pi, ctx, parsed.layout)`; update `test/help.test.ts` and `test/index.test.ts`. |
| 5 | `docs` | Update `README.md`, `AGENTS.md`, and resolve `#119` in `docs/issues/119-overlay-layout-modes.md` and `issues_index.md`. Run `test/docs.test.ts` to ensure tracker arithmetic is preserved. |
| 6 | `chore(release)` | Bump version to `0.12.0` in `package.json` and reinstall via `pi install .`. |

---

## 🏁 Summary

The spec is sound, robust, and ready for implementation. The slight adjustments noted above (separator check on `layout === "files-git-viewer"`, `test/help.test.ts` derivation assertion update, and explicit `parseLayoutMode` warning string) are minor implementation details that fully conform to the spec's intended architecture.
