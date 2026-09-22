/**
 * index.ts factory suites: makeWarningNotifier (Issue #063 finding 2) — the
 * notify-once-per-invocation warning channel. Tested against a fake ui
 * recording notify calls; no pi runtime surface needed. Per-invocation scope
 * is exercised by calling the factory twice and expecting the same message
 * to notify again.
 */

import { describe, expect, it, vi } from "vitest";

import { makeWarningNotifier } from "../index";

function fakeUi() {
  const notify = vi.fn();
  return { ui: { notify }, notify };
}

describe("makeWarningNotifier", () => {
  it("prefixes the message with pi-navigator: and uses warning severity", () => {
    const { ui, notify } = fakeUi();
    makeWarningNotifier(ui)("boom");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("pi-navigator: boom", "warning");
  });

  it("notifies each distinct message once", () => {
    const { ui, notify } = fakeUi();
    const warn = makeWarningNotifier(ui);
    warn("alpha");
    warn("beta");
    warn("alpha");
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map((call) => call[0])).toEqual(["pi-navigator: alpha", "pi-navigator: beta"]);
  });

  it("dedupes per factory call, not per module", () => {
    const { ui, notify } = fakeUi();
    makeWarningNotifier(ui)("boom");
    makeWarningNotifier(ui)("boom");
    expect(notify).toHaveBeenCalledTimes(2);
  });
});