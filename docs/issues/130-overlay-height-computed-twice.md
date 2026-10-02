# Issue #130: Overlay Height Is Computed Twice — Host `maxHeight` vs `frame.overlayHeight`

- **Status**: Resolved
- **Type**: Technical Debt / Layout
- **Severity**: Medium
- **Components**: [`constants.ts`](../../constants.ts) (`OVERLAY_OPTIONS`), [`frame.ts`](../../frame.ts) (`overlayHeight`, `bodyRows`, `filesArea`, `viewerArea`), [`index.ts`](../../index.ts) (`getTerminalRows`)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M7](../exploration/ui-skill-compliance-audit.md#medium)

## Description

The overlay's height is resolved by the host **and** re-derived by the component from the same input:

```ts
// constants.ts:158-164 — the host resolves this percentage itself
export const OVERLAY_OPTIONS = { width: "90%", minWidth: 80, maxHeight: "85%", anchor: "center", margin: 1 };
```

```ts
// frame.ts:45-48 — an independent second derivation
export function overlayHeight(termRows: number): number {
  const rows = termRows || 24;
  return Math.max(0, Math.min(Math.floor(rows * 0.85), rows - 2));
}
```

`bodyRows`, `filesArea` and `viewerArea` all derive from it, fed by `getTerminalRows()` (injected from
the host's terminal object — the legitimate way to learn the size).

**This is a deliberate deviation, not an oversight**, and the issue should not be read as "delete the
computation": `frame.ts:41-43` states that letting the height fall *below* the host's floor is exactly
what makes the compact "terminal too small" notice reachable (which is test-pinned at
`test/render.test.ts:419`). The standard's concern is nevertheless real:

> *"The geometry belongs to the host. Pass percentages and let it resolve them. Do not also compute
> `floor(rows * 0.8)` yourself — two sources of truth drift."* — `overlays-and-components.md`

Two literals encode the same intent (`"85%"` and `0.85`), plus an extra `rows - 2` clamp whose
relationship to the host's `margin` is implicit. The render suite pins **width**-safety and the
refusal path; nothing pins that the internally computed height agrees with the box the host actually
allocated. Change one literal and the frame silently disagrees with its container.

## Reproduction Steps

1. (Static) Change `OVERLAY_OPTIONS.maxHeight` to `"70%"` and leave `overlayHeight`'s `0.85` alone.
2. `npm test` stays green — the frame now renders 85%-tall content inside a 70%-tall overlay.

## Root Cause

The component needs its height for interior layout (`render(width)` receives no height), and the
refusal path needs to go below the host's floor — so a second derivation was introduced. Nothing
forces the two to agree, and the constant exists in two forms.

## Proposed Resolution

Pick one, and make the choice explicit rather than incidental:

- **Read it back:** take the resolved bounds from `OverlayHandle.getBounds()` (`onHandle`) and keep a
  local derivation *only* for the refuse-too-small path; or
- **Single constant:** keep the internal derivation but express the ratio once (shared with
  `OVERLAY_OPTIONS`) and add a test asserting the internal height matches the host's resolved box
  across a range of terminal heights (`resolveOverlayLayout` is reachable in pi-tui).

Either way, record the decision (why the overlay may fall below the host's floor) in `DESIGN.md` or
`AGENTS.md` next to the geometry helpers.

## Acceptance Criteria

- [ ] One source of truth for the height ratio, **or** a test asserting internal height == host-resolved height
- [ ] The `rows - 2` clamp's purpose (refusal path / margin relationship) is documented where it lives
- [ ] The compact "terminal too small" notice is still reachable (existing test stays green)
- [ ] The decision is recorded in `DESIGN.md`/`AGENTS.md`
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M7](../exploration/ui-skill-compliance-audit.md) — rule: `overlays-and-components.md`
  §Mounting (geometry belongs to the host) and §Layout budget (refuse rather than mangle)
- Related: [#119](119-overlay-layout-modes.md) (layout derivations in `frame.ts`),
  [#122](122-nav-guard-silent-non-tui-modes.md) (the same mount path)

## Resolution

One source of truth: `OVERLAY_HEIGHT_RATIO` and `OVERLAY_MARGIN_ROWS` live in `constants.ts`, `OVERLAY_OPTIONS.maxHeight` is derived from the ratio, and `frame.overlayHeight()` clamps by the margin constant — so the height the host resolves and the frame drawn into it cannot drift. The deliberate freedom to fall below the frame floor (what keeps the refusal notice reachable) is documented where it lives and in `DESIGN.md`.

Verified: `npm run typecheck` and `npm test` green (20 suites).

