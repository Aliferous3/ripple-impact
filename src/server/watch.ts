import { watch, type FSWatcher } from "chokidar";
import { realpathSync } from "node:fs";
import { normalize, resolve, relative } from "node:path";
import { TS_FILE_RULES } from "../indexers/typescript/adapter.js";

/**
 * Filesystem watcher for live analysis. chokidar on the repo root, events
 * filtered to analysis-relevant inputs — the debounce lives in
 * LiveAnalysis so one save-burst produces one request.
 *
 * "Relevant" is decided by the detected language adapters' file rules
 * (`relevant` option): source files plus the config inputs that feed
 * the repo fingerprint. The default is the TS/JS adapter's rules.
 */

// chokidar 4 dropped glob `ignored` — use a path-segment regex instead.
const IGNORED_DIR_RE =
  /(^|\/|\\)(node_modules|\.git|\.ripple|dist|build|coverage|\.next|\.turbo|out|\.cache)(\/|\\|$)/i;

/**
 * Resolve 8.3 (short-name) components to the real path. fs.watch on
 * Windows asserts in libuv — killing the process — when the watched path
 * contains an 8.3 alias (event filenames arrive in long form and fail the
 * prefix check). `realpathSync.native` performs the expansion.
 */
export function toLongPath(p: string): string {
  const abs = resolve(p);
  if (process.platform !== "win32") return abs;
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

export function watchRepo(
  repoRoot: string,
  onRelevantChange: (path: string) => void,
  opts: { ignoreInitial?: boolean; relevant?: (relPath: string) => boolean } = {},
): FSWatcher {
  const relevant = opts.relevant ?? TS_FILE_RULES.relevantFile;
  const w = watch(toLongPath(repoRoot), {
    ignored: (p: string, stats?: { isFile(): boolean }) => {
      const n = normalize(p).split("\\").join("/");
      if (IGNORED_DIR_RE.test(n)) return true;
      if (stats?.isFile() !== true) return false;
      const rel = relative(repoRoot, n).split("\\").join("/");
      return !relevant(rel);
    },
    ignoreInitial: opts.ignoreInitial ?? true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
  });
  w.on("add", onRelevantChange);
  w.on("change", onRelevantChange);
  w.on("unlink", onRelevantChange);
  // Errors are surfaced but must never kill the explorer.
  w.on("error", () => undefined);
  return w;
}
