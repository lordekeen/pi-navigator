# Issue #101: Native Decode Probe (`a=q`) to Detect Undecodable Payloads and Fall Back

- **Status**: Open
- **Type**: Enhancement
- **Severity**: Medium
- **Component**: [`images.ts`](file:///home/jhonny/Sources/pi-navigator/images.ts), [`index.ts`](file:///home/jhonny/Sources/pi-navigator/index.ts)

## Description

`runNativeRender` considers rendering successful once the image is encoded —
it has no way to know whether the receiving terminal could actually decode
the payload. #100 closed the hole for terminals pi-tui **positively
identifies** as image-incapable, but two cases remain where the viewer can
still go blank instead of falling back to chafa/card:

1. A **future or unrecognized terminal** that answers the kitty capability
   query (so `caps.images === "kitty"`) but whose decoder rejects the
   payload — e.g. a spec-strict decoder receiving JPEG/WebP bytes tagged
   `f=100` (the #071 relaxation; real kitty itself is untested, and kitty
   feature requests #3758/#4341 suggest direct-transmission JPEG/WebP is
   unsupported there).
2. Any terminal where capability *advertisement* misleads (miscfg, wrapper
   terminals that echo the query response).

In all these cases the failure is silent: APC-ignore is spec-safe, so there
is no crash — just an empty viewer with no metadata card.

## Proposal

The kitty graphics protocol already defines a decode-verification mechanism:
send a query action `a=q` with an `i` id and a small valid payload — the
terminal must reply `\x1b_Gi=<id>;OK\x1b\\` or an error string. A
session-cached probe before the first native render could:

- Accept the native tier only when the reply is `OK`.
- Treat no-reply (timeout, e.g. Alacritty ignoring the query) and error
  replies as "cannot decode" → degrade that file to chafa/card.
- Re-probe once per terminal/session, not per image.

This also gives the #071 JPEG/WebP question a definitive runtime answer on
every terminal, replacing static reasoning with a measured one.

## Constraints & Open Points

- pi-tui does not expose query-response reading; pi-navigator would need its
  own stdin reply read with a short timeout. The spec's "pi-navigator
  generates no protocol bytes itself" constraint would be amended to *probe
  bytes only, no payload encoding* (the probe payload can be a tiny embedded
  PNG).
- The probe must not race the TUI's own capability query machinery.
- iTerm2 has no equivalent probe — scope is kitty-protocol terminals only.

## Acceptance Criteria

- [ ] First native render in a session is preceded by an `a=q` probe; `OK` → native tier confirmed.
- [ ] Error reply or timeout → clean `{ok:false}` degradation to chafa/card, cached for the session.
- [ ] No regression in Konsole (probe must return `OK` there).
- [ ] Tests in [`test/images.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/images.test.ts) cover OK / error / no-reply / timeout paths.
- [ ] `npm run typecheck` and `npm test` pass.