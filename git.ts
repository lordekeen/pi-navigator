/**
 * pi-navigator git access.
 *
 * Every invocation is async (execFile with a timeout) and cached by the
 * caller; the render path never blocks on git. Missing git or a missing
 * repository degrade to `available: false` plus a human readable state line.
 *
 * Parsing note: status is read as `--porcelain -unormal -z` and the tracked list
 * as `ls-files -z`, so paths arrive verbatim (no C-style quoting) and only NUL
 * separates records. In -z output a renamed or copied entry carries its source
 * path in the *following* record with the field order reversed (target first,
 * then source) — git-status, "Porcelain Format Version 1". The parser consumes
 * that record and keeps the target path. A trailing slash on a record's path
 * is porcelain's marker for an entirely untracked directory (`?? dir/`); it is
 * normalized once, at this boundary, into a slash-free relPath plus
 * `GitChangedFile.isDir` — no downstream consumer reads the marker again
 * (Issue #146).
 */

import * as childProcess from "node:child_process";

import { GIT_HISTORY_COUNT, GIT_TIMEOUT_MS, MAX_HIGHLIGHT_BYTES, MAX_HIGHLIGHT_LINES } from "./constants";
import type { CommitMessage } from "./diff";
import type { TreeEntry } from "./tree";
import type { GitChangedFile, GitCommit, GitState } from "./types";

export const gitRunner = {
  execFile: childProcess.execFile,
};

function execFileAsync(
  file: string,
  args: string[],
  options: childProcess.ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    gitRunner.execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

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
 * means the output exceeded `maxBuffer` (e.g. oversized `status -unormal`/
 * `ls-files` output) and must be surfaced rather than silently treated as
 * empty; `"error"` is any other failure (non-zero exit, timeout,
 * missing binary). (Issue #024.)
 */
type GitResult =
  | { status: "ok"; stdout: string }
  | { status: "overflow" }
  | { status: "missing" }
  | { status: "error" };

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
    // A spawn ENOENT means the git binary itself is not on PATH.
    // Cache false to avoid spawning every tick (Issue #047).
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      gitBinaryPresent = false;
      return { status: "missing" };
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
  if (result.status === "ok") {
    gitBinaryPresent = true;
    return true;
  }
  if (result.status === "missing") {
    gitBinaryPresent = false;
    return false;
  }
  // Transient failure (timeout, permissions): do not cache false permanently (Issue #047).
  gitBinaryPresent = null;
  return false;
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
      // The trailing slash is porcelain's marker for an entirely untracked
      // directory (`?? dir/`). Normalize it here — the one production
      // interpretation — into a slash-free relPath plus the isDir fact, so
      // tree entries and badge keys agree without re-reading the marker
      // downstream (Issue #146).
      if (relPath.endsWith("/")) {
        unstaged.push({ relPath: relPath.slice(0, -1), code: "??", isDir: true });
      } else {
        unstaged.push({ relPath, code: "??" });
      }
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
    runGit(cwd, ["log", `-n${GIT_HISTORY_COUNT}`, "--date=relative", "--parents", `--pretty=format:%h%x1f%p%x1f%ad%x1f%s`]),
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
    const parts = line.split(UNIT_SEPARATOR);
    const shortHash = parts[0];
    if (!shortHash) continue;
    const parentsRaw = parts[1];
    const dateRel = parts[2];
    const subject = parts.slice(3).join(UNIT_SEPARATOR);
    history.push({
      shortHash,
      parents: parentsRaw ? parentsRaw.split(" ") : [],
      dateRel: dateRel ?? "",
      subject: subject ?? "",
    });
  }

  // A failed status read must not masquerade as a clean tree: keep the state
  // available (branch/counts/history are still valid) but surface the failure
  // so the pane shows the error row instead of a false "Clean" line (Issue #107).
  const statusFailed = statusRes.status === "error" || statusRes.status === "missing";
  return {
    available: true,
    branch: detached ? null : branchName,
    detached,
    ahead,
    behind,
    unstaged,
    staged,
    history,
    error: statusFailed ? "git status failed \u2014 changes not listed (press r to retry)" : undefined,
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

/**
 * Tracked files via `git ls-files --full-name -z`. Private: `readGitTree` is
 * the one path from git to tree entries (Issue #146).
 *
 * `--full-name` matters: without it `ls-files` prints paths relative to the
 * cwd, so from a repository subdirectory the prefix translation in
 * `readGitTree` would see no `repo.prefix` match and drop every tracked path.
 * With it the listing stays repository-root-relative, which is the invariant
 * the prefix translation relies on.
 */
async function readTrackedFiles(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ["ls-files", "--full-name", "-z"]);
  if (result.status !== "ok") return [];
  return result.stdout.split(NUL).filter((line) => line.length > 0);
}

/**
 * Tree-ready cwd-relative entries for the git source (Issue #146): tracked
 * paths from `ls-files -z` translated through `repo.prefix` (outsiders
 * dropped) first, then the untracked `??` records from the porcelain state
 * (already cwd-relative; `isDir` carries porcelain's untracked-directory
 * marker). `readTrackedFiles` reads with `--full-name`, so the tracked
 * listing is repository-root-relative even when cwd is a subdirectory — the
 * invariant the prefix translation depends on (Issue #146). First occurrence
 * wins, so a path that is both tracked and listed untracked keeps its
 * tracked entry. Never throws: a failed `ls-files` degrades to
 * untracked-only, exactly as the old inline merge did. Policy stays with the
 * caller — the untracked-directory subtree fill and the empty-repo fs
 * fallback are session concerns.
 */
export async function readGitTree(cwd: string, git: GitState, repo: RepoInfo): Promise<TreeEntry[]> {
  const tracked = await readTrackedFiles(cwd);
  const seen = new Set<string>();
  const entries: TreeEntry[] = [];
  for (const p of tracked) {
    const rel = stripPrefix(p, repo.prefix);
    if (!rel || seen.has(rel)) continue; // outsiders dropped
    seen.add(rel);
    entries.push({ relPath: rel, isDir: false, symlink: false });
  }
  for (const file of git.unstaged) {
    if (file.code !== "??") continue;
    if (seen.has(file.relPath)) continue;
    seen.add(file.relPath);
    entries.push({ relPath: file.relPath, isDir: file.isDir === true, symlink: false });
  }
  return entries;
}

/**
 * Per-path status badge map; worktree codes win over index codes. Keys are
 * the normalized relPaths `parsePorcelain` produced — the `?? dir/` trailing
 * slash is stripped and recorded as `isDir` at parse time (Issue #146) — so
 * the key matches the tree node's relPath and the `??` badge lands on the
 * directory row itself (Issue #058).
 */
export function gitCodeMap(state: GitState): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of state.staged) map.set(file.relPath, file.code);
  for (const file of state.unstaged) map.set(file.relPath, file.code);
  return map;
}

