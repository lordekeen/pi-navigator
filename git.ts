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

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

/** Invalidate the cached git binary availability check. */
export function resetGitAvailabilityCache(): void {
  gitBinaryPresent = null;
}

/** One-time (per process, until invalidated) check whether the git binary is reachable. */
export async function isGitAvailable(cwd: string): Promise<boolean> {
  if (gitBinaryPresent !== null) return gitBinaryPresent;
  gitBinaryPresent = (await runGit(cwd, ["--version"])) !== null;
  return gitBinaryPresent;
}

export async function detectRepo(cwd: string): Promise<RepoInfo> {
  if (!(await isGitAvailable(cwd))) {
    return { available: false, prefix: "", error: "git not found on PATH" };
  }
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) {
    return { available: false, prefix: "", error: "not a git repository" };
  }
  const prefix = (await runGit(cwd, ["rev-parse", "--show-prefix"]))?.trim() ?? "";
  return { available: true, prefix };
}

function stripPrefix(filePath: string, prefix: string): string | null {
  if (!prefix) return filePath;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
}

/**
 * Split `git status --porcelain -uall -z` output into staged (index) and
 * unstaged (worktree) lists, translated from repository-root-relative paths to
 * cwd-relative paths. Untracked entries land in the unstaged list as "??".
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

  const branchOut = (await runGit(cwd, ["branch", "--show-current"])) ?? "";
  const branchName = branchOut.trim();
  const detached = branchName === "";

  // left count = upstream-only commits (behind), right = HEAD-only (ahead).
  let ahead = 0;
  let behind = 0;
  const counts = await runGit(cwd, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (counts) {
    const parts = counts.trim().split(/\s+/);
    behind = Number.parseInt(parts[0] ?? "0", 10) || 0;
    ahead = Number.parseInt(parts[1] ?? "0", 10) || 0;
  }

  const statusOut = (await runGit(cwd, ["status", "--porcelain", "-uall", "-z"])) ?? "";
  const { unstaged, staged } = parsePorcelain(statusOut, detected.prefix);

  const history: GitCommit[] = [];
  const logOut =
    (await runGit(cwd, ["log", `-n${GIT_HISTORY_COUNT}`, "--date=relative", `--pretty=format:%h%x1f%ad%x1f%s`])) ?? "";
  for (const line of logOut.split("\n")) {
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
  const out = (await runGit(cwd, ["ls-files", "-z"])) ?? "";
  return out.split(NUL).filter((line) => line.length > 0);
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
