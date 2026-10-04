# Issue #140: Extract the Session Module from `runNavigator`'s Mount Closure

- **Status**: Resolved
- **Type**: Technical Debt / Refactor
- **Severity**: Medium
- **Component(s)**: [`index.ts`](../../index.ts), `session.ts` (new), `test/session.test.ts` (new)

## Description

The overlay's whole data lifecycle lives as ~20 bindings inside the `ctx.ui.custom`
factory in `runNavigator` ([`index.ts:576-1021`](../../index.ts)): the poll timer and its
backoff, tree collection and stamping (`signature`, `treeProbe`, `lastStampedProbe`), the
git read, the tree truncation warning, the per-file viewer cache with its image seams and
per-load abort ownership (`viewerCache`, `beginImageLoad`), image-support resolution, and
the error dedupe. `refreshData` alone is 137 lines (859-995).

No test can reach that wiring. Issue #114's own resolution recorded that the call sites
remained "inspection-verified", and the cache and abort fixes of #112/#116/#117 are pinned
only through helpers and injected factories. This is the deepest concentration of
untestable complexity in the repo, and the prerequisite for deepening the image and viewer
seams (architecture-review candidates #3 and #4).

Found by the architecture review of 2026-10-03
([report](../audits/architecture-review-2026-10-03.html), candidate #1).

## Proposed Resolution

Extract the lifecycle into a new `session.ts`:

- `createSession(deps)` returns `NavigatorSession { loadFile, loadCommit, start, refresh,
  onActivity, dispose }`.
- The overlay-facing port is `OverlaySink`: `setTree`, `setGitState`, `setImageSupport`,
  `setDiskChanged`, `getOpenRelPath`, `getOpenMtime`, `requestRender`.
- Injected: the `loadFile` viewer primitive, `notify` (raw, for refresh errors),
  `notifyWarning` (the deduped warning notifier), `theme`, `kittyProbe`, `capabilities`,
  the loaded settings, `imagePaths`, `cwd` and `pi`. `git.ts`, `tree.ts`, `diff.ts` and
  `images.ts` are imported directly.
- Light internal decomposition: `refreshData` becomes a `tick` over private helpers (git
  read, tree collect/stamp, open-file probe, backoff); no internals are exported.
- Pure move: no behavior change, `navigator.ts` untouched, the overlay interface frozen.
  #136 (theme-stale `viewerCache`) is deliberately a separate change.

## Acceptance Criteria

- [ ] `session.ts` exists with the interface above; `index.ts` keeps only settings/env
  loading, kitty-probe and notifier creation, overlay construction, command dispatch and
  the returned UI wrapper.
- [ ] `navigator.ts` is byte-identical; no existing test file is edited.
- [ ] `test/session.test.ts` drives cadence/backoff, tree stamping, cache lookup/store and
  abort ownership, and the image-support upgrade through the session interface.
- [ ] `npm run typecheck` and `npm test` are green.
- [ ] `git diff --stat` touches only `session.ts`, `index.ts`, the new test file, and
  tracker/docs updates.

## Resolution

The closure moved to `session.ts` as a pure move: `createSession(deps)` returns
`NavigatorSession { loadFile, loadCommit, start, refresh, onActivity, dispose }`, and the
overlay is reached only through the `OverlaySink` port (`setTree`, `setGitState`,
`setImageSupport`, `setDiskChanged`, `getOpenRelPath`, `getOpenMtime`, `requestRender`).
`refreshData` decomposed into `readGit` / `collectTreeProbe` / `collectTreeEntries` /
`stampTree` / `probeOpenFile` / `applyBackoff`; the policy comments and issue refs moved
with their code. `index.ts` dropped from 1173 to 668 lines.

`navigator.ts` and every existing test file are byte-identical; the suite stayed green
through the move (802 cases) and `test/session.test.ts` adds 13 cases over the real
`createSession` interface: initial flow, fs fallback, cadence/backoff (the cap and both
delay resets revert-checked red→green), probe-skip stamping, cache identity and mtime
reload, error-card non-retention, per-load abort ownership plus dispose abort, error
dedupe, dispose safety and `loadCommit`. 815/815 across 21 suites; `npm run typecheck`
clean. version 0.14.3.

Deviations from the plan, all deliberate:

- the shared policy helpers (`createViewerCache`, `isCacheableRender`, `makeImageSeams`,
  `makeTreeTruncationWarner`, `touchCacheEntry`) moved to `session.ts` and are re-exported
  from `index.ts`, because the existing suite imports them from the entry and test files
  were frozen for this change;
- `tsconfig.json` `include` gained `session.ts`;
- `dispose()` sets the session's closed flag, so a framework-driven dispose stops an
  in-flight tick instead of letting it write to a disposed overlay.

Deferred, unchanged: #136 (theme-stale `viewerCache`) remains a separate change.

## References

- [Architecture review — pi-navigator](../audits/architecture-review-2026-10-03.html) —
  candidate #1
- [#114](114-untested-cache-warn-wiring.md) — the inspection-verified wiring this change
  removes
- [#116](116-first-image-chafa-tier-flip.md),
  [#117](117-native-abort-cascade-chafa-fallback.md) — the abort ownership the session now
  owns
- [#136](136-viewer-cache-stale-syntax-theme.md) — theme-stale `viewerCache`, deliberately
  a separate change
