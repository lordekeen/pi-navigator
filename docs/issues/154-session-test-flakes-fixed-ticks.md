# Issue #154: `session.test.ts` Flakes Under Full-Suite Load — Fixed-Tick Settles Race Async Side Effects

- **Status**: Open
- **Type**: Technical Debt / Test Reliability
- **Severity**: Medium
- **Component(s)**: `test/session.test.ts`

---

## Description

Three tests in `test/session.test.ts` assert on asynchronous side effects after
a **fixed number of event-loop turns** and fail intermittently when the full
suite runs under parallel worker load. They pass reliably in isolation and on
immediate re-runs.

**Reproduced 2026-10-04**, at `main@69a4e85`:

- an orchestrator gate run failed `re-arms while a load is in flight and fires
  once it settles` (reported at 12 ms);
- an 8-run full-suite loop failed once, on `starting a second load aborts the
  first load's signal, not its own` (reported at 14 ms);
- the same test passed 10/10 in isolation in the same session;
- the same class was recorded earlier: `dispose aborts an in-flight load's
  signal` failed 2 of 3 consecutive full runs during the #146 closeout and once
  in ~17 runs during #148.

**Mechanism.** `settle()` (line 393) is `for (let i = 0; i < 4; i += 1) await
new Promise((resolve) => setImmediate(resolve));`, and `flushTicks(rounds = 4)`
(line 346) is the same fixed-budget idea. The three tests then assert:

```ts
void session.loadFile("img.png", { image: IMAGE_REQ });
await settle();
expect(ctl.chafaCalls).toHaveLength(1); // line 785, 956 / and abort flags at 766-767
```

The effect being asserted (the mock chafa child has been started, its signal
aborted by a superseding load, or a debounced reflow has fired) depends on real
fs/stat and child-process completions. Four `setImmediate` rounds is a budget,
not a condition; under load the completion can land after the assertion. The
~12–14 ms failure times are consistent with an un-awaited effect.

Issue #099 already established the house convention — replace wall-clock/fixed
waits with deterministic condition predicates (`vi.waitFor`) — and applied it to
`test/navigator.test.ts`. The session suite kept its tick-based helpers.

## Fix

Make the wait condition-based; keep every assertion value and strength
unchanged:

- Real-timer tests (lines ~753, ~772): `await vi.waitFor(() => expect(
  ctl.chafaCalls).toHaveLength(1))`, then assert the abort flags.
- Fake-timer test (line ~950): poll the observed condition instead of assuming a
  fixed number of turns — `vi.waitFor` advances fake timers in current Vitest,
  otherwise bound a `flushTicks()` loop on the predicate (e.g.
  `await waitForCondition(() => ctl.chafaCalls.length === 1)`).
- Optionally add one `waitForCondition(predicate)` helper to the suite so the
  pattern is explicit and reusable.

A flake is not "fixed" by a retry; the tests must fail only when the session
logic is wrong.

## Acceptance Criteria

- [ ] The three tests wait on the observed condition, not a fixed tick count.
- [ ] A soak of **20 consecutive full-suite runs** with no failure of these
  tests (any unrelated failure still fails the soak).
- [ ] No weakened assertions: the same values (call counts, abort flags, reflow
  counts) are asserted after the wait.
- [ ] `npm run typecheck` and `npm test` green; case count unchanged.

## References

- #099 — the `vi.waitFor` convention this suite never adopted.
- #117 — per-load abort ownership (the two abort tests).
- #144 — the reflow clock (the re-arms test).
- #140 — the session-module extraction that introduced the suite.
- Gate-run observations: #146 closeout, #148 and #149/#150 workers, and the
  #153 closeout (this filing).
