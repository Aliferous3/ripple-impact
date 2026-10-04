import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RippleGraph } from "../graph/graph.js";
import { ScipIndexer } from "../indexers/scip/scip-indexer.js";
import { commitFingerprint, repoFingerprint, type RepoFingerprint } from "./fingerprint.js";
import { RippleCache } from "./store.js";

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
 * Load the normalized graph for a repository's current working state,
 * reusing the content-addressed cache when the fingerprint matches.
 * A miss runs scip-typescript into a temp file and stores
 * index+graph+metadata atomically.
 */
export async function getGraphForRepo(repo: string): Promise<GraphLoad> {
  const cache = new RippleCache(repo);
  const tFp = performance.now();
  const fp = repoFingerprint(repo);
  const fingerprintMs = performance.now() - tFp;

  const t0 = performance.now();
  const hit = cache.load(fp);
  if (hit.status === "hit" && hit.graph) {
    return {
      graph: hit.graph,
      status: "hit",
      fingerprint: fp,
      loadMs: performance.now() - t0,
      fingerprintMs,
      enrichedFiles: 0,
    };
  }

  // Miss: index into a temp file so a partial scip run can never poison
  // the cache, then store index+graph+metadata atomically.
  const tmp = mkdtempSync(join(tmpdir(), "ripple-index-"));
  const indexPath = join(tmp, "index.scip");
  const stats: { enrichedFiles?: number } = {};
  try {
    const graph = await new ScipIndexer().index({
      root: repo,
      outputPath: indexPath,
      statsOut: stats,
    });
    cache.store(fp, {
      indexBytes: readFileSync(indexPath),
      graph,
      revision: "worktree",
    });
    return {
      graph,
      status: "miss",
      reason: hit.reason,
      fingerprint: fp,
      loadMs: performance.now() - t0,
      fingerprintMs,
      enrichedFiles: stats.enrichedFiles ?? 0,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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

  const worktree = mkdtempSync(join(tmpdir(), "ripple-base-"));
  const tmp = mkdtempSync(join(tmpdir(), "ripple-index-"));
  try {
    execGit(["worktree", "add", "--detach", worktree, sha]);
    const indexPath = join(tmp, "index.scip");
    const stats: { enrichedFiles?: number } = {};
    const graph = await new ScipIndexer().index({
      root: worktree,
      outputPath: indexPath,
      statsOut: stats,
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
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function cleanupWorktree(
  repo: string,
  worktreeDir: string,
  execGit: (args: string[]) => string,
): void {
  try {
    execGit(["worktree", "remove", "--force", worktreeDir]);
  } catch {
    rmSync(worktreeDir, { recursive: true, force: true });
  }
}
