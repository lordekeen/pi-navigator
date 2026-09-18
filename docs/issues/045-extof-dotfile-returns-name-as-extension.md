# Issue #045: `extOf` Returns Dotfile Name as Extension

- **Status**: Resolved
- **Type**: Enhancement
- **Severity**: Low
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) · [`extOf`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L139-L143)

---

## Description

`extOf` uses `lastIndexOf(".")` to find the extension. For dotfiles without a real extension (e.g., `.gitignore`, `.editorconfig`), `lastIndexOf` returns 0, and the function returns the name minus the dot as the "extension":

```typescript
const dot = relPath.lastIndexOf(".");
if (dot < 0) return "";        // only negative is handled
return relPath.slice(dot + 1);  // ".gitignore" → "gitignore"
```

This happens to work correctly in practice because `icons.ts` has entries for `gitignore` and `editorconfig`, and the viewer's `IMAGE_EXTENSIONS` set doesn't contain these strings. But it's semantically incorrect — these are names, not extensions.

## Code References

- [`viewer.ts:140-142`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L140-L142) — `extOf` implementation
- [`icons.ts:79-81`](file:///home/jhonny/Sources/pi-navigator/icons.ts#L79-L81) — entries that make this work by coincidence

## Potential Solution

Treat `dot === 0` as "no extension" (or separate basename-based matching for names like `.gitignore`):

```typescript
if (dot <= 0) return "";  // handles both missing dot and leading dot
```

Note: this would break the icons for `.gitignore` etc. unless `icons.ts` adds a NAME_ICONS map for full filename matching. Consider whether the current behavior is actually desirable.

## Acceptance Criteria

- [x] Decide whether dotfile icon matching should be by name or by "extension" and implement consistently.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Updated `extOf` in `viewer.ts` to return `""` when `dot <= 0` (ignoring leading dots in dotfiles). Added explicit `FILENAME_ICONS` map in `icons.ts` matching exact names (`.gitignore`, `.editorconfig`, `Dockerfile`, `LICENSE`), checking filenames before extensions. Added tests in `test/viewer.test.ts` and `test/icons.test.ts`.
