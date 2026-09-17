/**
 * pi-navigator git access.
 *
 * Every invocation is async (execFile with a timeout) and cached by the
 * caller; the render path never blocks on git. Missing git or a missing
 * repository degrade to `available: false` plus a human readable state line.
 *
 * Parsing note: status is read as `--porcelain -uall -z` and the tracked list
 * as `ls-files -z`, so paths arrive verbatim (no C-style quoting) and only NUL
 * separates records. In -z output a renamed or copied entry carries its source
 * path in the *following* record with the field order reversed (target first,
 * then source) — git-status, "Porcelain Format Version 1". The parser consumes
 * that record and keeps the target path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { GIT_HISTORY_COUNT, GIT_TIMEOUT_MS } from "./constants";
import type { GitChangedFile, GitCommit, GitState } from "./types";

const execFileAsync = promisify(execFile);

const UNIT_SEPARATOR = "\u001f";
const NUL = "\0";

export interface RepoInfo {
  /** Git binary present AND cwd inside a repository. */
  available: boolean;
  /** Repository-root-relative prefix of cwd, "" at the root. */
  prefix: string;
  error?: string;
}

let gitBinaryPresent: boolean | null = null;

/**
 * Result of a single git invocation. `"ok"` carries stdout; `"overflow"`
 * means the output exceeded `maxBuffer` (e.g. a monorepo with enormous
 * `status -uall`/`ls-files` output) and must be surfaced rather than silently
 * treated as empty; `"error"` is any other failure (non-zero exit, timeout,
 * missing binary). (Issue #024.)
 */
type GitResult = { status: "ok"; stdout: string } | { status: "overflow" } | { status: "error" };

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { status: "ok", stdout };
  } catch (error) {
    // A spawn ENOENT means the git binary itself is not on PATH: the cached
    // availability check is stale, so clear it and let the next `isGitAvailable`
    // re-detect (e.g. git was installed after the overlay opened). Non-zero
    // exits and timeouts have a numeric `code`, not "ENOENT", so this only
    // resets on a genuinely missing binary.
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      gitBinaryPresent = null;
    }
    // maxBuffer overflow is signaled by Node as code "ERR_CHILD_PROCESS_STDIO_MAXBUFFER".
    if (
      error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ) {
      return { status: "overflow" };
    }
    return { status: "error" };
  }
}

/** One-time (per process, until invalidated) check whether the git binary is reachable. */
export async function isGitAvailable(cwd: string): Promise<boolean> {
  if (gitBinaryPresent !== null) return gitBinaryPresent;
  const result = await runGit(cwd, ["--version"]);
  gitBinaryPresent = result.status === "ok";
  return gitBinaryPresent;
}

export async function detectRepo(cwd: string): Promise<RepoInfo> {
  if (!(await isGitAvailable(cwd))) {
    return { available: false, prefix: "", error: "git not found on PATH" };
  }
  // `--show-toplevel` and `--show-prefix` are independent of the other state
  // commands; fetch both in a single spawn. Output is "<toplevel>\n<prefix>\n"
  // (prefix may be empty at the repo root). Fails outside a repo, which maps
  // to the "not a git repository" case.
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel", "--show-prefix"]);
  if (result.status !== "ok") {
    return { available: false, prefix: "", error: "not a git repository" };
  }
  const prefix = (result.stdout.split("\n")[1] ?? "").trim();
  return { available: true, prefix };
}

function stripPrefix(filePath: string, prefix: string): string | null {
  if (!prefix) return filePath;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

/**
 * Split `git status --porcelain -unormal -z` output into staged (index) and
 * unstaged (worktree) lists, translated from repository-root-relative paths to
 * cwd-relative paths. Untracked entries land in the unstaged list as "??".
 * `-unormal` lists untracked files and directories without recursing into
 * every file under an untracked directory, keeping the output bounded (Issue #024).
 */
export function parsePorcelain(
  text: string,
  prefix: string,
): { unstaged: GitChangedFile[]; staged: GitChangedFile[] } {
  const unstaged: GitChangedFile[] = [];
  const staged: GitChangedFile[] = [];
  const records = text.split(NUL);

  for (let index = 0; index < records.length; index++) {
    const raw = records[index] ?? "";
    if (raw.length < 4) continue;
    const x = raw[0] ?? " ";
    const y = raw[1] ?? " ";
    const filePath = raw.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      // The source path of a rename or copy is the next NUL-separated record.
      index += 1;
    }
    const relPath = stripPrefix(filePath, prefix);
    if (!relPath) continue;
    if (x === "?" && y === "?") {
      unstaged.push({ relPath, code: "??" });
      continue;
    }
    if (x !== " " && x !== "?") staged.push({ relPath, code: x });
    if (y !== " " && y !== "?") unstaged.push({ relPath, code: y });
  }
  return { unstaged, staged };
}

