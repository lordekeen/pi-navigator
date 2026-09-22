# Issue #099: Test Flakiness: Async Tests Rely on Arbitrary Wall-Clock `setTimeout` Sleeps

- **Status**: Resolved
- **Type**: Technical Debt / Test Quality
- **Severity**: Low
- **Component**: [`test/navigator.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/navigator.test.ts)

---

## Description

In [`test/navigator.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/navigator.test.ts), multiple asynchronous tests wait for file loading or state updates using hardcoded wall-clock delays:

```typescript
await new Promise((resolve) => setTimeout(resolve, 10));
```

This pattern appears at lines 886, 926, 957, 983, 1021, 1033, 1454, and 1493.

Relying on arbitrary 10ms timer sleeps introduces non-deterministic test behavior:
1. Under heavy CI load or CPU contention, 10ms may elapse before the async file loader microtask completes, leading to intermittent test failures.
2. In environments with coarse filesystem timestamp resolution (e.g. Docker volumes or legacy filesystems), fixed short sleeps fail to detect mtime transitions.

## Root Cause Analysis

Asynchronous file operations and event loops are synchronized with arbitrary real-time delays instead of deterministic event-driven polling or promise resolution.

## Potential Solution

1. Use Vitest's `vi.waitFor()` or a retry loop with a reasonable timeout:
   ```typescript
   await vi.waitFor(() => {
     expect(harness.overlay.render(120).join("\n")).toContain("expected text");
   }, { timeout: 500 });
   ```
2. Or explicitly await the loader promise / microtask queue flush instead of wall-clock timers.

## Acceptance Criteria

- [x] Fragile `setTimeout(resolve, 10)` delays in `test/navigator.test.ts` are replaced with deterministic `vi.waitFor()` or condition-based predicates.
- [x] Tests run reliably under simulated latency or CPU throttling.
- [x] `npm test` passes.

## Resolution

Replaced all arbitrary wall-clock `setTimeout(resolve, 10)` timer delays in `test/navigator.test.ts` with deterministic `await vi.waitFor(...)` predicates.
