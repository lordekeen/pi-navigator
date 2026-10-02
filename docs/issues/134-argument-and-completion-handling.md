# Issue #134: Argument Handling — Completion Polarity, Silently Dropped Trailing Tokens, No Near-Miss Recovery

- **Status**: Resolved
- **Type**: Bug / UX
- **Severity**: Medium
- **Components**: [`index.ts`](../../index.ts) (`navigatorCompletions`, `parseNavigatorArgs`)
- **Found by**: UI compliance audit against `building-pi-extension-ui`, 2026-10-01 — [audit §1 M11](../exploration/ui-skill-compliance-audit.md#medium)

## Description

Three gaps in the `/navigator` argument contract, all in `index.ts`.

**1. Completion polarity is inverted for the no-match case.**

```ts
// index.ts:244
return filtered.length > 0 ? filtered : null;
```

The standard reserves `null` for *"not my job"* and requires `[]` for *"I have nothing"*, so the host
suppresses its own menu:

> *"Return `[]` for 'I have nothing' and `null` for 'not my job' — `null` hands the completion back."*
> — `commands-and-arguments.md`

Here a `/navigator zzz` prefix matches nothing and returns `null`, handing the argument slot back so
another provider's completions can appear for our own arguments. (`[]` is the correct answer; the
current behaviour is also pinned by a test, so the test needs the same correction.)

**2. Trailing tokens are silently dropped.**

```ts
// index.ts:217-219 — the first whitespace token decides, the rest is ignored
const token = args.trim().split(/\s+/).filter(Boolean)[0];
```

`/navigator all extra` opens the overlay and discards `extra`. The standard permits deliberate free-text
tolerance *if it is deliberate and stated* — and it is stated in a comment here — but it also asks for
a deliberate or rejected choice, and no recovery is offered:

> *"Never silently ignore an argument you do not understand. Either reject it with a one-line usage, or
> deliberately treat it as free text — and say which in a comment."*

**3. No near-miss recovery.** `/navigator setting` (typo) is reported as unknown and appends the help
entry — acceptable per *"reject with a warning toast plus the one-line usage"* — but the standard's
near-miss form quotes the correction back:

> *"`/thing config accepts no arguments. Did you mean "/thing config"?"*

**Note for whoever fixes this — do not add `argumentHint`.** The skill's reference documents
`argumentHint` on `registerCommand`, but the field **does not exist** in the host (verified on 0.85.1
*and* 0.99.2: `RegisteredCommand` is `{ name, sourceInfo, description?, getArgumentCompletions?, handler }`).
The grammar carried in the command description is the only option available; leave a comment so this is
not "corrected" into an unsupported field. (See [#131](131-settings-flags-and-headless-path.md) for the
description-length consequence.)

## Reproduction Steps

1. Type `/navigator zzz` and open completions — another provider's list can appear instead of nothing.
2. Run `/navigator all extra` — the overlay opens on the default layout group; `extra` vanishes silently.
3. Run `/navigator setting` (missing `s`) — unknown-argument warning, no suggested correction.

## Root Cause

`navigatorCompletions` was written to return "something or nothing" without the `[]`/`null` distinction,
and the argument parser was deliberately narrowed to a single token with free-text tolerance that was
never surfaced to the user.

## Proposed Resolution

- Return `[]` when the prefix matches no subcommand (and keep `null` strictly for "not our grammar").
- Either reject trailing tokens with a one-line usage plus a `warning` toast, or keep tolerating them and
  say so in the help entry; add a near-miss branch that quotes the corrected command.
- Keep the four subcommands' `completionLabel`/`desc` projection from `NAVIGATOR_SUBCOMMANDS` (single
  source of truth, already correct).

## Acceptance Criteria

- [x] Completions return `[]` for "nothing" and `null` only for "not ours"
- [x] Trailing tokens are either rejected with usage or explicitly tolerated (comment + test)
- [x] A near-miss quotes the corrected command back to the user
- [x] A comment records why `argumentHint` is absent (host has no such field)
- [x] Tests updated for the polarity change and added for the near-miss path
- [x] `npm run typecheck` and `npm test` green

## References

- Audit: [§1 M11](../exploration/ui-skill-compliance-audit.md) — rules: `commands-and-arguments.md`
  §Argument completion, §Parsing `args`, §Outcome messages
- Related: [#095](095-test-coverage-index-lifecycle-routing.md) (the tests pinning current behaviour),
  [#131](131-settings-flags-and-headless-path.md) (command surface)

## Resolution

**Completion polarity.** `navigatorCompletions` now always returns an array. For our own argument slot there is no "not my job" case, so `[]` is the honest answer for a prefix matching nothing; the old `null` handed the slot back to another provider for a list that is ours.

**Trailing tokens are rejected, not dropped.** The parser gained the subcommand's arity — `set` takes `<setting> <value>` (three tokens), every other subcommand takes none — and anything beyond it comes back as `{ kind: "extra", sub, extra }`. The handler answers with one line: `unexpected argument "extra" — usage: /navigator all`, and a rejected invocation mounts nothing. The usage line for `set` includes its value syntax, so the rejection also teaches the form.

**Near misses quote the correction.** A typo like `setting` now warns `unknown subcommand "setting" — did you mean "/navigator settings"?`. Candidates come from the one subcommand table, so a suggestion can never name a token the parser would reject, and the threshold (a third of the token's length, at least one edit) keeps an unrelated `zzz` silent rather than guessing.

Provenance note: this issue was dispatched to a local worker agent, which stalled after seven read-only calls without writing anything; the work was finished inline by the orchestrator rather than waiting on it, and the tree was verified to be untouched by the stalled agent (no partial writes to reconcile).

Verified: `npm run typecheck` and `npm test` green (20 suites).

