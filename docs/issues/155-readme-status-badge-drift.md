# Issue #155: README Status Badge Is Pinned to v0.10.7 — Seven Minor Versions Stale

- **Status**: Resolved
- **Type**: Documentation
- **Severity**: Low
- **Component(s)**: `README.md`, `test/docs.test.ts`

---

## Description

`README.md` carries `![status](https://img.shields.io/badge/status-v0.10.7-green)`
while `package.json` says `0.14.18`. The badge was last updated by
[#056](056-readme-version-and-markdown-keys.md) (v0.5.0 era) and then kept
happily through seven further releases: the release flow (`pi install .` plus
the version bump) updates `package.json`, and nothing pinned the badge to it.

The same class was recorded in the #145 session checkpoint as a known
stale-but-untouched item; nothing in `docs.test.ts`'s documentation guards
looked at the badge, so drift was silent.

## Fix

- Set the badge to the shipped version (`status-v0.14.18-green`).
- Add a `test/docs.test.ts` guard pinning the README badge to
  `package.json`'s `version`, so the next version bump fails the suite until
  the badge moves with it — the #115 guard philosophy instead of
  hand-maintenance.

## Acceptance Criteria

- [x] `README.md`'s badge names the current shipped version.
- [x] `test/docs.test.ts` fails if `README.md`'s badge version and
  `package.json`'s `version` disagree (red verified by construction: the
  guard matches `status-v<version>-`, and the pre-fix badge value fails it).
- [x] `npm run typecheck` and `npm test` green; suite count unchanged (22).

## Resolution

Fixed (2026-10-05), version 0.14.18:

- `README.md` — badge moved from `status-v0.10.7-green` to
  `status-v0.14.18-green`.
- `test/docs.test.ts` — new documentation guard
  `pins the README status badge to the shipped version`: reads
  `package.json`'s `version` and asserts the README contains
  `status-v${version}-`, so a version bump with a stale badge fails the
  suite. 22 suites / 931 cases.

## References

- [#056](056-readme-version-and-markdown-keys.md) — the previous badge fix
  (v0.5.0), unguarded.
- [#115](115-test-count-drift-and-index-bookkeeping.md) — the documentation
  guards this joins.
