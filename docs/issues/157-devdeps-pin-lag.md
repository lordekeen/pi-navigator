# Issue #157: devDependencies Pin Lags the Host pi (0.99.2 vs 1.0.3)

- **Status**: Resolved
- **Type**: Technical Debt / Tooling
- **Severity**: Medium
- **Component(s)**: `package.json` (devDependencies), `index.ts` (comment)

---

## Description

`AGENTS.md`'s dev-environment rule says the `devDependencies` copy of the two
peer packages is what `tsc --noEmit` and Vitest resolve against, so it must
track the pi the extension actually loads into — and that drift has caused a
false-green suite before (the 0.85.1-vs-0.99.2 episode).

The host is now **pi 1.0.3** (`pi --version`; global
`@earendil-works/pi-coding-agent@1.0.3`), while both devDeps stood at
`^0.99.2` (caret on a `0.x` version pins the minor, so 1.0.3 was never
resolved). Typecheck and the suite were therefore proving the extension against
an API one major behind the one it runs under.

Found by the #156 living-docs audit (AGENTS.md L27, README.md L199); the doc
text is corrected under #156.

## Fix

- Raise `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` to
  `^1.0.3` in `devDependencies`, regenerate the lockfile.
- Update the version-specific comment in `index.ts` (~L610, "verified against
  0.99.2 …") to name 1.0.3: `RegisteredCommand` at 1.0.3 still is
  `{name, sourceInfo, description?, getArgumentCompletions?, handler}` with no
  `argumentHint`, so the comment's claim holds.

## Acceptance Criteria

- [x] Both devDeps `^1.0.3`; lockfile updated.
- [x] `npm run typecheck` and `npm test` green with **no source edits**:
  22 suites / 931 cases at 1.0.3.
- [x] The `index.ts` comment names the verified version.

## Resolution

Fixed (2026-10-05), version 0.14.18 (no bump: the published artifact is
unchanged — devDeps and the lockfile are not in the `files` allowlist):

- `package.json` devDeps `^0.99.2` → `^1.0.3` for both peers; `npm install`
  resolved 1.0.3.
- `index.ts` comment updated from "verified against 0.99.2" to 1.0.3 after
  checking the installed type: `RegisteredCommand` is unchanged
  (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1134`).
- Verified: typecheck clean, 931/931 across 22 suites, zero source edits.

## References

- #156 — the living-docs audit that found the drift.
- The AGENTS.md dev-environment rule this violates.
