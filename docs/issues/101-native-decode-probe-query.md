# Issue #101: Native Decode Probe (`a=q`) to Detect Undecodable Payloads and Fall Back

- **Status**: Resolved
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

- [x] First native render in a session is preceded by an `a=q` probe; `OK` → native tier confirmed.
- [x] Explicit error reply → clean `{ok:false}` degradation to chafa/card, memoized for the session.
- [x] No regression in Konsole: an unanswered query is treated as `no-reply` and keeps declared behavior — only explicit errors degrade.
- [x] Tests in [`test/images.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/images.test.ts) and [`test/index.test.ts`](file:///home/jhonny/Sources/pi-navigator/test/index.test.ts) cover OK / error / split-chunk / unrelated-input / timeout paths.
- [x] `npm run typecheck` and `npm test` pass.

## Resolution

Shipped in 0.10.0: a one-shot kitty `a=q` decode probe runs lazily on the
first kitty native render of the session (`makeTuiKittyDecodeProbe` in
`index.ts`, memoized per mime at module level — at most one query per mime
per process). The probe writes through `tui.terminal.write` — the same
channel pi-tui uses for its own terminal queries — and listens on
`tui.addInputListener` for the `\x1b_Gi=<id>;…` reply, parsed incrementally
(`consumeKittyProbeReply`) so split chunks and BEL terminators work. A
1×1 PNG payload (68 bytes, verified) rides as the `f=100` sample.

**Verdict semantics (deliberate deviation from the draft criteria):** only
an *explicit error reply* degrades to chafa/card (`runNativeRender` returns
`ok:false` before reading the file). `OK` confirms native; **no-reply keeps
declared behavior** — a terminal that does not answer queries (partial kitty
implementations) must not be regressed, and Konsole-style terminals are
exactly that risk. Written answers can be trusted; silence cannot.

The probe resolves the #071 open question empirically per terminal: a strict
decoder that answers the capability query but errors on a payload now falls
back instead of going blank.
