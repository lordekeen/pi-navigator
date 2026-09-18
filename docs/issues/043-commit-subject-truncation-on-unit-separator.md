# Issue #043: Commit Subject Truncated if Message Contains Unit Separator

- **Status**: Resolved
- **Type**: Bug
- **Severity**: Low
- **Component**: [`git.ts`](file:///home/jhonny/Sources/pi-navigator/git.ts) · [`readGitState`](file:///home/jhonny/Sources/pi-navigator/git.ts#L150-L231)

---

## Description

The git log format uses `\x1f` (unit separator) as a field delimiter, and the parser destructures the split result:

```typescript
const [shortHash, parentsRaw, dateRel, subject] = line.split(UNIT_SEPARATOR);  // line 210
```

Destructuring silently drops extra elements. If a commit subject legitimately contains `\x1f` (extremely rare, but valid in git), the subject is truncated at the first occurrence.

## Code References

- [`git.ts:210`](file:///home/jhonny/Sources/pi-navigator/git.ts#L210) — destructured split
- [`git.ts:24`](file:///home/jhonny/Sources/pi-navigator/git.ts#L24) — `UNIT_SEPARATOR` constant

## Potential Solution

Split with a limit or rejoin the tail:

```typescript
const parts = line.split(UNIT_SEPARATOR);
const shortHash = parts[0];
const parentsRaw = parts[1];
const dateRel = parts[2];
const subject = parts.slice(3).join(UNIT_SEPARATOR);
```

## Acceptance Criteria

- [x] Commit subjects containing `\x1f` are preserved in full.
- [x] Normal commit subjects are unaffected.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Rejoined parts with `parts.slice(3).join(UNIT_SEPARATOR)` in `readGitState` log parser. Added test in `test/git.test.ts`.