/**
 * A commit's diff, ready for the viewer pane. `lines` carries the **plain**
 * (unstyled) diff body; the caller (index.ts) styles it with the active
 * theme via styleDiffLines so git.ts stays theme-free (matching viewer.ts's
 * "highlight in the loader" split).
 */
export interface CommitDiff {
  shortHash: string;
  /** Parent short hashes; empty for a root commit. */
  parents: string[];
  /** Plain diff body lines, already CR-normalized. Empty for a root commit. */
  lines: string[];
  /** Files changed count + insertions/deletions for the notice row. */
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Human summary, e.g. "commit abc1234 · 1 file · +2 −0". */
  notice: string;
  /**
   * The commit's full message, split for display (Issue #120): `subject` is
   * the first line, `body` the lines after it (trailing blanks trimmed).
   * Plain text — the caller styles it via styleCommitMessage so this module
   * stays theme-free.
   */
  message: CommitMessage;
}

/**
 * Read one commit's diff. This is the v3 commit-detail view data source.
 *
 * Never throws and is bounded the same way the file viewer is: the body is
 * capped at MAX_HIGHLIGHT_BYTES bytes (binary detection happens on the plain
 * text: a NUL byte in the diff output means the commit touches a binary
 * blob, and the body is treated as empty rather than rendered as garbage).
 * The stat line (files changed / insertions / deletions) is read separately
 * from `git show --numstat` and folded into `notice`.
 *
 * For a **merge commit**, `git show` without options emits no diff body
 * (combined diff format), so the body is constructed from `--first-parent`
 * (the merge's own delta) and the stat reflects that single-parent view —
 * the same deltas lazygit/gitui surface for a merge. `--first-parent` also
 * resolves the *parent hash used for `..` diffing* for a merge, since a
 * first-parent diff is expressed against parent 1.
 */
