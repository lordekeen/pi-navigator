# pi-navigator Glossary

Domain vocabulary for the overlay. Terms are ordered so each can lean on the ones above it.
Architecture-level words (module, interface, depth, seam, adapter, leverage, locality) come
from the project's shared design vocabulary and are not redefined here.

## Overlay sink

The port (`OverlaySink` in `session.ts`) through which the data lifecycle reaches the TUI
component: the session pushes tree, git and image-support snapshots in, and reads the open
target / reports a disk check out. The component knows nothing about the filesystem or git;
the session knows nothing about rendering. It is the only seam between them (Issue #140).

## Open target

The typed value describing what the viewer is showing: `{ kind: "file"; relPath }` or
`{ kind: "commit"; hash }` (`types.ts`). It is the one vocabulary the disk-watch protocol, the
reload verb and the "open file" highlight share, so none of them parses the `commit:<hash>`
display string to recover the fact (Issue #142). The *displayed* open target is derived from
the installed `ViewerFile`; navigator separately tracks the *in-flight* target while a load is
running, which is what the switching placeholder and image-reflow arming read.

## Image verdict

The per-load outcome of the image pipeline (`ImageVerdict` in `types.ts`): either rendered
rows plus the renderer that produced them (`"native"` / `"chafa"`), or a metadata card
carrying the failure that ended the attempt list (renderer + bounded detail). One decision
per load — `images.ts` `planImageLoad` orders the renderers eligible under the support
snapshot, the session binds them to its seams, and `viewer.ts` executes the list (a clean
failure continues, a throw or an abort stops it). Labels read the verdict, never re-derive
which renderer spoke (Issue #143).

## Image pipeline

The one render seam an image load runs through (`makeImagePipeline` in `images.ts`): given the
support snapshot and the pane geometry it returns the planned attempts and a single
`render(absPath)` that owns the attempt order, the per-renderer fallback, per-attempt throw
handling, and typed supersession (`RenderOutcome`: `ok` / `failed` / `aborted`). The session
binds it to the owning load's abort controller and reads its attempts for the cache key; the
loader (`viewer.ts`) consumes one outcome and stamps the file's image verdict — it never sees
the abort string (Issue #144).

## Style key

A fingerprint (`makeStyleKey` in `theme.ts`) of the theme tokens viewer content is baked with,
plus the color mode. Retained content records the key it was styled under; a mismatch means
the theme changed and the content is stale. A resize invalidate leaves the key unchanged, so
the restyle path costs nothing there (Issues #136/#141).

## Retained source

The pre-style material a viewer file carries so its lines can be re-styled under a new style
key without touching disk: `styleText` for highlighted file text, `styleDiff` for a composed
commit diff. Retention is skipped where styling is theme-independent (unknown-language files)
and is bounded by the existing highlight caps (Issues #136/#141).
