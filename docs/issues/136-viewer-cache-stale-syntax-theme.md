# Issue #136: Syntax Highlighting Stays Stale After a Theme Switch (the `viewerCache` Seam)

- **Status**: Open
- **Type**: Bug / Theming
- **Severity**: Medium
- **Component(s)**: [../../viewer.ts](../../viewer.ts), [../../index.ts](../../index.ts), [../../navigator.ts](../../navigator.ts)
- **Found by**: senior agent (seam finding) while implementing [#123](123-invalidate-stale-styled-caches.md); re-verified against source by the orchestrator

## Description

[#123](123-invalidate-stale-styled-caches.md) delivered the overlay half of the theme-change
problem: `NavigatorOverlay.invalidate()` now clears every cache *derived from* styled strings
(the composed frame, files/git rows, search marks, rendered markdown), so those repaint against
the theme now in force.

Syntax highlighting does not, because it is baked in **upstream of** those caches:

1. `viewer.ts` calls `highlightCode()` once, at load time, and returns already-styled lines
   ([`viewer.ts:299`](../../viewer.ts)).
2. `navigator.ts` holds that styled `ViewerFile` in overlay state ([`navigator.ts:215`](../../navigator.ts)).
3. `index.ts`'s `viewerCache` stores the same already-styled lines, keyed on `relPath` + mtime,
   with a variant that encodes image geometry only — never the theme.

So on a theme switch, a cache hit serves lines that were highlighted with the *previous* theme's
token colours. Clearing the overlay's derived caches re-derives display rows from those stale
strings; the syntax colours survive until the file is reopened (`r`) or reloaded by an external
change. This was deliberately left out of #123 rather than papered over: #123's own acceptance
criterion promised a repaint "including syntax highlighting", and the honest reading is that the
remaining half needs a new cross-module seam, not more cache clearing.

## Reproduction Steps

1. Open `/navigator` on a TypeScript file and leave it in the viewer.
2. Switch the pi theme (the host calls `ui.invalidate()` on the open component).
3. Observe: frame, borders, search marks and markdown repaint; the code's syntax colours do not.
4. Press `r` (reload) — the same file repaints correctly, proving the staleness is the cached
   styled string rather than the theme lookup.

## Root Cause

The theme is not part of any cache key between the highlighter and the viewer, and `invalidate()`
has no way to force a re-highlight: `highlightCode` runs inside the loader (`loadFile`), and the
invalidate path is a pure cache clear that deliberately never re-reads files.

## Proposed Resolution

Two shapes, both small but with different cost profiles — this is a design choice, not a
mechanical fix, which is why it was split out rather than rushed:

- **Re-key:** add a theme generation counter to the `viewerCache` variant, so a theme change
  misses the cache and the next open re-highlights. Cheapest to implement, but it pays a full
  re-read + re-highlight per file per theme switch, and `invalidate()` also fires for cell-size
  changes and grammar loads, where a re-highlight is wasted work.
- **Re-highlight from cached raw text:** keep the raw (unstyled) text alongside the styled rows
  and re-run only `highlightCode` on invalidate. Avoids re-reading files and bounds the work to
  highlighting, but requires the loader to expose a re-style entry point and the overlay to hold
  raw text (the loader currently drops it).

A third option — dropping `viewerCache` on theme change — is the blunt version of the first and
loses the mtime-keyed reuse that makes reopening files cheap.

## Acceptance Criteria

- [ ] A theme switch repaints syntax highlighting in the open viewer without reopening the file
- [ ] `invalidate()` still never re-reads a file from disk on the invalidate path itself
- [ ] The chosen cost profile is documented where the cache key is defined (what a theme switch pays)
- [ ] The file-content cache (`viewerCache`) is still not *dropped* by `invalidate()`
- [ ] Regression test: highlight under theme A, switch to theme B, assert the rendered rows use B
- [ ] `npm run typecheck` and `npm test` green

*(This criterion was moved here from [#123](123-invalidate-stale-styled-caches.md), which owned the
overlay-derived caches and could not satisfy the syntax-highlighting half.)*

## References

- [#123](123-invalidate-stale-styled-caches.md) — the half that shipped (overlay-derived caches)
- `docs/specs/` — the viewer/highlighting split ("highlight in the loader", `git.ts` stays theme-free)
- `docs/issues/010-truncation-bright-ellipsis.md` — the sibling case where an upstream styling
  decision could not be fixed at the point of rendering
