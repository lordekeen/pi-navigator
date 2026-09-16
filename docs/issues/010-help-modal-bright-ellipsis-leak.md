# Issue #010: Help Modal Leaks a Bright Ellipsis Out of the Muted Style at Narrow Widths

- **Status**: Resolved
- **Type**: Bug
- **Severity**: Medium
- **Component**: [`composeHelp`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1162-L1203) / [`padTo`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1208-L1214) / [`joinLeftRight`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L792-L802) / [`buildFileRow`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L920-L923) / [`buildGitRow`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L953-L961) / [`buildCard`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1154-L1160)

---

## Description

When the help modal (`?`) is opened on a narrow terminal (roughly 40–62 columns), truncated description rows and the footer hint show a bright `...` ellipsis that breaks out of the dim/muted style, making the modal look visually broken. The same root cause also affected the title row when the branch label plus counters exceeded the inner width, the file-tree and git-panel rows when names or commit subjects overflowed the left column, and the binary/image/error card body when a long message overflowed the card.

## Reproduction Steps

1. Launch pi-navigator in a ~50-column terminal.
2. Press `?` to open the help modal.
3. Observe the longest description row (`Tab / Shift+Tab  cycle pane focus (files, git, v`…) and the footer hint (`j k scroll  q Esc ? clo`…): the `...` ellipsis renders in bright default color instead of dim, popping out of the muted modal.

## Root Cause Analysis

1. `@earendil-works/pi-tui`'s `truncateToWidth` (alias `n`) finalizes every truncation with ANSI resets around its ellipsis: `finalizeTruncatedResult` returns `` `${prefix}${reset}${ellipsis}${reset}` `` (a trailing reset is appended even when the ellipsis is empty). This is defensive — it closes any open style so the ellipsis isn't accidentally colored — but it injects `\x1b[0m` into the result on *plain* text too.
2. In [`composeHelp`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1191), the description was pre-truncated on **plain** text (`truncateToWidth(description, boxW - 22)`) and then wrapped in `T.muted(...)`. The injected reset closed the muted span before the ellipsis, so `...` rendered in bright default. The same pattern (`T.dim(truncateToWidth(plain, w))`) affected git commit subjects and (`T.muted(truncateToWidth(text, w))`) the binary/image/error cards.
3. [`padTo`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1211) and [`joinLeftRight`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L798) truncated **styled** strings with the default `"..."` ellipsis. When the styled content (footer hint, title branch + counters) exceeded the width, the injected reset closed the open style and the `...` leaked in bright default.
4. The width-safety tests use a no-op theme and `visibleWidth`, which strips ANSI — so the rows were "width safe" on paper while the reset artifact was invisible to the assertions. The `\x1b[0m` only becomes a visible color shift with a real theme.

## Potential Solution

- `composeHelp`: compute the real description column (`boxW - 20`, not the prior `boxW - 22` which cut two columns too early); truncate the plain description with an **empty** ellipsis, strip the injected reset, and append a `\u2026` so the ellipsis stays inside the `T.muted` span.
- `padTo`, `joinLeftRight`, `buildFileRow`, `buildGitRow` (file and commit branches), and `buildCard`: truncate with an **empty** ellipsis so styled text hard-cuts with a single clean reset instead of leaking a bright `...`. Where `truncateToWidth` was called twice on the same input (`buildFileRow`, `buildCard`), compute it once and reuse the result so the padding/gap math matches the rendered content.

## Acceptance Criteria

- [x] No rendered help row contains a `\x1b[0m...` (reset + default three-dot ellipsis) artifact at any width.
- [x] Truncated help descriptions show a dim `…` indicator inside the muted style.
- [x] The footer hint, title row, file-tree rows, git-panel rows, and card body hard-cut cleanly (no bright `...`) at narrow widths.
- [x] Regression tests cover the help modal and the file-tree / git-panel / card paths at truncating widths.
- [x] Existing tests still pass; typecheck clean.
