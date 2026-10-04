/**
 * pi-navigator — read-only project file navigator overlay for pi.
 *
 * Establishes the /navigator command grammar (Issue #061): bare opens a
 * centered overlay with a file tree, git state panel, and a syntax-highlighted
 * viewer; `settings` opens the settings menu (TUI only); `help` appends a
 * durable help entry; any other subcommand warns then shows help.
 *
 * Data ownership: session.ts owns all async work (git, tree collection, file
 * stats) and pushes results into the overlay through setters; this entry point
 * loads settings, constructs both and dispatches commands. The overlay
 * component itself never touches the filesystem. The refresh interval exists
 * only while the overlay is open and is cleared both by the overlay's own close
 * path and by the component's dispose() hook, so an externally closed overlay
 * cannot leak it.
 */

import { join } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";

import { getCapabilities, type KeybindingsManager, Text } from "@earendil-works/pi-tui";

import {
  NAVIGATOR_IMAGES_ENV,
  NAVIGATOR_IMAGES_FLAG,
  NAVIGATOR_ICONS_FLAG,
  NAVIGATOR_LAYOUT_ENV,
  NAVIGATOR_LAYOUT_FLAG,
  NAVIGATOR_SETTINGS_FILE,
  OVERLAY_OPTIONS,
} from "./constants";
import { ICONS_ENV } from "./icons";
import { buildHelpLines, HELP_COMMANDS_TITLE, HELP_HEADER_PREFIX, HELP_HINT, HELP_ENTRY_TYPE, helpCommandColumnWidth, NAVIGATOR_CMD_PREFIX, NAVIGATOR_SUBCOMMANDS, type NavigatorHelpData } from "./help";
import type { NavigatorLayout } from "./types";
import { buildKittyProbeQuery, consumeKittyProbeReply, createKittyProbeState, detectPiChafa, makeDeferredImageSupport, type KittyProbeState, type KittyProbeVerdict } from "./images";
import { applyFieldEdit, loadNavigatorSettings, writeNavigatorSettings } from "./settings";
import { countChangedFields, navigatorFieldNotes, openSettingsMenu } from "./settings_menu";
import { NavigatorOverlay } from "./navigator";
import { createSession, type OverlaySink } from "./session";
import { makeNavigatorTheme } from "./theme";
import { loadFile } from "./viewer";

// Issue #140: the session policy helpers below moved to session.ts; they stay
// re-exported here because test/index.test.ts imports them from this entry and
// the suite must remain green without edits to test files.
import {
  createViewerCache,
  isCacheableRender,
  makeImageSeams,
  makeTreeTruncationWarner,
  touchCacheEntry,
  type ViewerCache,
} from "./session";
export { createViewerCache, isCacheableRender, makeImageSeams, makeTreeTruncationWarner, touchCacheEntry };
export type { ViewerCache };

type TuiLike = {
  terminal: { rows: number; write: (data: string) => void };
  requestRender: () => void;
  addInputListener: (
    listener: (data: string) => { consume?: boolean; data?: string } | undefined,
  ) => () => void;
};

/**
 * Kitty protocol probe (Issue #101, #116): one `a=q` query per overlay
 * invocation, answered by the terminal's own input stream. The query transmits
 * a 1×1 PNG sample tagged `f=100` — the only format that matches the kitty
 * spec for this tag. The verdict is conservative: only an explicit error reply
 * degrades native rendering; "ok" confirms it; "no-reply" (timeout, or a
 * terminal that does not answer queries, e.g. some partial kitty
 * implementations) keeps declared behavior so Konsole-style terminals cannot
 * regress.
 *
 * Issue #116 fix: the cache is per overlay invocation (not per process), so an
 * error from a glitched reply or a stale pi session does not permanently
 * degrade every image for the rest of the process.
 */
const KITTY_PROBE_TIMEOUT_MS = 250;

