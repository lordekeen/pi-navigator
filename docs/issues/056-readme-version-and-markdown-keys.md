# Issue #056: README Keybindings and Version Badge Out of Sync with v0.5.0

- **Status**: Resolved
- **Type**: Documentation
- **Severity**: Low
- **Component**: [`README.md`](file:///home/jhonny/Sources/pi-navigator/README.md) · [`## Keys`](file:///home/jhonny/Sources/pi-navigator/README.md#L57-L85)

---

## Description

Two documentation discrepancies exist in [`README.md`](file:///home/jhonny/Sources/pi-navigator/README.md) following the v0.5.0 release:

1. **Stale Version Badge**: Line 5 of `README.md` displays:
   ```markdown
   ![status](https://img.shields.io/badge/status-v0.3.0-green)
   ```
   while [`package.json`](file:///home/jhonny/Sources/pi-navigator/package.json#L3) declares version `0.5.0`.
2. **Missing `m` Keybinding in Keys Table**: The `## Keys` section lists viewer navigation keys (`j`/`k`, `Ctrl+d`/`Ctrl+u`, `/`, `n`/`N`, `w`, `h`/`l`), but omits the newly introduced `m` key for toggling between rendered markdown view and syntax-highlighted code view.

## Code References

- [`README.md:5`](file:///home/jhonny/Sources/pi-navigator/README.md#L5) — status badge
- [`README.md:79-85`](file:///home/jhonny/Sources/pi-navigator/README.md#L79-L85) — Viewer keys table

## Potential Solution

1. Update the status badge in `README.md` to `v0.5.0`.
2. Add the `m` key entry to the `Viewer` scope in the `## Keys` table:
   ```markdown
   | Viewer | `m` | Toggle markdown rendered / code view |
   ```

## Acceptance Criteria

- [x] Status badge in `README.md` reflects the current package version (`v0.5.1`, the patch release shipping this batch).
- [x] `m` keybinding is documented under the `Viewer` section in `README.md`.

## Resolution

Updated status badge in `README.md` from `v0.3.0` to the current release version — `v0.5.1`, the patch release shipping this batch (the reported mismatch was against `package.json` at `0.5.0`) — and added the `m` keybinding (`Toggle markdown rendered / code view`) to the `Viewer` section in the keys table.
