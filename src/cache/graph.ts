import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RippleGraph } from "../graph/graph.js";
import { mergeGraphs, type GraphFragment } from "../graph/merge.js";
import { planForRepo, type RepoIndexPlan } from "../indexers/registry.js";
import type { DetectedProject } from "../indexers/adapter.js";
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
  /** Wall time for the index + graph build (miss) or load (hit). */
  loadMs: number;
  /** Wall time spent hashing the repository for the fingerprint. */
  fingerprintMs: number;
  /** Files AST-classified this run (0 on cache hit). */
  enrichedFiles: number;
  /** The detected language projects this graph was built from. */
  projects: DetectedProject[];
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
  const plan = planForRepo(repo);
  if (!plan) {
    throw new Error(
      `Ripple found no supported language project under ${repo} ` +
        `(no adapter claimed it — supported today: TypeScript/JavaScript)`,
    );
  }
  const cache = new RippleCache(repo);
  onPhase?.("fingerprint");
  const tFp = performance.now();
  const fp = repoFingerprint(repo, { files: plan.files, adapters: plan.adapters });
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
      projects: plan.projects,
    };
  }

  onPhase?.("index");
  const tIndex = performance.now();
  const built = await indexProjects(repo, plan, cache);
  const loadMs = performance.now() - t0;
  onPhase?.("index", { ms: performance.now() - tIndex, cached: false });
  cache.store(fp, {
    indexBytes: built.indexBytes,
    graph: built.graph,
    revision: "worktree",
  });
  return {
    graph: built.graph,
    status: "miss",
    reason: hit.reason,
    fingerprint: fp,
    loadMs,
    fingerprintMs,
    enrichedFiles: built.enrichedFiles,
    projects: plan.projects,
  };
}

/**
 * Index every detected project with its adapter and merge the fragments
 * into one repo graph. Index artifacts go to a temp dir so a partial
 * run can never poison the cache. Single-project repos take the same
 * path — provenance is uniform.
 */
async function indexProjects(
  repo: string,
  plan: RepoIndexPlan,
  cache: RippleCache,
): Promise<{ graph: RippleGraph; indexBytes: Uint8Array; enrichedFiles: number }> {
  const fragments: GraphFragment[] = [];
  let indexBytes = new Uint8Array(0);
  let enrichedFiles = 0;
  const stats: { enrichedFiles?: number } = {};
  for (const project of plan.projects) {
    const tmp = trackedTmp("ripple-index-");
    const indexPath = join(tmp, "index.scip");
    try {
      const graph = await project.adapter.index({
        root: join(repo, project.root),
        outputPath: indexPath,
        statsOut: stats,
        // Per-adapter enrich cache — adapters can never collide.
        enrichCacheDir: join(cache.dir, "enrich", project.adapter.id),
      });
      if (plan.projects.length === 1) indexBytes = readFileSync(indexPath);
      fragments.push({
        projectId: project.projectId,
        adapterId: project.adapter.id,
        projectRoot: project.root,
        graph,
      });
    } finally {
      releaseTmp(tmp);
    }
  }
  enrichedFiles = stats.enrichedFiles ?? 0;
  return { graph: mergeGraphs(repo, fragments), indexBytes, enrichedFiles };
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
  const cache = new RippleCache(repo);
  const plan = planForRepo(repo);
  if (!plan) {
    throw new Error(
      `Ripple found no supported language project under ${repo} ` +
        `(no adapter claimed it — supported today: TypeScript/JavaScript)`,
    );
  }
  const fp = commitFingerprint(sha, { adapters: plan.adapters });

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
      projects: plan.projects,
    };
  }

  const worktree = trackedTmp("ripple-base-");
  try {
    execGit(["worktree", "add", "--detach", worktree, sha]);
    const built = await indexProjects(worktree, plan, cache);
    cache.store(fp, {
      indexBytes: built.indexBytes,
      graph: built.graph,
      revision: `commit ${sha}`,
    });
    return {
      graph: built.graph,
      status: "miss",
      reason: hit.reason,
      fingerprint: fp,
      loadMs: performance.now() - t0,
      fingerprintMs: 0,
      enrichedFiles: built.enrichedFiles,
      worktreeDir: worktree,
      projects: plan.projects,
    };
  } catch (err) {
    cleanupWorktree(repo, worktree, execGit);
    throw err;
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