export async function readCommitDiff(cwd: string, shortHash: string): Promise<CommitDiff> {
  // Resolve the short hash to a full one (handles ambiguous shorts safely).
  const resolved = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${shortHash}^{commit}`]);
  if (resolved.status !== "ok") {
    return {
      shortHash,
      parents: [],
      lines: [],
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      notice: `cannot read commit ${shortHash}`,
      message: { subject: "", body: [] },
    };
  }
  const fullHash = resolved.stdout.trim();

  const parentsRes = await runGit(cwd, ["show", "-s", "--pretty=format:%p", fullHash]);
  const parents =
    parentsRes.status === "ok"
      ? parentsRes.stdout.trim().split(/\s+/).filter((p) => p.length > 0)
      : [];

  // Parallel: message + body + stat line. Both show calls use --first-parent
  // so a merge commit's own delta is shown rather than an empty combined
  // diff; the message read is format-only (no patch) so it is merge-safe too.
  const [msgRes, bodyRes, statRes] = await Promise.all([
    runGit(cwd, ["show", "-s", "--pretty=format:%B", "--no-color", fullHash]),
    runGit(cwd, ["show", "--no-color", "--no-renames", "--first-parent", "--pretty=format:", fullHash]),
    runGit(cwd, ["show", "--numstat", "--format=", "--no-renames", "--first-parent", fullHash]),
  ]);

  // The full commit message (Issue #120): CR-normalize, split on newlines,
  // trim trailing blank lines. Bounded below with the diff body so a huge
  // message degrades exactly like a huge diff (truncation notice).
  let msgText = msgRes.status === "ok" ? msgRes.stdout : "";
  msgText = msgText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let messageTruncated = false;
  if (Buffer.byteLength(msgText, "utf8") > MAX_HIGHLIGHT_BYTES) {
    const bytes = Buffer.from(msgText, "utf8");
    let end = MAX_HIGHLIGHT_BYTES;
    while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
    msgText = bytes.subarray(0, end).toString("utf8");
    messageTruncated = true;
  }
  const msgLines = msgText.split("\n");
  while (msgLines.length > 0 && msgLines[msgLines.length - 1] === "") msgLines.pop();
  const commitMessage: CommitMessage = { subject: msgLines.shift() ?? "", body: msgLines };

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  if (statRes.status === "ok") {
    for (const raw of statRes.stdout.split("\n")) {
      const m = raw.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (!m) continue; // skip the summary line
      filesChanged += 1;
      // Binary rows emit "-" instead of numeric counts; leave those at 0 (Issue #106).
      if (m[1] !== "-") insertions += Number.parseInt(m[1] ?? "0", 10) || 0;
      if (m[2] !== "-") deletions += Number.parseInt(m[2] ?? "0", 10) || 0;
    }
  }

  // Cap the captured stdout before splitting so a huge diff never allocates
  // more than the viewer caps (same boundedness as loadFile).
  let body = bodyRes.status === "ok" ? bodyRes.stdout : "";
  let truncated = false;
  // A binary diff body would render as garbage (control bytes); degrade to a
  // notice instead (Issue #024 spirit).
  if (body.includes("\0")) {
    body = "";
    truncated = false;
  }

  body = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Byte-true cap (Issue #060 finding 5): `body.length` counts UTF-16 code
  // units — multi-byte characters overcount the budget, and `.slice` can split
  // a surrogate pair mid-way. Truncate to the byte budget, then step back over
  // UTF-8 continuation bytes to a lead byte so no sequence is cut in half
  // (same rule decodeUtf8Head applies to capped file reads).
  if (Buffer.byteLength(body, "utf8") > MAX_HIGHLIGHT_BYTES) {
    const bytes = Buffer.from(body, "utf8");
    let end = MAX_HIGHLIGHT_BYTES;
    while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end -= 1;
    body = bytes.subarray(0, end).toString("utf8");
    truncated = true;
  }

  let lines = body.split("\n");
  if (lines.length > MAX_HIGHLIGHT_LINES) {
    lines = lines.slice(0, MAX_HIGHLIGHT_LINES);
    truncated = true;
  }
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  // A message capped on BYTES or a body capped on LINES sets the flags
  // above; extend the cap to the message LINE count too so the combined
  // viewer array stays bounded by the same MAX_HIGHLIGHT_LINES budget.
  if (commitMessage.body.length + 1 > MAX_HIGHLIGHT_LINES) {
    commitMessage.body = commitMessage.body.slice(0, MAX_HIGHLIGHT_LINES - 1);
    messageTruncated = true;
  }

  const filesLabel =
    filesChanged === 1 ? "1 file" : filesChanged === 0 ? "no files" : `${filesChanged} files`;
  let notice = `commit ${shortHash} \u00b7 ${filesLabel} \u00b7 +${insertions} \u2212${deletions}`;
  if (truncated || messageTruncated) notice += ` \u00b7 diff truncated (showing the head)`;
  return {
    shortHash,
    parents,
    lines,
    filesChanged,
    insertions,
    deletions,
    notice,
    message: commitMessage,
  };
}

