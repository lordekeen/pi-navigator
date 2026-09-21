/**
 * pi-navigator constants.
 *
 * Values locked in plans/pi-navigator-implementation-plan.md sections 6, 7 and 8.
 * No runtime dependency is introduced here; every number is consumed by the
 * data modules (tree, git, viewer) and the overlay component.
 */

// ── Refresh ──

/** Git and tree refresh base interval while the overlay is open. */
export const REFRESH_INTERVAL_MS = 3000;

/** Maximum idle polling interval under dynamic backoff. */
export const MAX_POLL_INTERVAL_MS = 10000;

// ── Viewing caps ──

/** Files larger than this render as a truncated head plus a notice row. */
export const MAX_HIGHLIGHT_BYTES = 1024 * 1024;

/** Line cap for full highlighting; beyond it the file is truncated. */
export const MAX_HIGHLIGHT_LINES = 5000;

/** Line counting is skipped above this size. */
export const MAX_LINE_COUNT_BYTES = 256 * 1024;

/**
 * Maximum number of parsed ViewerFile entries kept in the per-file viewer
 * cache in index.ts. Re-opening a file whose mtime is unchanged reuses the
 * cached highlighted lines instead of re-running the loadFile pipeline.
 */
export const MAX_VIEWER_CACHE_ENTRIES = 16;

/** Bytes read for binary sniffing (NUL byte detection). */
export const BINARY_SNIFF_BYTES = 4096;

/** Tabs expand to this many columns before highlighting. */
export const TAB_WIDTH = 4;

// ── Tree ──

/** Directory recursion depth cap for the filesystem walk fallback. */
export const MAX_TREE_DEPTH = 6;

/** Directory names skipped by the filesystem walk fallback. */
export const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".pytest_cache",
  ".mypy_cache",
  "__pycache__",
  "venv",
  ".venv",
  ".DS_Store",
]);

/** Extensions routed to the image viewer tier instead of text. */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

/** Extensions identified as Markdown files for rendered viewing. */
export const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);

// ── Settings ──

/** User-level pi-navigator settings file, under the pi agent dir. */
export const NAVIGATOR_SETTINGS_FILE = "pi-navigator.json";

/** Environment override for the image rendering mode (read once in index.ts). */
export const NAVIGATOR_IMAGES_ENV = "PI_NAV_IMAGES";

// ── Chafa / image rendering ──

/** pi-chafa's config file name (read-only mirror; never written here). */
export const PI_CHAFA_CONFIG_FILE = "pi-chafa.json";

/** Minimum supported chafa version; matches pi-chafa's MIN_CHAFA_VERSION. */
export const CHAFA_MIN_VERSION = { major: 1, minor: 10 } as const;

/** Below this many columns the metadata card wins over a rendered image. */
export const IMAGE_CELLS_MIN = 16;

/** Hard column cap for a chafa render, whatever the pi-chafa preference says. */
export const IMAGE_CELLS_MAX = 100;

/** Below this many rows the metadata card wins over a rendered image. */
export const IMAGE_ROWS_MIN = 4;

/** `chafa --version` probe timeout. */
export const IMAGE_PROBE_TIMEOUT_MS = 3000;

/** Lower clamp for a chafa render timeout (pi-chafa timeoutMs may be lower). */
export const IMAGE_RENDER_TIMEOUT_MIN_MS = 500;

/** Upper clamp for a chafa render timeout. */
export const IMAGE_RENDER_TIMEOUT_MAX_MS = 60_000;

/** stdout cap for one chafa render (8 MiB), matching the bounded-memory rule. */
export const IMAGE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Debounce before re-rendering an open image at a new pane geometry. */
export const IMAGE_RESIZE_DEBOUNCE_MS = 250;

/** Bounded length for a chafa failure reason shown on the fallback card. */
export const IMAGE_ERROR_MAX_CHARS = 200;

// ── Git ──

/** Timeout for every git invocation. */
export const GIT_TIMEOUT_MS = 3000;

/** Commits pulled for the history section. */
export const GIT_HISTORY_COUNT = 20;

/** Maximum ancestor depth when a commit's family tree is expanded. */
export const FAMILY_MAX_DEPTH = 3;

/** Maximum rows rendered by one expanded commit family. */
export const FAMILY_MAX_ROWS = 16;

// ── Layout ──

/** Overlay options passed to ctx.ui.custom. */
export const OVERLAY_OPTIONS = {
  width: "90%",
  minWidth: 80,
  maxHeight: "85%",
  anchor: "center",
  margin: 1,
} as const;

/** Left column: 30 percent of the inner width, clamped. */
export const LEFT_COLUMN_RATIO = 0.3;
export const LEFT_COLUMN_MIN = 24;
export const LEFT_COLUMN_MAX = 44;

/** Below this inner width the left column is hidden (toggle with t). */
export const LEFT_COLUMN_HIDE_BELOW = 72;

/** Minimum rows reserved for the git section of the left column. */
export const GIT_MIN_ROWS = 4;

/** Below this overlay width the compact notice is rendered instead. */
export const MIN_OVERLAY_WIDTH = 40;
/**
 * Below this overlay height the compact notice is rendered instead. Five rows
 * are chrome (top border, title, separator, footer, bottom border), so this is
 * the plan section 6 minimum of 8 body rows plus that chrome.
 */
export const MIN_OVERLAY_HEIGHT = 13;

/** Half-page scroll fraction for ctrl+d / ctrl+u. */
export const HALF_PAGE_DIVISOR = 2;
