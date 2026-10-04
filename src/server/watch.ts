import { watch, type FSWatcher } from "chokidar";
import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";

/**
 * Filesystem watcher for live analysis. chokidar on the repo root, events
 * filtered to analysis-relevant inputs — the debounce lives in
 * LiveAnalysis so one save-burst produces one request.
 *
 * Watched: source files (.ts/.tsx/.js/.jsx/.mts/.cts/.d.ts) plus the config
 * inputs that feed the repo fingerprint (tsconfig, package.json,
 * lockfiles). Everything else is ignored before it can trigger work.
 */

// chokidar 4 dropped glob `ignored` — use a path-segment regex instead.
const IGNORED_DIR_RE =
  /(^|\/|\\)(node_modules|\.git|\.ripple|dist|build|coverage|\.next|\.turbo|out|\.cache)(\/|\\|$)/i;

const RELEVANT_FILE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|d\.ts)$|(^|\/)tsconfig[^/]*\.json$|(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i;

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
  opts: { ignoreInitial?: boolean } = {},
): FSWatcher {
  const w = watch(toLongPath(repoRoot), {
    ignored: (p: string, stats?: { isFile(): boolean }) => {
      const n = normalize(p).split("\\").join("/");
      if (IGNORED_DIR_RE.test(n)) return true;
      return stats?.isFile() === true && !RELEVANT_FILE.test(n);
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
