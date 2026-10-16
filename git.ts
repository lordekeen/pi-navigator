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
import { stat } from "node:fs/promises";

import { sanitizeText } from "./ansi";
import { truncateUtf8ToBytes } from "./bytes";
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
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
      // Node reports ENOENT with the same shape for a missing git binary and a
      // missing spawn cwd (path is the command, not the cwd), so verify the
      // cwd before blaming the binary: a deleted or renamed worktree is
      // transient and must not permanently disable git (Issue #186).
      if (!(await cwdIsDirectory(cwd))) return { status: "error" };
      // A spawn ENOENT with the cwd present means the git binary is not on
      // PATH. Cache false to avoid spawning every tick (Issue #047).
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

/** Does the spawn cwd exist as a directory? (Issue #186) */
async function cwdIsDirectory(cwd: string): Promise<boolean> {
  try {
    return (await stat(cwd)).isDirectory();
  } catch {
    return false;
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
  // Transient failure (timeout, permissions, missing cwd): report false
  // without caching a verdict (Issues #047, #186). No write here — the field
  // is null on this path by construction, and writing null could clobber a
  // concurrent probe's `true`.
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
  // The prefix is the output's last line: a repository path may itself
  // contain newlines, and a path segment may begin or end with a space, so
  // neither `split("\n")[1]` nor `.trim()` is safe. Strip exactly the one
  // trailing newline git writes; never trim.
  const stdout = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  const lastBreak = stdout.lastIndexOf("\n");
  const prefix = lastBreak === -1 ? "" : stdout.slice(lastBreak + 1);
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
): { unstaged: GitChangedFile[]; staged: GitChangedFile[]; unmerged: GitChangedFile[] } {
  const unstaged: GitChangedFile[] = [];
  const staged: GitChangedFile[] = [];
  const unmerged: GitChangedFile[] = [];
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
    // Porcelain v1 reports a merge conflict as a two-character XY code.
    // Reading raw[0]/raw[1] as independent single letters fabricated a
    // staged "U" and an unstaged "U"; the pair is one unmerged record and
    // must not reach `staged`/`unstaged` at all (Issue #202).
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      unmerged.push({ relPath, code: x + y });
      continue;
    }
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
  return { unstaged, staged, unmerged };
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
    unmerged: [],
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

  const branchName = branchRes.status === "ok" ? sanitizeText(branchRes.stdout.trim()) : "";
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
  const { unstaged, staged, unmerged } = parsePorcelain(statusText, detected.prefix);

  const history: GitCommit[] = [];
  const logText = logRes.status === "ok" ? logRes.stdout : "";
  for (const line of logText.split("\n")) {
    if (!line) continue;
    const parts = line.split(UNIT_SEPARATOR);
    const shortHash = parts[0];
    if (!shortHash) continue;
    const parentsRaw = parts[1];
    const dateRel = parts[2];
    const subject = sanitizeText(parts.slice(3).join(UNIT_SEPARATOR));
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
    unmerged,
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
  const files = [...state.staged, ...state.unstaged, ...state.unmerged].map((file) => `${file.code} ${file.relPath}`);
  return [`${state.branch ?? ""} ${state.ahead} ${state.behind}`, ...files].join("\n");
}

/**
 * Map a git index mode to a tree entry's shape. `160000` is a gitlink (a
 * submodule: the tree must materialize it as a directory row, since the path
 * is a directory on disk); `120000` is a symlink (`TreeEntry.symlink`, the
 * `↗` marker); every other mode (`100644`/`100755`) is a plain file.
 * (Issue #219.)
 */
function modeFlags(mode: string): { isDir: boolean; symlink: boolean } {
  if (mode === "160000") return { isDir: true, symlink: false };
  if (mode === "120000") return { isDir: false, symlink: true };
  return { isDir: false, symlink: false };
}

/**
 * Tracked files via `git ls-files --stage --full-name -z`, each record
 * carrying its index mode. Private: `readGitTree` is the one path from git to
 * tree entries (Issue #146).
 *
 * `--stage` (`-s`) prefixes every record with `<mode> <sha> <stage>` and a tab;
 * the mode is where the entry type lives — `160000` a gitlink (submodule),
 * `120000` a symlink, `100644`/`100755` a plain blob — and `readGitTree` maps
 * it to `TreeEntry.isDir`/`symlink` (Issue #219).
 *
 * `--full-name` matters: without it `ls-files` prints paths relative to the
 * cwd, so from a repository subdirectory the prefix translation in
 * `readGitTree` would see no `repo.prefix` match and drop every tracked path.
 * With it the listing stays repository-root-relative, which is the invariant
 * the prefix translation relies on.
 */
async function readTrackedFiles(cwd: string): Promise<Array<{ mode: string; path: string }>> {
  const result = await runGit(cwd, ["ls-files", "--stage", "--full-name", "-z"]);
  if (result.status !== "ok") return [];
  const records: Array<{ mode: string; path: string }> = [];
  for (const raw of result.stdout.split(NUL)) {
    if (raw.length === 0) continue;
    // Only the first tab separates metadata from path: a path may contain tabs.
    const tab = raw.indexOf("\t");
    if (tab === -1) continue; // malformed record (no --stage metadata)
    const mode = raw.slice(0, tab).trim().split(/\s+/)[0] ?? "";
    records.push({ mode, path: raw.slice(tab + 1) });
  }
  return records;
}

/**
 * Ignored untracked paths via `git ls-files --others --ignored --exclude-standard
 * --directory --full-name -z` (Issue #158). `--exclude-standard` covers the full
 * ignore stack git applies (`.gitignore`, `.git/info/exclude`, the global
 * excludes file); `--directory` collapses a fully ignored directory into ONE
 * `dir/` record, whose trailing slash this boundary normalizes into a
 * slash-free relPath plus `isDir` — the same convention `readGitTree` uses for
 * porcelain's `?? dir/` marker. `--full-name` keeps the listing
 * repository-root-relative even from a subdirectory cwd, so `stripPrefix`
 * translates it exactly like `readTrackedFiles` (without it a subdirectory cwd
 * yields cwd-relative paths such as `./`). First occurrence wins. Never throws:
 * a failed or overflowing listing degrades to `[]` (the caller then simply has
 * nothing to merge or filter), and ignored records never enter `GitState`, so
 * the git panel's staged/unstaged lists and the porcelain probe stay untouched.
 */
export async function readIgnoredEntries(cwd: string, repo: RepoInfo): Promise<TreeEntry[]> {
  const result = await runGit(cwd, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "--full-name",
    "-z",
  ]);
  if (result.status !== "ok") return [];
  const seen = new Set<string>();
  const entries: TreeEntry[] = [];
  for (const raw of result.stdout.split(NUL)) {
    if (raw.length === 0) continue;
    const isDir = raw.endsWith("/");
    const relPath = stripPrefix(isDir ? raw.slice(0, -1) : raw, repo.prefix);
    if (!relPath || seen.has(relPath)) continue; // outsiders dropped, deduped
    seen.add(relPath);
    entries.push({ relPath, isDir, symlink: false });
  }
  return entries;
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
  for (const record of tracked) {
    const rel = stripPrefix(record.path, repo.prefix);
    if (!rel || seen.has(rel)) continue; // outsiders dropped
    seen.add(rel);
    entries.push({ relPath: rel, ...modeFlags(record.mode) });
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
  // Unmerged last: it wins, because the conflict is the state the user must
  // resolve, and its two-char code is the one the tree badge should show
  // (Issue #202).
  for (const file of state.unmerged) map.set(file.relPath, file.code);
  return map;
}

/**
 * A commit's diff, ready for the viewer pane. `lines` carries the **plain**
 * (unstyled) diff body; the caller (`session.ts` `loadCommit`) composes it
 * with the active theme via composeDiffLines/`styleDiffLines` so git.ts stays
 * theme-free (matching viewer.ts's "highlight in the loader" split).
 */
export interface CommitDiff {
  shortHash: string;
  /** Parent short hashes; empty for a root commit. */
  parents: string[];
  /**
   * Plain diff body lines, already CR-normalized. A root commit diffs against
   * the empty tree, so its lines list the whole content as additions.
   */
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
  // Repo-controlled text: strip terminal-active bytes after CR normalization
  // so the byte cap below measures the string that is actually rendered (Issue #201).
  msgText = sanitizeText(msgText);
  let messageTruncated = false;
  if (Buffer.byteLength(msgText, "utf8") > MAX_HIGHLIGHT_BYTES) {
    msgText = truncateUtf8ToBytes(Buffer.from(msgText, "utf8"), MAX_HIGHLIGHT_BYTES).toString("utf8");
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
  // A binary diff body would render as garbage (control bytes); emit a notice
  // instead of an unexplained empty body (Issue #187; Issue #024 spirit).
  const binary = body.includes("\0");
  if (binary) body = "";

  body = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Same boundary for the diff body: sanitize after CR normalization, before
  // the byte cap, so a raw escape in a hunk cannot reach a rendered row (Issue #201).
  body = sanitizeText(body);
  // Byte-true cap (Issue #060 finding 5): `body.length` counts UTF-16 code
  // units — multi-byte characters overcount the budget, and `.slice` can split
  // a surrogate pair mid-way. The shared UTF-8 cap truncates to the byte
  // budget at a code-point boundary (the same rule capped file reads use).
  if (Buffer.byteLength(body, "utf8") > MAX_HIGHLIGHT_BYTES) {
    body = truncateUtf8ToBytes(Buffer.from(body, "utf8"), MAX_HIGHLIGHT_BYTES).toString("utf8");
    truncated = true;
  }

  let lines = body.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  // The composed array `composeDiffLines` builds is what MAX_HIGHLIGHT_LINES
  // bounds: subject + message body + separator + diff body. Cap the message
  // first, then the diff body to what remains (Issue #187 — capping each
  // source independently allowed roughly twice the budget).
  if (commitMessage.body.length + 1 > MAX_HIGHLIGHT_LINES) {
    commitMessage.body = commitMessage.body.slice(0, MAX_HIGHLIGHT_LINES - 1);
    messageTruncated = true;
  }
  const messageLines = (commitMessage.subject === "" ? 0 : 1) + commitMessage.body.length;
  const separator = messageLines > 0 && lines.length > 0 ? 1 : 0;
  const bodyBudget = Math.max(0, MAX_HIGHLIGHT_LINES - messageLines - separator);
  if (lines.length > bodyBudget) {
    lines = lines.slice(0, bodyBudget);
    truncated = true;
  }

  const filesLabel =
    filesChanged === 1 ? "1 file" : filesChanged === 0 ? "no files" : `${filesChanged} files`;
  let notice = `commit ${shortHash} \u00b7 ${filesLabel} \u00b7 +${insertions} \u2212${deletions}`;
  if (truncated || messageTruncated) notice += ` \u00b7 diff truncated (showing the head)`;
  if (binary) notice += ` \u00b7 binary diff (not shown)`;
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

