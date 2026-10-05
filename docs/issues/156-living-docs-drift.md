# Issue #156: Living Docs Drifted from the Code (AGENTS / DESIGN / README / GLOSSARY)

- **Status**: Open
- **Type**: Documentation
- **Severity**: Medium
- **Component(s)**: `AGENTS.md`, `DESIGN.md`, `README.md`, `docs/GLOSSARY.md`, `constants.ts` (stale comment)

---

## Description

A read-only audit of the living project docs against `main @ 79a3e99` /
v0.14.18 found **44 discrepancies: 2 High, 15 Medium, 27 Low**. Out of scope:
`docs/issues/`, `docs/plans/`, `docs/specs/`, `docs/exploration/`, `docs/audits/`,
`docs/code-review*.md`. Claims already machine-guarded by `test/docs.test.ts`
(suite count, test inventory, npm `files` allowlist, tracker arithmetic, README
badge, no case counts) are not re-litigated here.

The drift clusters in five themes:

1. **Async/data ownership (#140)** — every living doc still says `index.ts`
   owns it; `session.ts` does.
2. **Geometry split (#148)** — `frame.overlayHeight()` is now
   `layout.overlayHeight()`.
3. **Typed open target (#142)** — the `startsWith("commit:")` string guard and
   the "data enters via `setTree`/`setGitState`/`openRelPath`" contract predate
   the typed protocol and `setImageSupport`.
4. **Image pipeline (#143/#144)** — `RenderOutcome` consumption is placed in
   the wrong module; chafa is described as strictly opt-in-only although `auto`
   renders it and the binary is probed even in mode `off`.
5. **Self-contradictions from #121/#135/#137** — README's settings menu
   predates draft + Save; DESIGN forbids corners it mandates; DESIGN's diff
   colors contradict its own front matter.

Every finding below was verified against the code. Corrections must state the
current mechanism with the current issue reference; where a sentence describes
the default layout or default mode, say so explicitly.

## Findings

### AGENTS.md — 15 (2 High, 4 Medium)

| Line | Current claim | Fix |
| :--- | :--- | :--- |
| L13 | "git-tracked files when inside a repo" | "tracked + untracked git files when git is available (untracked `?? dir/` subtrees filled by a bounded fs walk); filesystem walk when git is unavailable or the repo is empty" (`git.ts:324` `readGitTree`, `session.ts:663–697`) |
| L17 | "opens the `layout.default` setting" | "opens the overlay with the layout named by the `layout.default` setting" (the *setting* is never opened) |
| L19 | "All async/data work lives in `index.ts`" | "All async/data work lives in `session.ts` (Issue #140); `index.ts` loads settings/env, dispatches commands, and wires the session to the overlay. The component (`navigator.ts`) owns UI state only." |
| L27 | devDeps "raised to `^0.99.2` …" tracking the host | After #157: pin is `^1.0.3`; the host is pi 1.0.3; keep the rule, state the current values and the drift that was fixed. |
| L28 | "No shelling out to external binaries" | Scope to the viewer/highlighter: "the viewer never shells out; the exec sites are `git.ts` (git) and `images.ts` (chafa)" |
| L28 | chafa "used only when the user opts in (`images.mode: "chafa"` / `PI_NAV_IMAGES=1`)" | "used when the mode is `chafa` or `auto` (directly or via `PI_NAV_IMAGES`); when pi-chafa is present the binary is version-probed at overlay open even in `off`" (`images.ts:1323`, `1512–1526`) |
| L28 | "no protocol code of our own" | "the encoders are pi-tui's (`renderImage`); our own code only probes kitty support (`a=q`, Issues #101/#116) and applies `NATIVE_PROTOCOL_RULES`" (`images.ts:922–955`, `1083`) |
| L37 | "`frame.overlayHeight()`" | "`layout.overlayHeight()`" (`layout.ts:34`; also `constants.ts:180`'s comment) |
| L63 | session row "typed `RenderOutcome` consumption" | "the one image pipeline binding (Issue #144; `viewer.ts` `loadFile` consumes the typed `RenderOutcome`)" (`session.ts:508,546`; `viewer.ts:391,459+`) |
| L64 | navigator row "Re-exports `HELP_ROWS`" | "Exports `HELP_ROWS` (projected from `help.ts`'s `NAVIGATOR_KEYBINDINGS`)" (`navigator.ts:154`) |
| L71 | tree row "Pure graph helpers; no fs." | Split: pure graph helpers **plus** the bounded fs-entry collection the session's tree ticks use (`collectDirEntries`/`collectFsEntries`/`collectFsProbe`, `tree.ts:16,83,115,208`); drop "no fs" |
| L76 | env row "(imported by the component module graph via `icons.ts`)" | "(imported by the component module graph via `images.ts`, and by `settings.ts` via `icons.ts`)" (`navigator.ts` imports neither `icons.ts` nor `env.ts`) |
| L81 | settings_menu row "fs stays in `index.ts`/`settings.ts`" | "No fs access; settings fs stays in `settings.ts` (`index.ts` has no fs imports)" |
| L87 | "`setTree` / `setGitState` / `openRelPath` are the only ways data enters" | "`setTree` / `setGitState` / `setImageSupport` / `openRelPath` are the ways data enters" (`navigator.ts:392`, `index.ts:401`) |
| L87 | "diffs skip the mtime poll in index.ts (`startsWith("commit:")` guard)" | "diffs skip the mtime poll in `session.ts` (`target.kind === "commit"` on the typed `OpenTarget`, Issue #142)" (`session.ts:739`) |

### DESIGN.md — 11 (4 Medium)

| Line | Current claim | Fix |
| :--- | :--- | :--- |
| L150 | NavigatorTheme method list presented as the set | Add `bold`, `selectedBg`, `searchMatch`, `searchCurrent`, `scrollbarTrack`, `scrollbarThumb`, or mark the list "e.g." (`theme.ts:8–37`) |
| L153 | muted = "non-focused pane labels, …" | Non-focused pane labels are **dim** (`files_view.ts:39`, `git_view.ts:167`, `frame.ts:366`); muted uses are footer hint labels, title-row path, unfocused viewer header path, card body, help descriptions, commit hashes, plain dir names (`frame.ts:295,381`, `viewer_view.ts:291,411`, `help_view.ts:87`, `git_view.ts:242`, `files_view.ts:106`) |
| L190 | "`frame.overlayHeight()` uses that same ratio" | "`overlayHeight()` (`layout.ts`) uses that same ratio" |
| L195–196 | Body "left column (files + git)" and footer "pane labels `files git viewer`" | Qualify as the default `files-git-viewer` layout and note the #119 variants (`files-viewer`, `git-viewer`); footer labels derive from `visiblePanes` (`layout.ts:121–150`, `frame.ts:363–367`) |
| L218 | pane-header "muted otherwise" | "dim otherwise"; the front-matter `pane-header-muted` row is equally wrong |
| L220 | file-row-modified "git-modified (warning) … file labels" | Warning label is on changed **directories** (`files_view.ts:106`); modified **file** rows keep a `text` label and carry warning on their badge (`files_view.ts:130–137`, `git_view.ts:279`) |
| L224 | diff `+` success, `-` error, context text | "`+` diffAdded (`toolDiffAdded`), `-` diffRemoved, context diffContext; `@@` accent, meta muted" (`diff.ts:59–75`, `theme.ts:67–69`; the doc's own front matter already states this) |
| L227 | "help-modal … accented key cell (16-col pad)" | "width = longest key string + 1" (`help_view.ts:49`, Issue #132) |
| L236 | "data enters via `setTree` / `setGitState` / `openRelPath`" | "data enters via the `OverlaySink` setters (`setTree`/`setGitState`/`setImageSupport`) and the open-target protocol; `render(width)` returns strings" (`session.ts:227–256`) |
| L245 | "**Don't** use rounded corners" | "Don't use any rounding beyond the four box-drawing corner glyphs `╭ ╮ ╰ ╯`; no sub-cell rounding, shadows, gradients, or opacity" (L200/L213 and `FRAME_CORNERS` `frame.ts:110`, Issue #137) — also fix front-matter `rounded: none: 0px` / `overlay-frame.rounded` |
| L246 | "keep async/data work in `index.ts`" | "keep async/data work in `session.ts` (`index.ts` loads settings/env and wires the session)" |

### docs/GLOSSARY.md — 5 (2 Medium)

| Term | Current claim | Fix |
| :--- | :--- | :--- |
| Overlay sink | "It is the **only seam** between them" | "It is the session→component port; the component reaches the session through its injected loader/refresh/drift callbacks" (`navigator.ts:105–125`, `index.ts:454–461`) |
| Overlay sink | "the session knows nothing about rendering" | Qualify: it knows nothing about frame/pane rendering; `loadCommit` composes the theme-styled diff lines (`session.ts:583`) |
| Open target | "the switching placeholder **and image-reflow arming** read [navigator's in-flight target]" | Arming is session-owned: `inFlightImageTarget ?? deps.sink.getOpenTarget()` (`session.ts:346,418`); navigator's `viewTarget` feeds the switching placeholder, copy and header only |
| Image verdict | "`viewer.ts` executes the list" | "the pipeline's single `render()` executes the list; `viewer.ts` consumes the one outcome and stamps the verdict" (`images.ts:1375–1434`; `viewer.ts:461`) — matches the glossary's own Image-pipeline entry |
| Settings field rule | "the per-kind accept/parse rules …" (implying the row carries them) | The row's `kind` selects `FIELD_KIND_RULES`; the JSON normalizer and the string editor both consume that table (`settings.ts:283,334,728`) |

### README.md — 13 (5 Medium)

| Line | Current claim | Fix |
| :--- | :--- | :--- |
| L64 | settings "written atomically; Esc closes without writing" | "Enter/Space cycles a row into an in-memory draft; the trailing Save row writes all changes atomically in one shot; Esc discards the draft without writing" (`settings_menu.ts:190,272–345`, Issue #121) |
| L64 | (capability note absent) | Add: rows whose runtime requirement is missing carry a note (e.g. `images.mode` notes chafa + pi-chafa) (`settings_menu.ts:120–121`) |
| L80 | "`/navigator <anything else>` warns and shows the help"; "settings … in other modes it warns" | Unknown token → warn + help; surplus arguments → one-line usage, no help (`index.ts:636–643`, Issue #134); `settings` warns in RPC and refuses silently in print/json (`index.ts:511–514`) |
| L85–101 | ASCII mock shows `│────┬────│`/`│─────│` separators, omits footer panes and hint pairs, leftW 17 at 70 | Regenerate from a real render (separators are `├─┤`; footer carries `files git viewer` + `g G Home/End jump` and `. hidden`; `leftColumnWidth(70) = 24`) or label it "stylized" (`frame.ts:228,236–241,355–372`, `layout.ts:40–42`) |
| L115–127 | keys table omits aliases/rows | Add Git `Ctrl+d`/`Ctrl+u` (`navigator.ts:947–950`), Home/End + PgUp/PgDn aliases, and search-mode keys — or one line: "the `?` modal lists the full set including aliases" (`help.ts:92–98,250–262`) |
| L144 | "Refresh runs every 3 s" | "every 3 s while something changes or a key is pressed, backing off to at most 10 s on an idle overlay, plus `r`" (`session.ts:752–756`, `constants.ts:15`, Issue #008) |
| L146 | "never load in full — the loader reads at most 1 MB from the head" | ">1 MB files are read head-capped at 1 MB; >5000-line files within 1 MB are read once, then truncated" (`viewer.ts:517–522`) |
| L151–185 | (pi `terminal.showImages` absent) | Add: `terminal.showImages: false` disables every tier, including `chafa`/`auto` (`images.ts:1531`) |
| L176–177 | tmux passthrough advice ("needs tmux ≥ 3.3 …") | Delete: native is unconditionally off under tmux/screen regardless of passthrough (`images.ts:848–858`, second guard at render) |
| L181–182 | "`i` … in every mode" | "in every mode that resolves an available tier; with images off or no capability the key does nothing" (`navigator.ts:1105–1114`) |
| L192 | file list: `index.ts` "async data ownership"; no `session.ts`/`icons.ts`/`diff.ts` | Re-attribute to `session.ts` and add the three modules (`session.ts`, `icons.ts`, `diff.ts` — all published) |
| L196 | "git 2.55" | "2.56" or drop the version (it drifted once already) |
| L199 | pi "pinned to the running pi version (0.85.1)" | `^1.0.3` running under host pi 1.0.3 (after #157) |

### Code comments

- `constants.ts:180` — the doc comment says `frame.overlayHeight`; it is
  `layout.overlayHeight` (Issue #148).

## Acceptance Criteria

- [ ] Every finding above is addressed in its document; wording names the
  current module/function with the current issue reference, and no correction
  claims a behavior the code does not have.
- [ ] No behavior changes; the only code file touched is the `constants.ts`
  comment.
- [ ] `test/docs.test.ts` guards stay green; suite count stays 22.
- [ ] `npm run typecheck` and `npm test` green.

## References

- Audit method: three parallel repo-explorer agents (AGENTS.md; DESIGN.md +
  GLOSSARY.md; README.md), 2026-10-05, every Medium/High finding re-verified by
  the orchestrator against the cited code.
- Related: #121, #135, #137, #140, #142, #143, #144, #148, #119, #008, #101,
  #116, #132, #134, #157.
