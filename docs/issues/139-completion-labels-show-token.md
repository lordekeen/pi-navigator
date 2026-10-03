# Issue #139: Subcommand Completions Are Labelled With a Sentence Instead of the Token

- **Status**: Resolved
- **Type**: Bug / UX
- **Severity**: Low
- **Components**: [`help.ts`](../../help.ts) (`NAVIGATOR_SUBCOMMANDS`), [`index.ts`](../../index.ts) (`navigatorCompletions`)
- **Found by**: live use of `/navigator ` argument completion, 2026-10-03

## Description

Typing `/navigator ` and then the start of a subcommand shows a popup whose row name is a descriptive
sentence rather than the token being typed:

```text
Open files + viewer overlay   Open overlay with files pane only
```

The token itself — `files` — never appears as the row name, and for two entries it does not appear at
all (`set` → "Set a config value", `help` → "Show the command list"), so the popup does not confirm
what will be inserted. Selecting an entry still inserts the correct token (`value` is what the host
inserts), so the defect is presentation-only.

## Root Cause

`navigatorCompletions` mapped the table's `completionLabel` column into the host's `label` field and
`desc` into `description` (`index.ts:266-272`). The host's `AutocompleteItem` renders `label` as the
row name and `description` as the secondary column, so a descriptive string in `label` displaces the
token. The host's own completions do the opposite: its command list and theme selector label items
with the value (`autocomplete.js`, `theme-selector.js`).

## Reproduction Steps

1. Type `/navigator ` in the pi editor, then `f` (or any subcommand prefix).
2. The popup row reads "Open files + viewer overlay" instead of `files`.

## Proposed Resolution

Label each item with the token (`value`) and carry the sentence in `description`; rename the table
column so its name matches its new role.

## Acceptance Criteria

- [x] Every completion item's `label` equals its `value` (the token)
- [x] The popup description keeps the layout sentence ("Open files + viewer overlay")
- [x] `/navigator help` rows are unchanged (they render `desc`)
- [x] `npm run typecheck` and `npm test` green

## References

- Host contract: `AutocompleteItem { value, label, description? }` (pi-tui `autocomplete.d.ts`)
- Precedent: the host labels its own command list and theme selector with the value
- Related: [#134](134-argument-and-completion-handling.md) (completion polarity and near-miss recovery)

## Resolution

The completion mapping now returns `{ value: token, label: token, description: sub.completionDescription }`,
and the table column was renamed `completionLabel` → `completionDescription` so the field name matches
its role (the popup's secondary column). The layout openers keep their sentence — a row now reads
`files` · `Open files + viewer overlay` — and `set`/`help` show their tokens too. `desc` remains the
`/navigator help` row text, untouched.

Pinned by `test/index.test.ts` ("labels every completion with its token and describes the layout",
including a `label === value` sweep over every item) and `test/help.test.ts`'s projection and prefix
tests, all rewritten for the new shape. `npm run typecheck` and `npm test` green (20 suites, 802
cases). version 0.14.2.