export function makeTuiKittyDecodeProbe(
  tui: TuiLike,
  opts?: { timeoutMs?: number; cache?: { result?: Promise<KittyProbeVerdict> } },
): () => Promise<KittyProbeVerdict> {
  const timeoutMs = opts?.timeoutMs ?? KITTY_PROBE_TIMEOUT_MS;
  // Injectable cache is a test seam only: production creates a fresh object
  // per overlay invocation so error verdicts do not persist across sessions.
  const cache: { result?: Promise<KittyProbeVerdict> } = opts?.cache ?? {};
  return () => {
    if (cache.result !== undefined) return cache.result;
    const probe = new Promise<KittyProbeVerdict>((resolve) => {
      const id = Math.floor(Math.random() * 0xffffffff) + 1;
      const query = buildKittyProbeQuery(id);
      const state: KittyProbeState = createKittyProbeState();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const settle = (verdict: KittyProbeVerdict): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe?.();
        resolve(verdict);
      };
      timer = setTimeout(() => settle("no-reply"), timeoutMs);
      unsubscribe = tui.addInputListener((data) => {
        if (settled) return undefined;
        const verdict = consumeKittyProbeReply(state, data, id);
        if (verdict === "ok" || verdict === "error") {
          settle(verdict);
          // Consume the completing chunk: it is the reply to our own query,
          // nothing for the key decoder. Partial chunks are left alone.
          return { consume: true };
        }
        return undefined;
      });
      // Write through the TUI's terminal so the query is ordered with
      // renders; the reply arrives on the same input stream the listener
      // watches — the same pattern as pi-tui's own terminal queries.
      tui.terminal.write(query);
    });
    cache.result = probe;
    return probe;
  };
}

/**
 * Pure argument routing for /navigator (Issue #061): the first whitespace
 * token decides and matching is case-sensitive lowercase (a `Settings` token
 * is unknown). Layout subcommands (Issue #119) resolve through the shared
 * table's `layout` field to `{ kind: "layout" }`.
 *
 * `set <field> <value>` (Issue #131) is the one subcommand that reads past the
 * first token — it needs both trailing tokens, so they ride on the result
 * rather than being dropped. A `set` missing its arguments routes to the same
 * kind with `undefined` fields so the handler can state the usage instead of
 * silently doing nothing.
 *
 * Anything beyond a subcommand's arity is **rejected**, not ignored (Issue
 * #134): the standard forbids silently dropping an argument you do not
 * understand, so `/navigator all extra` and `/navigator set a b c` come back as
 * `extra` with the offending tokens and the handler answers with a one-line
 * usage.
 */
export type ParsedNavigatorArgs =
  | { readonly kind: "overlay" }
  | { readonly kind: "settings" }
  | { readonly kind: "help" }
  | { readonly kind: "layout"; readonly layout: NavigatorLayout }
  | { readonly kind: "set"; readonly field: string | undefined; readonly value: string | undefined }
  | { readonly kind: "extra"; readonly sub: string; readonly extra: readonly string[] }
  | { readonly kind: "unknown"; readonly raw: string };

export function parseNavigatorArgs(args: string): ParsedNavigatorArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const token = tokens[0];
  if (token === undefined) return { kind: "overlay" };
  // Subcommand tokens come from the shared help table (Issue #063 finding 5):
  // a table lookup — never a cast — so an unknown token can never be
  // re-labeled into a known kind. A row carrying a layout routes to the
  // layout kind with that layout (Issue #119, D12); set/settings/help keep
  // their own kinds; anything else is unknown.
  const sub = NAVIGATOR_SUBCOMMANDS.find((candidate) => candidate.cmd.slice(NAVIGATOR_CMD_PREFIX.length) === token);
  if (sub === undefined) return { kind: "unknown", raw: token };
  // `set` is `set <setting> <value>` (three tokens); every other subcommand
  // takes nothing beyond its own name. Extra tokens are rejected, never
  // dropped (Issue #134).
  const arity = sub.cmd.endsWith("set") ? 3 : 1;
  if (tokens.length > arity) return { kind: "extra", sub: token, extra: tokens.slice(arity) };
  if (sub.layout !== undefined) return { kind: "layout", layout: sub.layout };
  if (sub.cmd.endsWith("set")) return { kind: "set", field: tokens[1], value: tokens[2] };
  if (sub.cmd.endsWith("settings")) return { kind: "settings" };
  return { kind: "help" };
}

