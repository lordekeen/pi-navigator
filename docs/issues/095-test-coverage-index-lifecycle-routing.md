# Issue #095: Test Coverage Gap: Extension Entry Point `index.ts` Is 93% Untested

- **Status**: Open
- **Type**: Technical Debt / Test Coverage
- **Severity**: Medium
- **Component**: [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts), [`test/index.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/index.test.ts)

---

## Description

[`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts) is the central orchestration module for `pi-navigator` (~661 lines). It owns:
1. Command registration with the host (`pi.registerCommand("navigator", ...)`).
2. Subcommand routing (`/navigator settings`, `/navigator help`, and unknown subcommand handling).
3. Argument tab completions ([`navigatorCompletions`](file:///home/jhonny/Sources/pi-navigator/index.ts#L449)).
4. Durable transcript entry rendering via [`registerEntryRenderer`](file:///home/jhonny/Sources/pi-navigator/index.ts#L593).
5. Headless/TUI environment detection (`ctx.hasUI`).
6. Polling orchestration for git and filesystem changes (`pollFsAndGit`).
7. File stat caching and loader injection for text, diffs, and images.

Currently, [`test/index.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/index.test.ts) is only 42 lines long and tests exclusively [`makeWarningNotifier`](file:///home/jhonny/Sources/pi-navigator/index.ts#L650). Approximately 93% of `index.ts` is completely uncovered by automated tests.

A bug or regression in command parsing, entry rendering, or argument completion would not be caught by the test suite.

## Root Cause Analysis

Extension harness lifecycle code was manually tested during dogfooding without accompanying unit test fixtures.

## Potential Solution

Expand [`test/index.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/index.test.ts) with mocked pi extension contexts:
1. Test command handler routing: verify calling with `"help"`, `"settings"`, and invalid args triggers the appropriate handlers/notices.
2. Test [`navigatorCompletions`](file:///home/jhonny/Sources/pi-navigator/index.ts#L449) against empty and partial arguments.
3. Test help transcript entry renderer output and formatting.
4. Test `hasUI` guard (graceful degradation when running in headless/non-interactive mode).

## Acceptance Criteria

- [ ] Automated tests cover subcommand dispatch in `index.ts`.
- [ ] Argument completion function is unit-tested.
- [ ] Transcript entry renderer is unit-tested.
- [ ] `npm test` passes.
