import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RippleGraph } from "../graph/graph.js";
import { ScipIndexer } from "../indexers/scip/scip-indexer.js";
import { commitFingerprint, repoFingerprint, type RepoFingerprint } from "./fingerprint.js";
import { RippleCache } from "./store.js";

// Temp dirs (index output, base-revision worktrees) are removed in
// finally paths; the exit hook is a backstop so a hard interruption
// (Ctrl+C, kill) can't routinely leave orphans behind.
const pendingTempDirs = new Set<string>();
process.on("exit", () => {
  for (const d of pendingTempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});
function trackedTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  pendingTempDirs.add(dir);
  return dir;
}
function releaseTmp(dir: string): void {
  pendingTempDirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

export interface GraphLoad {
  graph: RippleGraph;
  status: "hit" | "miss";
  reason?: string;
  fingerprint: RepoFingerprint;
  /** Wall time for the SCIP index + graph build (miss) or load (hit). */
  loadMs: number;
  /** Wall time spent hashing the repository for the fingerprint. */
  fingerprintMs: number;
  /** Files AST-classified this run (0 on cache hit). */
  enrichedFiles: number;
}

/**
 * Optional progress sink for CLI status output. Called with a phase name
 * at phase start, then again with timing once the phase finishes.
 * Observation only — never throws, never changes results.
 */
export type PhaseFn = (phase: string, done?: { ms: number; cached?: boolean }) => void;

/**
 * Load the normalized graph for a repository's current working state,
 * reusing the content-addressed cache when the fingerprint matches.
 * A miss runs scip-typescript into a temp file and stores
 * index+graph+metadata atomically.
 */
export async function getGraphForRepo(repo: string, onPhase?: PhaseFn): Promise<GraphLoad> {
  const cache = new RippleCache(repo);
  onPhase?.("fingerprint");
  const tFp = performance.now();
  const fp = repoFingerprint(repo);
  const fingerprintMs = performance.now() - tFp;
  onPhase?.("fingerprint", { ms: fingerprintMs });

  const t0 = performance.now();
  const hit = cache.load(fp);
  if (hit.status === "hit" && hit.graph) {
    const loadMs = performance.now() - t0;
    onPhase?.("index", { ms: loadMs, cached: true });
    return {
      graph: hit.graph,
      status: "hit",
      fingerprint: fp,
      loadMs,
      fingerprintMs,
      enrichedFiles: 0,
    };
  }

  onPhase?.("index");

  // Miss: index into a temp file so a partial scip run can never poison
  // the cache, then store index+graph+metadata atomically.
  const tmp = trackedTmp("ripple-index-");
  const indexPath = join(tmp, "index.scip");
  const stats: { enrichedFiles?: number } = {};
  try {
    const graph = await new ScipIndexer().index({
      root: repo,
      outputPath: indexPath,
      statsOut: stats,
      enrichCacheDir: join(cache.dir, "enrich"),
    });
    cache.store(fp, {
      indexBytes: readFileSync(indexPath),
      graph,
      revision: "worktree",
    });
    const loadMs = performance.now() - t0;
    onPhase?.("index", { ms: loadMs, cached: false });
    return {
      graph,
      status: "miss",
      reason: hit.reason,
      fingerprint: fp,
      loadMs,
      fingerprintMs,
      enrichedFiles: stats.enrichedFiles ?? 0,
    };
  } finally {
    releaseTmp(tmp);
  }
}

export interface RevGraphLoad extends GraphLoad {
  /** Temp worktree path — caller must clean up via cleanupWorktree. */
  worktreeDir?: string;
}

/**
 * Load the graph for a COMMITTED revision. Commit SHAs are immutable, so
 * the fingerprint is the SHA itself — the base graph for `main~3` is
 * computed once, ever.
 *
 * Isolation: materializes the revision in a temporary `git worktree` —
 * never a checkout — so the user's working tree is untouched.
 */
export async function getGraphForRevision(
  repo: string,
  rev: string,
  execGit: (args: string[]) => string,
): Promise<RevGraphLoad> {
  const sha = execGit(["rev-parse", "--verify", rev]).trim();
  const fp = commitFingerprint(sha);
  const cache = new RippleCache(repo);

  const t0 = performance.now();
  const hit = cache.load(fp);
  if (hit.status === "hit" && hit.graph) {
    return {
      graph: hit.graph,
      status: "hit",
      fingerprint: fp,
      loadMs: performance.now() - t0,
      fingerprintMs: 0,
      enrichedFiles: 0,
    };
  }

  const worktree = trackedTmp("ripple-base-");
  const tmp = trackedTmp("ripple-index-");
  try {
    execGit(["worktree", "add", "--detach", worktree, sha]);
    const indexPath = join(tmp, "index.scip");
    const stats: { enrichedFiles?: number } = {};
    const graph = await new ScipIndexer().index({
      root: worktree,
      outputPath: indexPath,
      statsOut: stats,
      enrichCacheDir: join(cache.dir, "enrich"),
    });
    cache.store(fp, {
      indexBytes: readFileSync(indexPath),
      graph,
      revision: `commit ${sha}`,
    });
    return {
      graph,
      status: "miss",
      reason: hit.reason,
      fingerprint: fp,
      loadMs: performance.now() - t0,
      fingerprintMs: 0,
      enrichedFiles: stats.enrichedFiles ?? 0,
      worktreeDir: worktree,
    };
  } catch (err) {
    cleanupWorktree(repo, worktree, execGit);
    throw err;
  } finally {
    releaseTmp(tmp);
  }
}

export function cleanupWorktree(
  repo: string,
  worktreeDir: string,
  execGit: (args: string[]) => string,
): void {
  pendingTempDirs.delete(worktreeDir);
  try {
    execGit(["worktree", "remove", "--force", worktreeDir]);
  } catch {
    rmSync(worktreeDir, { recursive: true, force: true });
  }
  // drop admin entries for any worktrees orphaned by a hard kill
  try {
    execGit(["worktree", "prune"]);
  } catch {
    /* best-effort */
  }
}
