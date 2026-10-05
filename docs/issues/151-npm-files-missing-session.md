# Issue #151: The npm `files` Allowlist Omits `session.ts` — Published Packages Cannot Load

- **Status**: Open
- **Type**: Bug / Packaging
- **Severity**: High
- **Component(s)**: `package.json`, `test/docs.test.ts` (guard)

---

## Description

`package.json`'s `files` allowlist gates what npm publishes. It lists 21 root
modules — and has omitted `session.ts` since Issue #140 added the module
(commit `3286fd1`, v0.14.3). `index.ts`, the package entrypoint, imports from it
twice:

```ts
import { createSession, type OverlaySink } from "./session"; // index.ts:47
} from "./session";                                           // index.ts:60
```

Every release from **0.14.3 through 0.14.14** would therefore publish a package
whose entrypoint cannot resolve `./session` at load time
(`ERR_MODULE_NOT_FOUND`). Nothing local catches it: `pi install .` is a path
install that reads the checkout directly, and `tsc --noEmit`/Vitest never
consult `files`.

This is the second instance of the same class: `layout.ts` was missing from
`files` after Issue #148 and was caught by hand during that closeout. A guard is
part of the fix so the third instance cannot ship.

## Fix

1. Add `"session.ts"` to `files` beside the other root modules.
2. Add a guard to the existing `test/docs.test.ts` suite (no new suite; the
   count stays 22):
   - every root `*.ts` module except the dev-only `vitest.config.ts` is listed
     in `package.json` `files`;
   - every `files` entry exists on disk (the deletion direction).
3. Patch bump to 0.14.15 and re-run `pi install .`.

## Acceptance Criteria

- [ ] `npm pack --dry-run` lists `session.ts`.
- [ ] The guard fails red with `session.ts` removed from `files` and passes
  green with it restored.
- [ ] `npm run typecheck` and `npm test` green (22 suites, count unchanged).

## References

- #140 — added `session.ts` (commit `3286fd1`); `files` was not updated.
- #148 — `layout.ts` had the same gap and was fixed by hand in closeout.
- Found by an open-code-review sweep over `3f1752a..ea25a83`
  (2026-10-04), finding 1 of 4.
