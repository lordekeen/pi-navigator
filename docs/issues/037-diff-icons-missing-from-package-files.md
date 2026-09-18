# Issue #037: `diff.ts` and `icons.ts` Missing From `package.json` `"files"` and `tsconfig.json` `"include"`

- **Status**: Resolved
- **Type**: Bug
- **Severity**: High
- **Component**: [`package.json`](file:///home/jhonny/Sources/pi-navigator/package.json) · [`tsconfig.json`](file:///home/jhonny/Sources/pi-navigator/tsconfig.json)

---

## Description

`diff.ts` (added in #034) and `icons.ts` (added in #028) are imported by `index.ts` and `navigator.ts` respectively, but were never added to:

1. **`package.json` `"files"`** — npm's allowlist for the published tarball. A registry install (`npm install pi-navigator`) would be missing both modules, causing a runtime `ERR_MODULE_NOT_FOUND` when the extension loads.
2. **`tsconfig.json` `"include"`** — they only typecheck today because they are transitively imported by files that *are* listed. While this works, it's inconsistent with the project's convention of explicitly listing every source file.

Local path installs (`pi install .`) are unaffected because they read the directory directly.

## Code References

- [`package.json:9-18`](file:///home/jhonny/Sources/pi-navigator/package.json#L9-L18) — `"files"` array
- [`tsconfig.json:13`](file:///home/jhonny/Sources/pi-navigator/tsconfig.json#L13) — `"include"` array

## Potential Solution

Add both files to both arrays:

```json
// package.json "files"
"diff.ts",
"icons.ts",

// tsconfig.json "include"
"diff.ts", "icons.ts",
```

## Acceptance Criteria

- [x] `diff.ts` and `icons.ts` appear in `package.json` `"files"`.
- [x] `diff.ts` and `icons.ts` appear in `tsconfig.json` `"include"`.
- [x] `npm pack --dry-run` lists both files in the tarball contents.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Added `diff.ts` and `icons.ts` to `package.json` `"files"` array and `tsconfig.json` `"include"` list. Verified with `npm pack --dry-run`.
