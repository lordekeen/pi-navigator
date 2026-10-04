# Issue #136: Syntax Highlighting Stays Stale After a Theme Switch (the `viewerCache` Seam)

- **Status**: Resolved
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

## Resolution Design (frozen 2026-10-04)

**Retain the highlight source, key the style, restyle lazily.** Neither original shape is
used verbatim: `invalidate()` is not the trigger (it also fires on resize), and the cache is
not re-keyed (that pays a re-read per file per theme switch). Instead the *style* becomes a
function of a precise key, derived from the retained source when the key is stale.

1. **Retain the highlight source.** `ViewerFile` gains `styleText?: string` and
   `styleKey?: string`. `viewer.ts` `loadFile` sets both on `text`/`truncated` results — but
   only when the file was actually highlighted (`getLanguageFromPath` returned a language;
   the unstyled fallback is theme-independent, so there is nothing to refresh). `styleText`
   is the exact pre-highlight text (`expanded`, or the capped `head.join("\n")`), so a
   restyle is a pure re-run of the highlight helper. Memory stays bounded by the existing
   caps (`MAX_HIGHLIGHT_BYTES` × `MAX_VIEWER_CACHE_ENTRIES` worst case); `rawText` and
   markdown rendering are unchanged.
2. **A precise style key.** `theme.ts` exports `makeStyleKey(theme: Theme): () => string` — a
   fingerprint of the syntax-token ANSI sequences `highlightCode` closes over
   (`getFgAnsi` for the syntax*/`muted`/`mdCodeBlock` tokens) plus the color mode. It changes
   on a theme switch (named, auto light/dark pair, system palette, in-memory preview) and does
   not on resize/cell-size invalidates, so those stay free.
3. **One restyle primitive.** `viewer.ts` exports `restyleViewerFile(file, styleKey)`:
   re-runs the highlight helper on `file.styleText` and returns a new `ViewerFile` with fresh
   `lines` and the new `styleKey`; returns the same reference when there is nothing to do (no
   `styleText`, or the key already matches). Synchronous — `highlightCode` is synchronous.
4. **`invalidate()` repaints the open file without I/O.** `NavigatorOverlay.invalidate()`
   restyles `this.viewFile` via `restyleViewerFile(..., this.styleKey())` before clearing the
   derived caches. `styleKey` is injected through `NavigatorOptions` (default `() => ""`);
   `index.ts` supplies it from the factory's pi Theme.
5. **Cache hits self-heal without re-reading.** In `session.ts` `loadFileCached`, a hit goes
   through `restyleViewerFile` with the session's current key; when that produced a new object
   it is stored back (refreshing LRU recency) and returned. `viewerCache` keeps its API and its
   entries — a theme switch costs one re-highlight per file actually reopened, never a re-read.
   `SessionDeps` gains an optional `styleKey?: () => string`; `index.ts` supplies it.

Cost profile (documented at the key's definition in `theme.ts` and at the cache's lookup site
in `session.ts`): a theme switch re-highlights the open file immediately, and each cached file
on its next open; no invalidate path ever reads a file, and non-theme invalidates (resize)
restyle nothing because the key is unchanged.

Out of scope — filed as [#141](141-diff-view-stale-theme.md): the commit-diff view styles its
lines with `styleDiffLines` at load and is never cached, so it stays stale on a theme switch.
`restyleViewerFile` no-ops on it (no `styleText`), so this fix does not make it worse.

## Acceptance Criteria

- [x] A theme switch repaints syntax highlighting in the open viewer without reopening the file
- [x] `invalidate()` still never re-reads a file from disk on the invalidate path itself
- [x] The chosen cost profile is documented where the cache key is defined (what a theme switch pays)
- [x] The file-content cache (`viewerCache`) is still not *dropped* by `invalidate()`
- [x] Regression test: highlight under theme A, switch to theme B, assert the rendered rows use B
- [x] `npm run typecheck` and `npm test` green

*(This criterion was moved here from [#123](123-invalidate-stale-styled-caches.md), which owned the
overlay-derived caches and could not satisfy the syntax-highlighting half.)*

## Resolution

Implemented as designed (2026-10-04), version 0.14.4:

- `ViewerFile` gained `styleText`/`styleKey`; `viewer.ts` `loadFile` retains them only when a
  language is known (`getLanguageFromPath`), and exports the synchronous, I/O-free
  `restyleViewerFile(file, styleKey)` — the same reference on a no-op. The `highlightText`
  wrapper now delegates to a sync `highlightLines` core.
- `theme.ts` added `makeStyleKey(theme)`: the 11 syntax-token `getFgAnsi` sequences plus
  `getColorMode()`, with the cost profile documented there. `index.ts` builds one closure per
  overlay invocation from the factory's live theme proxy and gives the same one to the session
  and the overlay, so both restyle triggers stay in lockstep.
- `NavigatorOverlay.invalidate()` restyles the open file before clearing the derived caches;
  `session.ts` `loadFileCached` restyles a cache hit and stores the result back (refreshing
  LRU recency). Neither path reads a file: a theme switch costs one re-highlight per file
  actually reopened, and entries are never dropped. A harness with no `styleKey` dep has no
  staleness notion and serves hits as stored.
- Tests (+15; 21 suites / 830 cases): retention rules (including tab-expanded `styleText` and
  the truncated capped head), `restyleViewerFile` new-object/no-op semantics on both kinds,
  cache self-heal with the loader still called once across a key flip, invalidate-restyle vs
  resize no-op driven through the production overlay path, and `makeStyleKey`
  stability/change/token-coverage.
- The commit-diff view has the same staleness and was out of scope here; filed as
  [#141](141-diff-view-stale-theme.md).

Verified: `npm run typecheck` clean; `npm test` 830/830 green across 21 suites.

## References

- [#123](123-invalidate-stale-styled-caches.md) — the half that shipped (overlay-derived caches)
- `docs/specs/` — the viewer/highlighting split ("highlight in the loader", `git.ts` stays theme-free)
- `docs/issues/010-truncation-bright-ellipsis.md` — the sibling case where an upstream styling
  decision could not be fixed at the point of rendering
