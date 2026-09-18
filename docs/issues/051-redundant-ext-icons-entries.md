# Issue #051: Dead Extension Entries in `EXT_ICONS` Superseded by `FILENAME_ICONS`

- **Status**: Resolved
- **Type**: Technical Debt / Code Hygiene
- **Severity**: Low
- **Component**: [`icons.ts`](file:///home/jhonny/Sources/pi-navigator/icons.ts) · [`EXT_ICONS`](file:///home/jhonny/Sources/pi-navigator/icons.ts#L75-L87)

---

## Description

In #045, `FILENAME_ICONS` was introduced to match exact dotfiles and filenames without extensions (`.gitignore`, `.gitattributes`, `.editorconfig`, `dockerfile`, `license`):

```typescript
const FILENAME_ICONS: Record<string, string> = {
  dockerfile: "\uf308", //  docker
  license: "\uf718",
  ".gitignore": "\uf1d3", //  git
  ".gitattributes": "\uf1d3",
  ".editorconfig": "\uf461",
};
```

In `mapExtensionToIcon`, exact filenames in `FILENAME_ICONS` are matched first. Furthermore, `extOf` and `mapExtensionToIcon` return empty string for dotfiles without extensions (`.gitignore` has `dot <= 0`).

As a result, the following entries remaining in `EXT_ICONS` are completely unreachable dead code:
```typescript
  dockerfile: "\uf308",
  gitignore: "\uf1d3",
  gitattributes: "\uf1d3",
  editorconfig: "\uf461",
  license: "\uf718",
```

## Code References

- [`icons.ts:75-87`](file:///home/jhonny/Sources/pi-navigator/icons.ts#L75-L87) — `EXT_ICONS` and `FILENAME_ICONS`
- [`icons.ts:96-106`](file:///home/jhonny/Sources/pi-navigator/icons.ts#L96-L106) — `mapExtensionToIcon` lookup sequence

## Potential Solution

Remove the unreachable keys from `EXT_ICONS` to avoid confusion and maintain a clean mapping table.

## Acceptance Criteria

- [x] Unreachable entries removed from `EXT_ICONS`.
- [x] Existing icon resolution tests in `test/icons.test.ts` continue to pass.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

- Verified and confirmed that the redundant entries (`dockerfile`, `gitignore`, `gitattributes`, `editorconfig`, `license`) were moved out of `EXT_ICONS` and properly isolated into `FILENAME_ICONS` during the #045 refactor.
- `test/icons.test.ts` covers exact dotfile mapping and extension fallbacks.
