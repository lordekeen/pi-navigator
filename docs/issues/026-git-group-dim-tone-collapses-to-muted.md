# Issue #026: Git Group Rows With `tone: "dim"` Render as `muted`

- **Status**: Resolved
- **Type**: Bug / UI Polish
- **Severity**: Low
- **Component**: [`navigator.ts`](file:///home/jhonny/Sources/pi-navigator/navigator.ts) / [`buildGitRow`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1032) / [`types.ts`](file:///home/jhonny/Sources/pi-navigator/types.ts)

---

## Description

`GitRowTone` ([`types.ts:88`](file:///home/jhonny/Sources/pi-navigator/types.ts#L88)) is `"warning" | "success" | "muted" | "dim"`, and git group rows are produced across all four values — the git-unavailable row ([`navigator.ts:328`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L328)) and the `Clean` row ([`navigator.ts:346`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L346)) use `tone: "dim"`, while the history label ([`navigator.ts:348`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L348)) uses `tone: "muted"`. But [`buildGitRow`](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1032) handles only three of the four tones:

```ts
const tone = row.tone === "warning" ? T.warning : row.tone === "success" ? T.success : T.muted;
```

The `"dim"` branch is unreachable: every `tone: "dim"` row renders as `T.muted`. This collapses the type's four-way distinction to an effective two-way (`warning`/`success` vs everything-else), and de-emphasized rows render one notch brighter than `DESIGN.md`'s `dim` (tertiary) role intends, losing the visual distinction between `dim` and `muted` (secondary).

## Code References

- [`navigator.ts:1035` (`buildGitRow` tone mapping)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L1035)
- [`navigator.ts:328, 346, 348` (group-row tone producers)](file:///home/jhonny/Sources/pi-navigator/navigator.ts#L328)
- [`types.ts:88` (`GitRowTone`)](file:///home/jhonny/Sources/pi-navigator/types.ts#L88)

## Potential Solution

Add the missing branch (or replace the ternary with a tone→token lookup map so all four members are handled exhaustively):

```ts
const tone = row.tone === "warning" ? T.warning
  : row.tone === "success" ? T.success
  : row.tone === "dim" ? T.dim
  : T.muted;
```

Decide explicitly whether the git-unavailable and `Clean` rows should stay `dim` or become `muted`, and align the producers (`gitRows`) with that decision.

## Acceptance Criteria

- [x] `tone: "dim"` group rows resolve to `T.dim`.
- [x] The history label (`tone: "muted"`) and warning/success rows are unchanged.
- [x] Render suite stays green; add an assertion if one can pin the tone mapping.

## Resolution

Extended the ternary chain in `buildGitRow` to handle `"dim" → T.dim` explicitly, so all four `GitRowTone` values now map to the correct theme token. Git-unavailable, empty-staged, and empty-unstaged rows render one notch dimmer (tertiary) as `DESIGN.md` intends, instead of collapsing to `muted` (secondary).