/**
 * Argument completions for /navigator, filtered by prefix. Rows project from
 * NAVIGATOR_SUBCOMMANDS (Issue #063 finding 5) so the completion descriptions
 * cannot drift from the /navigator help rows.
 *
 * Always an array (Issue #134): `[]` is "I have nothing", which is the honest
 * answer for a prefix matching no subcommand, while `null` means "not my job"
 * and would hand the argument slot back to another provider for our own
 * argument list.
 */
export function navigatorCompletions(prefix: string): { value: string; label: string; description: string }[] {
  return NAVIGATOR_SUBCOMMANDS.map((sub) => {
    // Issue #139: the popup row is labelled with the token the user is typing;
    // the descriptive sentence is the description column. The host labels its
    // own command and theme items with the value the same way.
    const token = sub.cmd.slice(NAVIGATOR_CMD_PREFIX.length);
    return { value: token, label: token, description: sub.completionDescription };
  }).filter((item) => item.value.startsWith(prefix));
}

/**
 * The one-line usage for a subcommand token (Issue #134). `set` is the only
 * subcommand that takes values, which is why it is the only one that gets a
 * value syntax appended.
 */
function subcommandUsage(token: string): string {
  return `${NAVIGATOR_CMD_PREFIX}${token}${token === "set" ? " <setting> <value>" : ""}`;
}

/** Levenshtein distance, iterative. Tokens are tiny, so this stays cheap. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * The closest subcommand token to `token`, or undefined when nothing is close
 * enough to be a typo (Issue #134). Candidates come from the one subcommand
 * table, so a suggestion can never name a token that does not exist. The
 * threshold is a third of the token's length (at least one edit), which
 * suggests `setting` → `settings` while staying quiet for an unrelated word.
 */
function nearestSubcommand(token: string): string | undefined {
  let best: { token: string; distance: number } | undefined;
  for (const candidate of NAVIGATOR_SUBCOMMANDS) {
    const name = candidate.cmd.slice(NAVIGATOR_CMD_PREFIX.length);
    const distance = editDistance(token, name);
    if (best === undefined || distance < best.distance) best = { token: name, distance };
  }
  const limit = Math.max(1, Math.floor(token.length / 3));
  return best !== undefined && best.distance <= limit ? best.token : undefined;
}

/**
 * The one-line warning for an unknown subcommand (Issue #134): the standard's
 * near-miss form quotes the correction back when the token is plausibly a typo,
 * and stays terse when it is not. A module-level builder rather than an inline
 * `const`, because a declaration directly inside a case clause is a lint error.
 */
function unknownSubcommandNotice(raw: string): string {
  const suggestion = nearestSubcommand(raw);
  return suggestion === undefined
    ? `pi-navigator: unknown subcommand "${raw}"`
    : `pi-navigator: unknown subcommand "${raw}" — did you mean "${subcommandUsage(suggestion)}"?`;
}

/**
 * Reads one host flag as a string (Issue #131). `getFlag` is typed
 * `boolean | string | undefined`, so a value of the wrong shape is treated as
 * absent rather than coerced: the flags are registered without a default, so
 * "absent" is a real state the precedence chain depends on.
 */
function flagString(pi: ExtensionAPI, name: string): string | undefined {
  const value = pi.getFlag(name);
  return typeof value === "string" ? value : undefined;
}

