# Issue #142: Deepen the Overlay's Open-Target Protocol (Typed Target, One mtime Protocol, One Load Primitive)

- **Status**: Resolved
- **Type**: Technical Debt / Refactor
- **Severity**: Medium
- **Component(s)**: `navigator.ts`, `session.ts`, `index.ts`, `types.ts`, tests

## Description

Two invisible protocols cross the `OverlaySink` seam (Issue #140):

1. **The mtime ritual.** `session.ts` `probeOpenFile` calls `getOpenRelPath()`, stats, calls
   `getOpenRelPath()` again (the #040 TOCTOU guard), calls `getOpenMtime()`, then
   `setDiskChanged(changed)` — five ordered calls whose rules (when is a change a change? what
   if a different file is loading?) live in the session while the state they read lives in the
   component. The session also parses `startsWith("commit:")` so it does not `stat` a
   pseudo-path.
2. **The `commit:` string protocol.** A commit view's identity is invented as a string in
   `navigator.ts` (`viewTargetRelPath = \`commit:${hash}\``, the diff `relPath`) and then parsed
   back out in `reloadOpenFile`, `copyContext` and the session's poll.
3. **Two loaders.** `openRelPath` and `openCommit` each carry a ~50-line copy of the `loadSeq`
   race guard, scroll/search reset, completion and disposal handling.

Found by the architecture review of 2026-10-03
([report](../audits/architecture-review-2026-10-03.html), candidate #2), re-validated against
`main@e6aabeb`. The audit drew `checkOpenTarget(statResult)` as one call; that is not
implementable — the component may not `stat` (the fs-free invariant), so the protocol is
**pull**: get target → stat → check.

## Frozen Design (2026-10-04, grilling rounds 1–2)

**The open target is a typed value; the protocol lives with the state it reads; one primitive
owns the load race guard.**

1. **`OpenTarget` in `types.ts`:**
   `{ kind: "file"; relPath: string } | { kind: "commit"; hash: string }`.
2. **Pull, displayed-only.** `getOpenTarget(): OpenTarget | null` returns the target of the
   installed `ViewerFile` (via a module-level `targetOf`), or `null` while nothing is
   displayed. During a load the previously displayed target stays current — no in-flight
   target is reported to the poll. Accepted micro-deltas vs today: the old file keeps its disk
   watch during a switch (the pane renders the switching placeholder anyway), and
   `diskChanged` is not transiently cleared by the poll.
3. **`checkOpenTarget(target, mtimeMs: number | null): boolean`** owns the whole comparison:
   returns `false` without touching state when the passed target is no longer the displayed
   one (the #040 TOCTOU guard, structural now), otherwise compares ±1 ms against
   `viewFile.mtimeMs`, writes `diskChanged` itself (a stat failure — `null` — means changed),
   and returns the verdict the session feeds to its backoff.
4. **The port trades three for two.** `OverlaySink` loses `getOpenRelPath`, `getOpenMtime` and
   `setDiskChanged`; gains `getOpenTarget` and `checkOpenTarget`. The session probe becomes
   get → skip `kind === "commit"` (no string parse) → `stat` → check.
5. **One load primitive.** `openTarget(target, keepScroll)` owns the `loadSeq` race guard, the
   loading target, scroll/search reset and completion/disposal handling. `openRelPath` and
   `openCommit` become thin delegates; `openCommit` keeps its `loadCommit`-absent
   family-toggle fallback, and `openTarget` no-ops on a commit target without a loader.
   Per-kind state preserved: the `imageAsCard` reset stays file-only; search resets on any
   target change.
6. **The strings that remain.** `ViewerFile.relPath` keeps `commit:<hash>` as the display and
   cache identity, and a module-level string projection (file → `relPath`, commit →
   `commit:<hash>`) serves the three string consumers (files-pane highlight,
   `isSwitching`/`ViewerPaneView.targetRelPath`). The image-reflow arming in `setImageSupport`
   stays **target-first** including the commit pseudo-path — falling back to `viewFile` there
   would arm a reflow against the previous image during a commit load. `reloadOpenFile` and
   `copyContext` go through `targetOf`/the projection and stop parsing `commit:`. Cursor-row
   identity (`gitRowIdentity`'s `file:`/`commit:` strings) is a different protocol and stays.
7. **Commit-error identity.** The commit-load error card gains `commitHash`, so `targetOf`
   keys on `kind === "diff" || commitHash !== undefined` with no prefix parsing.

## Acceptance Criteria

- [x] `OverlaySink` is `setTree` / `setGitState` / `setImageSupport` / `getOpenTarget` /
  `checkOpenTarget` / `requestRender`; `getOpenRelPath`, `getOpenMtime` and `setDiskChanged`
  are gone from the component's public surface.
- [x] `session.ts` performs no `commit:` string parsing; the probe is get → skip commit →
  `stat` → check.
- [x] `openRelPath`/`openCommit` contain no race-guard/state-machine duplication; both
  delegate to `openTarget`.
- [x] The #040 TOCTOU behavior is preserved and tested through `checkOpenTarget` (a target
  that changed mid-stat updates nothing).
- [x] A commit target performs no `stat` and no `checkOpenTarget` call.
- [x] `npm run typecheck` and `npm test` green; no behavior change beyond the two accepted
  micro-deltas in item 2.

## Resolution

Implemented as designed (2026-10-04), version 0.14.6:

- `types.ts` gained the `OpenTarget` union; `navigator.ts` replaced `viewTargetRelPath` with
  the typed `viewTarget`, added the module-level `targetOf` / `targetPath` / `sameTarget`
  helpers, and made `openTarget` the one load state machine (race guard, in-flight target,
  scroll/search reset, completion, disposal, per-kind error cards). `openRelPath` and
  `openCommit` are one-line delegates; `openCommit` keeps its family-toggle fallback. The
  commit-load error card now stamps `commitHash`, so `targetOf` needs no prefix parsing.
- `getOpenTarget` reports the displayed target only; `checkOpenTarget(target, mtimeMs | null)`
  owns the #040 recheck (a target that is no longer displayed updates nothing), the ±1 ms
  comparison, the `diskChanged` write and the verdict; `setDiskChanged` is private.
- `OverlaySink` is now `setTree` / `setGitState` / `setImageSupport` / `getOpenTarget` /
  `checkOpenTarget` / `requestRender`; the session probe has no `commit:` parsing.
- String projections survive only where strings are the interface (`ViewerFile.relPath`
  display/cache identity, the files-pane highlight, `isSwitching` and
  `ViewerPaneView.targetRelPath`); the image-reflow arming stays target-first so a commit
  load cannot arm a reflow against the previous image.
- Tests: 10 `getOpenRelPath` assertions rewritten to `getOpenTarget` deep equality; the
  settle-signal test now uses the displayed target; the disk-watch backoff test rewritten
  around `checkOpenTarget`; new suites cover the drift notice, the TOCTOU guard (a stale
  check neither raises nor clears), displayed-vs-in-flight, and the session's commit-skip,
  stat-failure and no-target paths. 21 suites / 851 cases green; typecheck clean.
- `docs/GLOSSARY.md` created: overlay sink, open target, style key, retained source.

The accepted micro-deltas from item 2 are pinned by the rewritten tests: during a load the
previously displayed target stays the poll's target, and the poll no longer transiently
clears `diskChanged`.

## References

- Architecture review of 2026-10-03, candidate #2:
  [`docs/audits/architecture-review-2026-10-03.html`](../audits/architecture-review-2026-10-03.html)
- [`docs/GLOSSARY.md`](../GLOSSARY.md) — "open target" is the first term this protocol makes
  real
- [#040](040-mtime-race-in-refreshdata-poll.md) — the TOCTOU the recheck guarded
- [#140](140-session-module-extraction.md) — the port this deepens
