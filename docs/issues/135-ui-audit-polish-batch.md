# Issue #135: UI Compliance Audit Polish Batch (13 Low Findings)

- **Status**: Resolved
- **Type**: Technical Debt / Polish
- **Severity**: Low
- **Components**: [`files_view.ts`](../../files_view.ts), [`git_view.ts`](../../git_view.ts), [`frame.ts`](../../frame.ts), [`diff.ts`](../../diff.ts), [`help.ts`](../../help.ts), [`help_view.ts`](../../help_view.ts), [`navigator.ts`](../../navigator.ts), [`settings.ts`](../../settings.ts), [`index.ts`](../../index.ts)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 Low](../exploration/ui-skill-compliance-audit.md#low)

## Description

The audit's thirteen Low findings, batched in the style of [#060](060-review-minor-fixes.md) and
[#063](063-review-followups.md) — each is a small, independent change, and filing thirteen separate
issues would crowd the tracker without adding information. Every item carries its evidence and the rule
it breaches; tick them off individually as they land.

**L1 — `m` shows a notice where its siblings are silent, and the hint is always advertised.**
`navigator.ts:957` → `showNotice("rendered view only available for markdown files")`, while `n`/`N`
(`:931-935`) and `w` (`:937-941`) and `i` (`:975`) `return` silently for the same class of inapplicable
key; the viewer hint advertises `m mode` unconditionally (`frame.ts:213`). Breaches checklist E —
*"Unavailable actions are silent **and** their hints are hidden"* — on both halves.

**L2 — help modal has no in-box footer row.** `help_view.ts:63-65` draws title, rows and bottom border
only; the modal's own keys (`?`/`Esc`/`q`) are stated by the overlay footer, which `composeHelp`
deliberately never covers (it stops before the last line), so the keys *are* legible — the letter of
*"the modal states its own keys"* is unmet, not the intent. Fold this into
[#132](132-help-modal-truncated-row.md) if the box is reworked there.

**L3 — the git pane shows no scroll position.** `git_view.ts:146-166` renders counts
(`N unstaged · M staged`) but no cursor position and no above/below indicator, unlike the files header
(`3/120`, `files_view.ts:41`). Rule: *"Show position when the list overflows"* (mitigated by git lists
usually being short).

**L4 — the git footer hint is silently cut at 80 columns.** `frame.ts:201-205` documents the width
budget as designed for a 100-column terminal, and `test/render.test.ts:800` protects the focus
indicator, not the hint tail — so `? help  q close` can vanish at 80 columns. The footer does stay one
line (compliant); the loss is the tail.

**L5 — commit subjects render in `dim`.** The row's primary content uses the tertiary/hint step;
`theming.md`: *"Do not use `dim` for content: it is for chrome and hints."*

**L6 — frame borders use `fg("dim")` instead of a border role.** `theming.md` names `border` /
`borderAccent` / `borderMuted`, with `borderMuted` as *"the safest default for a routine frame"*.

**L7 — diff lines use generic colour roles.** `diff.ts` (`styleDiffLines`) maps `+`/`-` to
`success`/`error`/`accent` rather than the host's dedicated `toolDiffAdded` / `toolDiffRemoved` /
`toolDiffContext` tokens, which exist for exactly this.

**L8 — `↓N behind` uses `error` for a non-failure.** `frame.ts:245`: behind-count is a state, not a
failure. `theming.md`: *"Reserve `error` for genuine failure and contradiction."*

**L9 — `row.cmd.length` used as a column width.** `help.ts:90`. Harmless today (command strings are
ASCII), but it is the exact `String.length`-as-width pattern the standard forbids; a `visibleWidth` call
costs nothing.

**L10 — the "terminal too small" notice names no next step.** `navigator.ts:1225` →
`" terminal too small for pi-navigator "`. The refusal itself is **compliant and test-pinned**
(`test/render.test.ts:419`) — better than most — but the rule also asks to name the alternative; for a
read-only TUI-only surface the honest addition is "resize the terminal".

**L11 — the command description is a 118-character run-on.** `index.ts:918` carries the subcommand
grammar and both subcommand names in the `description`, which the standard says crowds the command list
and belongs in the usage text (`/navigator help` already prints the full table). Note the standard's
prescribed home for a signature (`argumentHint`) **does not exist** in the host — so trimming the
description is the available fix, not relocating it.

**L12 — subcommand descriptions are lowercase.** `help.ts:40-50` (`"open overlay with files pane only"`)
rather than sentence case.

**L13 — config warnings never name their file.** `settings.ts:245` and `:386` warn about unknown keys
and parse problems without the path. Rule: *"if a scope applies, say where it landed."*

## Reproduction Steps

Not applicable as a single reproduction — each item is verified in the audit's Low table with its
`file:line`. The render-visible ones (L5–L8, L12) are observable by opening the overlay and reading; the
rest by inspection.

## Root Cause

Mixed, and individually documented above: theme roles chosen before the dedicated tokens were adopted
(L6–L8), hint tables that predate the image/markdown modes (L1), and wording/formatting that predates
the standards pass (L11–L13).

## Proposed Resolution

Take these opportunistically alongside the High/Medium work, with two natural groupings:

- **theme-role pass (L5–L8):** one change-set, one render-suite run — all four are token swaps with no
  logic change;
- **wording pass (L11–L13):** description, subcommand casing and warning scope — touches strings only.

L2 folds into [#132](132-help-modal-truncated-row.md); L10 pairs with the guard work in
[#122](122-nav-guard-silent-non-tui-modes.md); L1 pairs with the hint-visibility half of the same rule.

## Acceptance Criteria

Tick individually:

- [x] L1 — `m` silent when unavailable (or a stated exception) and its hint hidden while inapplicable
- [x] L2 — help modal states its own keys in-box, or the exception is documented
- [x] L3 — git pane shows position when the list overflows
- [x] L4 — footer hints either fit at 80 columns or drop whole items instead of cutting mid-phrase
- [x] L5 — commit subjects use a content step, not `dim`
- [x] L6 — frame borders use a border role token
- [x] L7 — diff lines use the `toolDiff*` tokens
- [x] L8 — the behind counter no longer uses `error`
- [x] L9 — `help.ts` column width uses `visibleWidth`
- [x] L10 — the too-small notice names the next step
- [x] L11 — command description trimmed (with the `argumentHint` note recorded)
- [x] L12 — subcommand descriptions in sentence case
- [x] L13 — config warnings name the file
- [ ] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 Low (L1–L13)](../exploration/ui-skill-compliance-audit.md#low) — each row cites the rule
- Precedent for batching: [#060](060-review-minor-fixes.md), [#063](063-review-followups.md)

## Resolution

All thirteen items are addressed. Four needed a decision rather than a code change, and each says so where it lives.

- **L1** — `m` is silent when the file cannot render as markdown (matching its already-silent siblings `n`/`N`, `i`, `w`), and `getFooterHint` drops the `m mode` item for those files, so the footer stops advertising a dead key. `Footer`/`MODE_HINTS` gained a `markdownApplicable` input; the hint tables stay the single source.
- **L2** — **documented exception**: the modal has no in-box footer because the overlay's own footer row states the modal's keys while it is open (`help_view.ts`). Stating the keys one row below the box is the repo's answer to the rule, and the composition stops before the last line so that footer is never occluded.
- **L3** — an overflowing git list shows `N/M` for the navigable rows, budget-checked against the pane width so it can never squeeze the pane label out (`git_view.ts` + the three values passed from the navigator).
- **L4** — footer hints shed **whole items** to fit (`fitHint`), instead of `joinLeftRight` cutting one mid-phrase at 80 columns; the budget mirrors `joinLeftRight`'s own accounting, so the hint can never be why the focus indicator disappears.
- **L5** — commit subjects use the content step (`text`) with the short hash staying `muted` metadata; the row hierarchy now reads content > metadata instead of the reverse, and `DESIGN.md` was corrected with it.
- **L6** — frame borders use the host's `borderMuted` role.
- **L7** — added/removed/context diff lines use `toolDiffAdded`/`toolDiffRemoved`/`toolDiffContext`, so a theme that styles diffs specifically reaches the diff view.
- **L8** — the git "behind" counter uses `warning`; being behind is state, not a failure.
- **L9** — **audit corrected, no code change**: `help.ts` is deliberately pi-import-free and its command strings are ASCII literals, so `.length` is the correct measure — the audit's `visibleWidth` recommendation would have broken a documented invariant. A comment at the function records why.
- **L10** — the "terminal too small" notice names the next step instead of only the problem.
- **L11** — the command description is a one-line summary (the subcommand grammar lives in `/navigator help`), with the `argumentHint` finding recorded in place: the host has no such field, so trimming was the available fix.
- **L12** — subcommand descriptions are sentence case, through the one subcommand table.
- **L13** — settings warnings about file *content* name the file they came from; env-derived warnings keep naming their env var, because attributing them to the file would be wrong.

Two items (L2, L9) resolved into documentation rather than code on purpose: the rules they were filed against do not describe what the code is doing, and both now say so at the site.

Verified: `npm run typecheck` and `npm test` green (20 suites).