/** Boolean twin of {@link flagString}: only a real boolean counts as passed. */
function flagBoolean(pi: ExtensionAPI, name: string): boolean | undefined {
  const value = pi.getFlag(name);
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The startup layers that override a field, as a label per field id (Issue
 * #131). The settings menu annotates its rows with this and `/navigator set`
 * warns with it, so both read one place instead of duplicating the raw
 * presence rules; flags beat env, so the more explicit layer wins the label.
 */
function collectOverrides(pi: ExtensionAPI): Record<string, string> {
  const overrides: Record<string, string> = {};
  const imagesFlag = flagString(pi, NAVIGATOR_IMAGES_FLAG);
  const imagesEnv = process.env[NAVIGATOR_IMAGES_ENV];
  if (imagesFlag !== undefined && imagesFlag.trim() !== "") overrides["images.mode"] = `--${NAVIGATOR_IMAGES_FLAG}`;
  else if (imagesEnv !== undefined && imagesEnv.trim() !== "") overrides["images.mode"] = NAVIGATOR_IMAGES_ENV;
  const iconsFlag = flagBoolean(pi, NAVIGATOR_ICONS_FLAG);
  const iconsEnv = process.env[ICONS_ENV];
  if (iconsFlag !== undefined) overrides["icons.enabled"] = `--${NAVIGATOR_ICONS_FLAG}`;
  else if (iconsEnv !== undefined && iconsEnv.trim() !== "") overrides["icons.enabled"] = ICONS_ENV;
  const layoutFlag = flagString(pi, NAVIGATOR_LAYOUT_FLAG);
  const layoutEnv = process.env[NAVIGATOR_LAYOUT_ENV];
  if (layoutFlag !== undefined && layoutFlag.trim() !== "") overrides["layout.default"] = `--${NAVIGATOR_LAYOUT_FLAG}`;
  else if (layoutEnv !== undefined && layoutEnv.trim() !== "") overrides["layout.default"] = NAVIGATOR_LAYOUT_ENV;
  return overrides;
}

/**
 * `/navigator set <field> <value>` (Issue #131): the command path to the same
 * registry and atomic writer the settings menu uses, for when the menu cannot
 * mount (print/json) or a script wants to provision a later session.
 * Validation is the same pure `applyFieldEdit`, so a value accepted here is
 * accepted there, and the durable effect is the file — which is why this works
 * headless even though `notify` is a no-op outside the TUI.
 *
 * A field that a startup layer shadows gets called out: writing a value the
 * current run will ignore is otherwise a silent surprise.
 */
function runSet(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  field: string | undefined,
  value: string | undefined,
): void {
  if (field === undefined || value === undefined) {
    ctx.ui.notify("pi-navigator: usage: /navigator set <setting> <value> (see /navigator help)", "warning");
    return;
  }
  const userPath = join(getAgentDir(), NAVIGATOR_SETTINGS_FILE);
  const loaded = loadNavigatorSettings({ userPath });
  for (const warning of loaded.warnings) ctx.ui.notify(`pi-navigator: ${warning}`, "warning");

  const edited = applyFieldEdit(loaded.settings, field, value);
  if (!edited.ok) {
    // One line, and it always says how to call this correctly (Issue #131 AC):
    // the field list itself is the settings doc, so point at the usage rather
    // than dumping ids into a notification.
    ctx.ui.notify(`pi-navigator: ${edited.error} — usage: /navigator set <setting> <value>`, "warning");
    return;
  }
  try {
    writeNavigatorSettings(userPath, edited.settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(
      `pi-navigator: could not write settings: ${message.length <= 160 ? message : `${message.slice(0, 160)}…`}`,
      "warning",
    );
    return;
  }
  const shadowed = collectOverrides(pi)[field];
  ctx.ui.notify(
    `pi-navigator: set ${field} = ${value} → ${userPath}${shadowed !== undefined ? ` (${shadowed} overrides it for this run)` : ""}`,
    "info",
  );
}

/**
 * Notify-once-per-invocation warning channel (§5.2 convention): prefixes
 * "pi-navigator: ", uses "warning" severity, and dedupes per call — the Set
 * is created here per factory call, so a later /navigator invocation warns
 * again for the same message instead of silently swallowing it.
 */
export function makeWarningNotifier(
  ui: Pick<ExtensionUIContext, "notify">,
): (message: string) => void {
  const emittedWarnings = new Set<string>();
  return (message: string): void => {
    if (emittedWarnings.has(message)) return;
    emittedWarnings.add(message);
    ui.notify("pi-navigator: " + message, "warning");
  };
}

async function runNavigator(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  layoutOverride?: NavigatorLayout,
): Promise<void> {
  // Issue #122: `mode` is the capability that matters for a custom component.
  // RPC has hasUI=true but ctx.ui.custom is a host stub, and json/print have
  // hasUI=false while notify is a no-op. notify still forwards in RPC, so the
  // refusal is reachable there (json/print visibility is deliberately open —
  // see issue #122).
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("pi-navigator requires the interactive TUI", "warning");
    return;
  }

  const cwd = ctx.cwd;

  await ctx.ui.custom<null>(
    (tui: TuiLike, piTheme: Theme, keybindings: KeybindingsManager, done: (value: null) => void) => {
      // Narrowed keybinding policy (Issues #125/#126): host-owned actions go
      // through the injected KeybindingsManager — cancel matches
      // "tui.select.cancel", which covers Esc, Ctrl+C and any user remap in
      // one call. Overlay-local letters (j k g G l h w m i n N y t r . / ?)
      // stay literal: they have no host binding ids and are this extension's
      // own key language (standards report section 2.5).
      const theme = makeNavigatorTheme(piTheme);

      // Kitty protocol probe (Issue #101, #116): one a=q query per overlay
      // invocation, gating native renders on the terminal's own reply. Cache
      // is per invocation (not per process) so error verdicts expire.
      const kittyProbe = makeTuiKittyDecodeProbe(tui);

      // ── Image support (optional chafa rendering) — resolved per invocation ──
      // Settings are read once here (never in the component, Issue #028/#039
      // pattern); warnings notify once per distinct message (§5.2).
      const agentDir = getAgentDir();
      const loaded = loadNavigatorSettings({
        userPath: join(agentDir, NAVIGATOR_SETTINGS_FILE),
        env: {
          images: process.env[NAVIGATOR_IMAGES_ENV],
          icons: process.env[ICONS_ENV],
          layout: process.env[NAVIGATOR_LAYOUT_ENV],
        },
        // Flags beat env inside the loader (Issue #131).
        flags: {
          images: flagString(pi, NAVIGATOR_IMAGES_FLAG),
          icons: flagBoolean(pi, NAVIGATOR_ICONS_FLAG),
          layout: flagString(pi, NAVIGATOR_LAYOUT_FLAG),
        },
      });
      const notifyWarning = makeWarningNotifier(ctx.ui);
      for (const warning of loaded.warnings) notifyWarning(warning);
      const imagePaths = {
        userSettings: join(agentDir, "settings.json"),
        projectSettings: join(cwd, ".pi", "settings.json"),
        agentDir,
      };

      // Overlay-facing port (Issue #140): the session reaches the component
      // only through these methods. Defined before the overlay because the
      // session is constructed first; the methods only run once the overlay
      // exists (the same deferral the old inline `refresh` closure relied on).
      const sink: OverlaySink = {
        setTree: (root, source) => overlay.setTree(root, source),
        setGitState: (git) => overlay.setGitState(git),
        setImageSupport: (support) => overlay.setImageSupport(support),
        setDiskChanged: (changed) => overlay.setDiskChanged(changed),
        getOpenRelPath: () => overlay.getOpenRelPath(),
        getOpenMtime: () => overlay.getOpenMtime(),
        // The component has no requestRender method; renders go through the
        // host TUI callback the overlay was constructed with.
        requestRender: () => tui.requestRender(),
      };

      const session = createSession({
        cwd,
        theme,
        settings: loaded.settings,
        imagePaths,
        loadFile,
        // Refresh errors keep the original channel, prefix and severity.
        notify: (message) => ctx.ui.notify(message, "warning"),
        notifyWarning,
        kittyProbe,
        capabilities: getCapabilities,
        pi,
        sink,
      });

      let closed = false;

      /** Stop everything this overlay owns. Safe to call more than once. */
      const cleanup = (): void => {
        session.dispose();
        overlay.dispose();
      };

      const close = (): void => {
        if (closed) return;
        closed = true;
        cleanup();
        done(null);
      };

      const scheduleRender = (): void => {
        if (!closed) tui.requestRender();
      };

      const overlay = new NavigatorOverlay({
        cwd,
        theme,
        getTerminalRows: () => tui.terminal.rows,
        requestRender: () => tui.requestRender(),
        onClose: close,
        loadFile: (relPath, opts) => session.loadFile(relPath, opts),
        loadCommit: (hash) => session.loadCommit(hash),
        keybindings,
        refresh: () => session.refresh(),
        // Env reads happen here, once, at overlay open; the component never
        // touches process.env (Issues #028, #039, #061). `enableIcons` and the
        // three initial-state options come from the env-resolved settings.
        enableIcons: loaded.settings.icons.enabled,
        home: process.env.HOME ?? process.env.USERPROFILE ?? "",
        // Deferred seed snapshot; the session owns the live one and upgrades
        // the component via setImageSupport when resolution lands (D9).
        imageSupport: makeDeferredImageSupport(loaded.settings.images.mode),
        initialShowHidden: loaded.settings.tree.showHidden,
        initialWrap: loaded.settings.viewer.wrap,
        initialRenderMarkdown: loaded.settings.viewer.markdown === "rendered",
        // Issue #119: a layout subcommand opens its own layout for this one
        // session; bare /navigator resolves the layout.default setting (env
        // already applied inside loadNavigatorSettings).
        initialLayout: layoutOverride ?? loaded.settings.layout.default,
      });

      session.start();

      return {
        render: (width: number) => overlay.render(width),
        handleInput: (data: string) => {
          overlay.handleInput(data);
          scheduleRender();
          session.onActivity();
        },
        invalidate: () => overlay.invalidate(),
        // The framework calls dispose() when it closes the overlay itself, so
        // the polling timer is cleared even if close() was never reached.
        dispose: cleanup,
      };
    },
    { overlay: true, overlayOptions: OVERLAY_OPTIONS },
  );
}

/**
 * /navigator settings (Issue #061): open the SettingsList menu over the FILE
 * view of the settings (loaded without env; env-shadowed rows are annotated
 * and the env still wins at the next open). Edits stage in the menu's draft;
 * the Save row commits once = atomic write → reload → notify warnings; any
 * throw becomes a bounded `{ok:false}` — the menu warns and keeps the draft
 * for a retry. After the menu closes, the outcome is reported: info naming
 * the count and the file on save, info "unchanged (cancelled)" on Esc (#133).
 */
async function runSettings(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  // Issue #122: `mode !== "tui"` is the guard; `custom` is a function in every
  // host context, so the old typeof check was dead code and is gone.
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("pi-navigator settings requires the interactive TUI", "warning");
    return;
  }

  const userPath = join(getAgentDir(), NAVIGATOR_SETTINGS_FILE);
  // chafa-mode capability note (Issue #118): pi-chafa presence is detected here
  // (the menu module stays pi-free) and surfaced as a row note — the value is
  // documented, not hidden, so pre-configuring before install keeps working.
  const piChafaPresent = detectPiChafa(pi, {
    userSettings: join(getAgentDir(), "settings.json"),
    projectSettings: join(ctx.cwd, ".pi", "settings.json"),
  }).present;
  const notifyWarning = makeWarningNotifier(ctx.ui);

  const fileLoaded = loadNavigatorSettings({ userPath });
  for (const warning of fileLoaded.warnings) notifyWarning(warning);

  const overrides = collectOverrides(pi);

  try {
    const outcome = await openSettingsMenu(ctx.ui, {
      settings: fileLoaded.settings,
      overrides,
      notes: navigatorFieldNotes({ piChafaPresent }),
      commit: (next) => {
        try {
          writeNavigatorSettings(userPath, next);
          const reloaded = loadNavigatorSettings({ userPath });
          for (const warning of reloaded.warnings) notifyWarning(warning);
          return { ok: true, settings: reloaded.settings };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: message.length <= 160 ? message : `${message.slice(0, 160)}…` };
        }
      },
      onWarning: (message) => ctx.ui.notify(message, "warning"),
    });
    // Outcome feedback lands AFTER the menu closes (#133): the modal asks,
    // the toast reports. Failures already warned from inside the menu.
    if (outcome.kind === "saved") {
      const changed = countChangedFields(fileLoaded.settings, outcome.settings);
      ctx.ui.notify(`pi-navigator: settings saved (${changed} fields) \u2192 ${userPath}`, "info");
    } else {
      ctx.ui.notify("pi-navigator: settings unchanged (cancelled)", "info");
    }
  } catch (error) {
    ctx.ui.notify(`pi-navigator: settings failed (${String(error)}).`, "warning");
  }
}