/**
 * Read the full git state for the panel. Never throws; failures degrade to an
 * unavailable state that the UI renders as a single explanation row.
 *
 * Pass an already-detected `repo` to skip the second `git rev-parse` pair that
 * `detectRepo` would otherwise run on every refresh tick.
 */
export async function readGitState(cwd: string, repo?: RepoInfo): Promise<GitState> {
  const unavailable: GitState = {
    available: false,
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    unstaged: [],
    staged: [],
    history: [],
    refreshedAt: Date.now(),
  };

  const detected = repo ?? (await detectRepo(cwd));
  if (!detected.available) {
    return { ...unavailable, error: detected.error };
  }

  // branch / ahead-behind counts / status / log are mutually independent —
  // run them concurrently so a single tick waits one round, not four.
  // `-unormal` bounds untracked listing so a monorepo with huge untracked
  // trees does not overflow maxBuffer (Issue #024).
  const [branchRes, countsRes, statusRes, logRes] = await Promise.all([
    runGit(cwd, ["branch", "--show-current"]),
    runGit(cwd, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]),
    runGit(cwd, ["status", "--porcelain", "-unormal", "-z"]),
    runGit(cwd, ["log", `-n${GIT_HISTORY_COUNT}`, "--date=relative", `--pretty=format:%h%x1f%ad%x1f%s`]),
  ]);

  // Surface maxBuffer overflow instead of silently rendering an empty panel.
  // Status overflow is the most user-visible (lost change list); log overflow
  // is less likely given the -n cap but handled the same way. Reported as
  // unavailable with an explanatory error so the git panel surfaces it as its
  // single explanation row rather than showing empty lists.
  if (statusRes.status === "overflow" || logRes.status === "overflow") {
    return {
      ...unavailable,
      error: "git output exceeded the 4 MB buffer — untracked tree too large; re-run after cleaning or narrowing the worktree",
    };
  }

  const branchName = branchRes.status === "ok" ? branchRes.stdout.trim() : "";
  const detached = branchName === "";

  // left count = upstream-only commits (behind), right = HEAD-only (ahead).
  let ahead = 0;
  let behind = 0;
  if (countsRes.status === "ok") {
    const parts = countsRes.stdout.trim().split(/\s+/);
    behind = Number.parseInt(parts[0] ?? "0", 10) || 0;
    ahead = Number.parseInt(parts[1] ?? "0", 10) || 0;
  }

  const statusText = statusRes.status === "ok" ? statusRes.stdout : "";
  const { unstaged, staged } = parsePorcelain(statusText, detected.prefix);

  const history: GitCommit[] = [];
  const logText = logRes.status === "ok" ? logRes.stdout : "";
  for (const line of logText.split("\n")) {
    if (!line) continue;
    const [shortHash, dateRel, subject] = line.split(UNIT_SEPARATOR);
    if (!shortHash) continue;
    history.push({ shortHash, dateRel: dateRel ?? "", subject: subject ?? "" });
  }

  return {
    available: true,
    branch: detached ? null : branchName,
    detached,
    ahead,
    behind,
    unstaged,
    staged,
    history,
    refreshedAt: Date.now(),
  };
}

/**
 * Cheap tree-change probe for git mode (plan section 7). The porcelain-derived
 * path/status signature is the plan's stated probe; branch and ahead/behind are
 * folded in because they are already on hand and catch commits, pulls and
 * pushes that leave the working tree clean, where the status text alone would
 * not change. Comparing this string costs nothing next to `ls-files`.
 */
export function gitTreeProbe(state: GitState): string {
  const files = [...state.staged, ...state.unstaged].map((file) => `${file.code} ${file.relPath}`);
  return [`${state.branch ?? ""} ${state.ahead} ${state.behind}`, ...files].join("\n");
}

/** Tracked files (repository-root-relative) via `git ls-files -z`. */
export async function readTrackedFiles(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ["ls-files", "-z"]);
  if (result.status !== "ok") return [];
  return result.stdout.split(NUL).filter((line) => line.length > 0);
}

/** Translate repository-root-relative paths to cwd-relative, dropping outsiders. */
export function toCwdRelative(paths: string[], prefix: string): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const rel = stripPrefix(p, prefix);
    if (rel) out.push(rel);
  }
  return out;
}

/** Per-path status badge map; worktree codes win over index codes. */
export function gitCodeMap(state: GitState): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of state.staged) map.set(file.relPath, file.code);
  for (const file of state.unstaged) map.set(file.relPath, file.code);
  return map;
}
