# Issue #029: Git Pane Dynamic Rows + Richer Badges

- **Status**: Resolved
- **Type**: Feature
- **Severity**: Low
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) [`gitRows`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`codeText`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`types.ts`](file:///home/jhonny/Sources/pi-navigator/types.ts)

---

## Description

The git panel always renders `Unstaged (N)` and `Staged (N)` group rows, even when a list is empty — wasting a row on `Unstaged (0)` / `Staged (0)`. When nothing is staged or unstaged, the panel should read just `Clean` + `History`. Separately, rename/copy codes (`R`/`C`) flow through `parsePorcelain` but render through `codeText`'s muted default; giving them status colors makes the panel communicate more at a glance.

## Code References

- [`navigator.ts:322-350`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) (`gitRows`)
- [`navigator.ts:1062-1071`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) (`codeText`)

## Potential Solution

- `gitRows()`: only push the `Unstaged (N)`/`Staged (N)` group row when the list is non-empty; keep the existing `Clean` row (dim) when both are empty; header summary stays always-on.
- `codeText()`: `R → T.warning`, `C → T.success`; `M/A/D/??/!!` unchanged.

## Acceptance Criteria

- [x] Empty `unstaged`/`staged` lists produce no `Unstaged (0)` / `Staged (0)` rows; `Clean` shows when both are empty.
- [x] Non-empty lists render their group rows as before.
- [x] `codeText("R")` → warning, `codeText("C")` → success; existing codes unchanged.
- [x] Header "N unstaged · M staged" summary always rendered.
- [x] `npm run typecheck` and `npm test` green.

## Resolution

Rewrote the group-row block in `gitRows()` to push `Unstaged (N)` only when `unstaged.length > 0` and `Staged (N)` only when `staged.length > 0`; both empty → the existing `Clean` row. Added `R→T.warning`, `C→T.success` to `codeText`. Tests: navigator (empty groups hidden, populated kept, header counts), render (empty/groups width-safe, populated restores rows).