export default function (pi: ExtensionAPI): void {
  // Startup overrides (Issue #131). Registered so they surface in `pi --help`
  // (env vars never do) and WITHOUT a default: the host stores a declared
  // default into the flag's value, and getFlag would then return it even when
  // the user passed nothing — flattening the precedence chain
  // (defaults ← file ← env ← flag). Read through flagString/flagBoolean.
  pi.registerFlag(NAVIGATOR_IMAGES_FLAG, {
    type: "string",
    description: "pi-navigator image rendering: native, chafa, auto or off (beats PI_NAV_IMAGES and the settings file)",
  });
  pi.registerFlag(NAVIGATOR_ICONS_FLAG, {
    type: "boolean",
    description: "pi-navigator: show the Nerd Font icon column (beats PI_NAV_ICONS and the settings file)",
  });
  pi.registerFlag(NAVIGATOR_LAYOUT_FLAG, {
    type: "string",
    description: "pi-navigator overlay layout: files-git-viewer, files-viewer or git-viewer (beats PI_NAV_LAYOUT and the settings file)",
  });

  // Durable help entry renderer (Issue #061): delivered via appendEntry +
  // registerEntryRenderer, never ctx.ui.notify. Restored/old entries with no
  // data fall back to an empty cwd.
  pi.registerEntryRenderer<NavigatorHelpData>(HELP_ENTRY_TYPE, (entry, _options, theme) => {
    const cwd = entry.data?.cwd ?? "";
    const T = makeNavigatorTheme(theme);
    const lines = buildHelpLines({ cwd });
    const width = helpCommandColumnWidth();
    const styled = lines.map((line) => {
      if (line === "") return line;
      if (line === HELP_COMMANDS_TITLE) return T.bold(line);
      if (line === HELP_HINT) return T.dim(line);
      if (line.startsWith(HELP_HEADER_PREFIX)) {
        return T.accent(HELP_HEADER_PREFIX) + T.dim(line.slice(HELP_HEADER_PREFIX.length));
      }
      // Command row: padded command column plain, description dim.
      return line.slice(0, width) + T.dim(line.slice(width));
    });
    return new Text(styled.join("\n"));
  });

  pi.registerCommand("navigator", {
    // Issue #135 L11: a one-line summary only. The subcommand grammar belongs
    // to the usage text (/navigator help renders the full table); naming
    // subcommands here crowds the command list, which truncates.
    //
    // There is deliberately no `argumentHint` field: the building-pi-extension-ui
    // skill's contract.md documents one on registerCommand, but the host's
    // RegisteredCommand has no such member in any version we run (verified
    // against 0.99.2: {name, sourceInfo, description?, getArgumentCompletions?,
    // handler}). The skill is wrong on that point, so trimming is the available
    // fix rather than relocating the signature to a hint field.
    description: "Open the read-only project navigator overlay; /navigator help lists subcommands",
    getArgumentCompletions: (prefix: string) => navigatorCompletions(prefix),
    handler: async (args, ctx) => {
      const parsed = parseNavigatorArgs(args);
      switch (parsed.kind) {
        case "overlay":
          await runNavigator(pi, ctx);
          return;
        case "layout":
          await runNavigator(pi, ctx, parsed.layout);
          return;
        case "settings":
          await runSettings(pi, ctx);
          return;
        case "set":
          runSet(pi, ctx, parsed.field, parsed.value);
          return;
        case "help":
          pi.appendEntry(HELP_ENTRY_TYPE, { cwd: ctx.cwd });
          return;
        case "unknown":
          ctx.ui.notify(unknownSubcommandNotice(parsed.raw), "warning");
          pi.appendEntry(HELP_ENTRY_TYPE, { cwd: ctx.cwd });
          return;
        case "extra":
          // The usage line is more precise than the help list here, so this
          // path does not append a help entry (Issue #134).
          ctx.ui.notify(
            `pi-navigator: unexpected ${parsed.extra.length === 1 ? "argument" : "arguments"} "${parsed.extra.join(" ")}" — usage: ${subcommandUsage(parsed.sub)}`,
            "warning",
          );
          return;
      }
    },
  });
}
