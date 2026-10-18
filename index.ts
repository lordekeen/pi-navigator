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
  NAVIGATOR_SETTINGS_FILE,
  OVERLAY_OPTIONS,
} from "./constants";
import { buildHelpLines, HELP_COMMANDS_TITLE, HELP_HEADER_PREFIX, HELP_HINT, HELP_ENTRY_TYPE, helpCommandColumnWidth, NAVIGATOR_CMD_PREFIX, NAVIGATOR_SUBCOMMANDS, type NavigatorHelpData } from "./help";
import type { NavigatorLayout } from "./types";
import { buildKittyProbeQuery, consumeKittyProbeReply, createKittyProbeState, detectPiChafa, makeDeferredImageSupport, type KittyProbeState, type KittyProbeVerdict } from "./images";
import {
  applyFieldEdit,
  commitNavigatorSettings,
  loadNavigatorSettings,
  NAVIGATOR_CONFIG_FIELDS,
  resolveOverrideOrigins,
  type OverrideOrigin,
} from "./settings";
import { countChangedFields, navigatorFieldNotes, openSettingsMenu } from "./settings_menu";
import { NavigatorOverlay } from "./navigator";
import { createSession, type OverlaySink } from "./session";
import { makeNavigatorTheme, makeStyleKey } from "./theme";
import { loadFile } from "./viewer";

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

/**
 * The probe handle (Issue #185): the cached probe getter the session awaits,
 * plus the cancel the overlay's cleanup calls so closing before the terminal
 * answers leaves no input listener or timer behind. Cancelling settles a
 * pending probe as "no-reply" — the conservative verdict.
 */
export interface TuiKittyProbe {
  (): Promise<KittyProbeVerdict>;
  cancel(): void;
}

