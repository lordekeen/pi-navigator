# Issue #055: `isMarkdownPath` Excludes Common Markdown Extensions (`.mdx`, `.mkd`, `.mdown`)

- **Status**: Resolved
- **Type**: Enhancement
- **Severity**: Low
- **Component**: [`viewer.ts`](file:///home/jhonny/Sources/pi-navigator/viewer.ts) · [`isMarkdownPath`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L147-L150)

---

## Description

The [`isMarkdownPath`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L147-L150) helper currently restricts Markdown detection to `.md` and `.markdown`:

```typescript
// viewer.ts:147-150
export function isMarkdownPath(relPath: string): boolean {
  const ext = extOf(relPath);
  return ext === "md" || ext === "markdown";
}
```

In modern projects and documentation trees, markdown files often use other standard extensions such as `.mdx` (MDX / React documentation), `.mkd`, and `.mdown`.

Currently, opening any file with these extensions treats them strictly as standard code files, preventing the user from toggling into rendered view (`m` shows `"rendered view only available for markdown files"`).

## Code References

- [`viewer.ts:147-150`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L147-L150) — `isMarkdownPath` definition
- [`viewer.ts:335, 353`](file:///home/jhonny/Sources/pi-navigator/viewer.ts#L335-L353) — `loadFile` `rawText` attachment

## Potential Solution

Define a constant set of markdown extensions in [`constants.ts`](file:///home/jhonny/Sources/pi-navigator/constants.ts) or extend `isMarkdownPath` to match common markdown file extensions:

```typescript
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);

export function isMarkdownPath(relPath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extOf(relPath));
}
```

## Acceptance Criteria

- [x] Files ending in `.md`, `.markdown`, `.mdown`, `.mkd`, and `.mdx` are identified as markdown files.
- [x] Rendered mode (`m`) is enabled for these extensions.
- [x] Unit tests in `test/viewer.test.ts` verify the additional extensions.
- [x] `npm run typecheck` and `npm test` are green.

## Resolution

Added `MARKDOWN_EXTENSIONS` set (`"md"`, `"markdown"`, `"mdown"`, `"mkd"`, `"mdx"`) to `constants.ts`. Updated `isMarkdownPath` in `viewer.ts` to check against `MARKDOWN_EXTENSIONS`, enabling rendered markdown view and `rawText` attachment for `.mdx`, `.mkd`, and `.mdown` files. Added unit tests in `test/viewer.test.ts` and `test/navigator.test.ts`.
