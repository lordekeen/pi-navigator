# Issue #097: Test Coverage Gap: Tmux Native Image Degradation Untested in `images.test.ts`

- **Status**: Open
- **Type**: Technical Debt / Test Coverage
- **Severity**: Medium
- **Component**: [`images.ts`](file:///home/jhonny/Sources/pi-navigator/images.ts), [`test/images.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/images.test.ts)

---

## Description

[`test/images.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/images.test.ts) contains over 1,000 lines of tests covering Chafa rendering, geometry clipping, capability ladders, and native image rendering.

However, neither `TMUX` nor `screen` is tested anywhere in the file. The behavior of `resolveNativeProtocol`, `resolveImageSupport`, and `runNativeRender` when executing inside a terminal multiplexer (where graphics protocol sequences are unsafe) is completely unasserted.

This lack of automated coverage directly corresponds to live defect [#070](file:///home/jhonny/Sources/pi-navigator/docs/issues/070-kitty-protocol-crash-in-tmux.md): the tmux guard does not merely lack test coverage; it is entirely absent from `pi-navigator`'s own [`resolveNativeProtocol`](file:///home/jhonny/Sources/pi-navigator/images.ts#L770-L791) ladder. Settings and environment overrides bypass the host guard without any defensive check in the extension or test suite.

## Root Cause Analysis

Multiplexer degradation was assumed to be handled entirely by the host pi-tui library and was not independently verified in pi-navigator's own capability ladder test suite.

## Potential Solution

Add a dedicated test block in [`test/images.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/images.test.ts):
1. Test that `resolveNativeProtocol({ env: { TMUX: "1", PI_IMAGE_PROTOCOL: "kitty" } })` returns `null`.
2. Test that `resolveNativeProtocol({ env: { TERM: "tmux-256color" }, userSettings: ... })` returns `null`.
3. Test that `resolveImageSupport` under tmux falls back to Chafa (when enabled) or metadata card.

## Acceptance Criteria

- [ ] Tmux and screen environment detection is thoroughly tested in `test/images.test.ts`.
- [ ] Tests verify that settings and environment overrides do not activate native graphics protocols under multiplexers.
- [ ] `npm test` passes.