export function makeTuiKittyDecodeProbe(
  tui: TuiLike,
  opts?: { timeoutMs?: number; cache?: { result?: Promise<KittyProbeVerdict> } },
): TuiKittyProbe {
  const timeoutMs = opts?.timeoutMs ?? KITTY_PROBE_TIMEOUT_MS;
  // Injectable cache is a test seam only: production creates a fresh object
  // per overlay invocation so error verdicts do not persist across sessions.
  const cache: { result?: Promise<KittyProbeVerdict> } = opts?.cache ?? {};
  // Issue #185: the pending probe's settle hook, so cancel() can release its
  // listener and timer when the overlay closes before the terminal answers.
  let cancelPending: (() => void) | null = null;
  return Object.assign(
    (): Promise<KittyProbeVerdict> => {
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
          cancelPending = null;
          resolve(verdict);
        };
        timer = setTimeout(() => settle("no-reply"), timeoutMs);
        unsubscribe = tui.addInputListener((data) => {
          if (settled) return undefined;
          const reply = consumeKittyProbeReply(state, data, id);
          if (reply.verdict === "ok" || reply.verdict === "error") {
            settle(reply.verdict);
            // Consume the completing chunk, but hand back the bytes the reply
            // did not consume (Issue #213): a keystroke coalesced with the
            // terminal's answer must still reach the key decoder. Partial
            // chunks are left alone.
            return reply.leftover ? { consume: true, data: reply.leftover } : { consume: true };
          }
          return undefined;
        });
        cancelPending = () => settle("no-reply");
        // Write through the TUI's terminal so the query is ordered with
        // renders; the reply arrives on the same input stream the listener
        // watches — the same pattern as pi-tui's own terminal queries.
        tui.terminal.write(query);
      });
      cache.result = probe;
      return probe;
    },
    { cancel: (): void => cancelPending?.() },
  );
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
  // dropped (Issue #134). Route on the exact TOKEN, not on a suffix of the
  // table's command string (Issue #198): a future subcommand whose name
  // merely ends in "set"/"settings" must not be classified as one.
  const arity = token === "set" ? 3 : 1;
  if (tokens.length > arity) return { kind: "extra", sub: token, extra: tokens.slice(arity) };
  if (sub.layout !== undefined) return { kind: "layout", layout: sub.layout };
  if (token === "set") return { kind: "set", field: tokens[1], value: tokens[2] };
  if (token === "settings") return { kind: "settings" };
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
 * The startup flag values keyed by flag name (Issue #145): one entry per
 * registry row that declares a flag, so the loader and the origins report can
 * never disagree about which flags exist. A registered-but-unset flag stays
 * `undefined` — registration declares no default, so `getFlag` only returns a
 * value the user actually passed, which is what makes "absent" observable.
 * The loader ignores a value of the wrong shape for the row's flag type.
 */
/**
 * The startup-layer provenance for one command invocation (Issue #178): the
 * `--navigator-*` flag values and the resolved per-field origins. `/navigator
 * set`, `/navigator settings` and the overlay mount read both through this one
 * resolver, so no path can disagree about which layer won (the #131 class).
 */
function resolveStartupOrigins(pi: ExtensionAPI): {
  flags: Record<string, string | boolean | undefined>;
  origins: Record<string, OverrideOrigin>;
} {
  const flags: Record<string, string | boolean | undefined> = {};
  for (const field of NAVIGATOR_CONFIG_FIELDS) {
    const flag = field.override?.flag;
    if (flag === undefined) continue;
    flags[flag.name] = pi.getFlag(flag.name);
  }
  return { flags, origins: resolveOverrideOrigins(process.env, flags) };
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
  const committed = commitNavigatorSettings(userPath, edited.settings);
  if (!committed.ok) {
    ctx.ui.notify(`pi-navigator: could not write settings: ${committed.error}`, "warning");
    return;
  }
  const shadowed = resolveStartupOrigins(pi).origins[field];
  ctx.ui.notify(
    `pi-navigator: set ${field} = ${value} → ${userPath}${shadowed !== undefined ? ` (${shadowed.source} overrides it for this run)` : ""}`,
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
  // Issue #185: the /navigator entry never rejects. A throwing overlay factory
  // or a failing session start is reported to the user instead of surfacing as
  // an unhandled rejection.
  try {
    await openNavigatorOverlay(pi, ctx, layoutOverride);
  } catch (error) {
    ctx.ui.notify(
      `pi-navigator: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function openNavigatorOverlay(
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
      // Issue #136: the viewer's retained highlight source is keyed on the
      // syntax-token ANSI sequences behind this closure. `piTheme` is the
      // live global theme Proxy, so the closure observes switches; the same
      // closure feeds the session (cache hits) and the overlay (invalidate),
      // keeping both restyle triggers in lockstep.
      const styleKey = makeStyleKey(piTheme);

      // Kitty protocol probe (Issue #101, #116): one a=q query per overlay
      // invocation, gating native renders on the terminal's own reply. Cache
      // is per invocation (not per process) so error verdicts expire.
      const kittyProbe = makeTuiKittyDecodeProbe(tui);

      // Settings are read once here (never in the component, Issue #028/#039
      // pattern); warnings notify once per distinct message (§5.2). The
      // registry rows drive both startup layers (Issue #145).
      const agentDir = getAgentDir();
      const loaded = loadNavigatorSettings({
        userPath: join(agentDir, NAVIGATOR_SETTINGS_FILE),
        env: process.env,
        // Flags beat env inside the loader (Issue #131).
        flags: resolveStartupOrigins(pi).flags,
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
        getOpenTarget: () => overlay.getOpenTarget(),
        checkOpenTarget: (target, mtimeMs) => overlay.checkOpenTarget(target, mtimeMs),
        // Issue #144: the reflow clock pulls the displayed image view and
        // commands the re-open through the normal openTarget path.
        getImageView: () => overlay.getImageView(),
        reflowOpenImage: () => overlay.reflowOpenImage(),
        // The component has no requestRender method; renders go through the
        // host TUI callback the overlay was constructed with.
        requestRender: () => tui.requestRender(),
      };

      const session = createSession({
        cwd,
        theme,
        styleKey,
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
        // Issue #185: release the probe's input listener and timer before the
        // overlay goes away, so an early close cannot swallow later input.
        kittyProbe.cancel();
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
        // Issue #144: the overlay detects pane-geometry drift for a displayed
        // image and reports it; the session owns the debounce, the
        // re-arm-while-loading rule and the actual re-open.
        onImageViewChanged: () => session.imageViewChanged(),
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
        // Issue #165: the minimap's three settings, read once at open like the
        // rest of this block — the `v` key then toggles the session state
        // without ever writing them back.
        initialMinimap: loaded.settings.viewer.minimap,
        initialMinimapColors: loaded.settings.viewer.minimapColors,
        initialMinimapWidth: loaded.settings.viewer.minimapWidth,
        // Issue #119: a layout subcommand opens its own layout for this one
        // session; bare /navigator resolves the layout.default setting (env
        // already applied inside loadNavigatorSettings).
        initialLayout: layoutOverride ?? loaded.settings.layout.default,
        styleKey,
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
 * Ctrl+S commits once = atomic write → reload → notify warnings; any
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

  // Startup layers shadow the file view (Issue #145): the origins report names
  // the layer that actually won, so the menu annotations are truthful — a
  // present-but-invalid flag no longer labels its row as overridden.
  const origins = resolveStartupOrigins(pi).origins;
  const overrides: Record<string, string> = {};
  for (const [fieldId, origin] of Object.entries(origins)) overrides[fieldId] = origin.source;

  try {
    const outcome = await openSettingsMenu(ctx.ui, {
      settings: fileLoaded.settings,
      overrides,
      notes: navigatorFieldNotes({ piChafaPresent }),
      commit: (next) => {
        const committed = commitNavigatorSettings(userPath, next);
        if (committed.ok) {
          for (const warning of committed.warnings) notifyWarning(warning);
        }
        return committed;
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
  // Startup overrides (Issues #131/#145): one registration per registry row
  // that declares a flag, driven by the row's descriptor so the registered
  // flag set cannot drift from the settings table. Registered WITHOUT a
  // default on purpose: the host stores a declared default into the flag's
  // value, so getFlag would then return it even when the user passed nothing —
  // flattening the precedence chain (defaults ← file ← env ← flag). Absent
  // must stay `undefined`, which is what `resolveStartupOrigins` reads.
  for (const field of NAVIGATOR_CONFIG_FIELDS) {
    const flag = field.override?.flag;
    if (flag === undefined) continue;
    if (flag.type === "boolean") {
      pi.registerFlag(flag.name, { type: "boolean", description: flag.description });
    } else {
      pi.registerFlag(flag.name, { type: "string", description: flag.description });
    }
  }

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
    // against 1.2.0: {name, sourceInfo, description?, getArgumentCompletions?,
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
