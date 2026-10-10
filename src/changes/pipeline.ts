import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { RippleGraph } from "../graph/graph.js";
import type { GraphNode } from "../graph/types.js";
import { impactNodes, type ImpactResult } from "../impact/traverse.js";
import { GitDiffProvider } from "../git/provider.js";
import type { GitDiff } from "../git/types.js";
import { mapDiffToChangedSymbols } from "./map.js";
import type { ChangeSet } from "./types.js";
import { cleanupWorktree, getGraphForRepo, getGraphForRevision, type PhaseFn } from "../cache/graph.js";
import { repoFilePaths } from "../cache/fingerprint.js";
import type { DetectedProject } from "../indexers/adapter.js";
import { join } from "node:path";

export interface DiffImpactTimings {
  gitDiffMs: number;
  /** Current-revision index+graph load (hit = deserialize, miss = scip). */
  indexMs: number;
  mapMs: number;
  traverseMs: number;
  /** Base worktree index+graph (only when deletions required it). */
  baseIndexMs?: number;
  fingerprintMs: number;
}

export interface CacheReport {
  index: "hit" | "miss";
  graph: "hit" | "miss";
  baseGraph: "hit" | "miss" | "not-required";
  enrichedFiles: number;
  missReason?: string;
}

export interface DeletedSymbolImpact {
  name: string;
  file: string;
  /** Callers of the deleted symbol *in the base revision graph*. */
  callers: GraphNode[];
  /** Whether callers were resolved against a real base graph. */
  resolved: boolean;
}

export interface AnalysisWarning {
  code:
    | "NOT_INDEXED"
    | "DELETED_SYMBOL_APPROXIMATED"
    | "AMBIGUOUS_SYMBOL"
    | "BINARY_SKIPPED"
    | "BASE_GRAPH_UNAVAILABLE"
    | "TEST_FILES_OUTSIDE_INDEX_SCOPE";
  message: string;
  file?: string;
  symbol?: string;
  /** Full list when a warning covers multiple files (e.g. unindexed tests). */
  files?: string[];
}

export interface DiffImpactResult {
  diff: GitDiff;
  graph: RippleGraph;
  fingerprint: string;
  changeSet: ChangeSet;
  impact: ImpactResult;
  deletedImpact: DeletedSymbolImpact[];
  warnings: AnalysisWarning[];
  timings: DiffImpactTimings;
  cache: CacheReport;
}

export interface DiffImpactOptions {
  repo: string;
  base?: string;
  /** Optional progress sink — see PhaseFn in cache/graph.ts. */
  onPhase?: PhaseFn;
}

const gitAt = (repo: string) => (args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

export async function diffImpact(opts: DiffImpactOptions): Promise<DiffImpactResult> {
  const repo = resolve(opts.repo);
  const provider = new GitDiffProvider(repo);
  const warnings: AnalysisWarning[] = [];
  const timings: DiffImpactTimings = {
    gitDiffMs: 0,
    indexMs: 0,
    mapMs: 0,
    traverseMs: 0,
    fingerprintMs: 0,
  };

  let t0 = performance.now();
  opts.onPhase?.("diff");
  const diff = provider.getDiff({ repo, base: opts.base });
  timings.gitDiffMs = performance.now() - t0;
  opts.onPhase?.("diff", { ms: timings.gitDiffMs });

  t0 = performance.now();
  const load = await getGraphForRepo(repo, opts.onPhase);
  timings.indexMs = load.loadMs;
  timings.fingerprintMs = load.fingerprintMs;

  t0 = performance.now();
  opts.onPhase?.("map");
  const changeSet = mapDiffToChangedSymbols(load.graph, diff, provider);
  timings.mapMs = performance.now() - t0;
  opts.onPhase?.("map", { ms: timings.mapMs });

  // Type-only module edits (import type / export type) seed the type BFS
  // only — they never propagate runtime impact to importers.
  const changedNodes = changeSet.changed
    .filter((c) => c.node !== undefined && !c.typeOnly)
    .map((c) => c.node!);
  const typeOnlyNodes = changeSet.changed
    .filter((c) => c.node !== undefined && c.typeOnly)
    .map((c) => c.node!);

  t0 = performance.now();
  opts.onPhase?.("traverse");
  const impact = impactNodes(load.graph, changedNodes, typeOnlyNodes);
  timings.traverseMs = performance.now() - t0;
  opts.onPhase?.("traverse", { ms: timings.traverseMs });

  for (const u of changeSet.unmappedFiles) {
    warnings.push({
      code: u.reason === "binary" ? "BINARY_SKIPPED" : "NOT_INDEXED",
      message: `${u.file} changed but is not part of the indexed graph (${u.reason})`,
      file: u.file,
    });
  }

  // Test-scope visibility: obvious test files the index never saw (excluded
  // by tsconfig include, unindexed .mjs suites, etc.) mean "Relevant tests"
  // silently under-reports. Surface that honestly — never claim relevance.
  const outsideTestFiles = testFilesOutsideIndex(repo, load.graph, load.projects);
  if (outsideTestFiles.length > 0) {
    const shown = outsideTestFiles.slice(0, 5);
    warnings.push({
      code: "TEST_FILES_OUTSIDE_INDEX_SCOPE",
      message:
        `${outsideTestFiles.length} test file(s) exist outside the indexed scope — ` +
        `relevant-test analysis may be incomplete: ${shown.join(", ")}` +
        (outsideTestFiles.length > shown.length
          ? `, +${outsideTestFiles.length - shown.length} more`
          : ""),
      files: outsideTestFiles,
    });
  }

  // Deleted symbols: automatically obtain the base-revision graph so their
  // former callers get real (evidence-backed) impact, not guesses.
  const deleted = changeSet.changed.filter((c) => c.changeKind === "deleted");
  const deletedImpact: DeletedSymbolImpact[] = [];
  let baseGraphStatus: CacheReport["baseGraph"] = "not-required";

  if (deleted.length > 0) {
    t0 = performance.now();
    opts.onPhase?.("base-graph");
    try {
      const execGit = gitAt(repo);
      const base = await getGraphForRevision(repo, diff.oldRev, execGit);
      try {
        for (const d of deleted) {
          const matches = base.graph.findByName(d.name);
          if (matches.length === 0) {
            warnings.push({
              code: "DELETED_SYMBOL_APPROXIMATED",
              message: `${d.name} was deleted but could not be located in the base-revision graph — former callers unknown`,
              file: d.file,
              symbol: d.name,
            });
          }
          const baseImpact = impactNodes(base.graph, matches);
          // Former dependents: runtime callers + type consumers of the
          // deleted symbol, resolved against the base graph.
          const callers = [
            ...baseImpact.direct,
            ...baseImpact.transitive,
            ...baseImpact.typeDirect,
            ...baseImpact.typeTransitive,
          ].map((a) => a.node);
          deletedImpact.push({
            name: d.name,
            file: d.file,
            callers,
            resolved: matches.length > 0,
          });
        }
      } finally {
        if (base.worktreeDir) cleanupWorktree(repo, base.worktreeDir, execGit);
      }
      baseGraphStatus = base.status;
    } catch (err) {
      baseGraphStatus = "not-required";
      for (const d of deleted) {
        deletedImpact.push({ name: d.name, file: d.file, callers: [], resolved: false });
        warnings.push({
          code: "BASE_GRAPH_UNAVAILABLE",
          message: `could not index base revision ${diff.oldRev}: ${(err as Error).message}`,
          symbol: d.name,
        });
      }
    }
    timings.baseIndexMs = performance.now() - t0;
    opts.onPhase?.("base-graph", { ms: timings.baseIndexMs });
  }

  return {
    diff,
    graph: load.graph,
    fingerprint: load.fingerprint.key,
    changeSet,
    impact,
    deletedImpact,
    warnings,
    timings,
    cache: {
      index: load.status,
      graph: load.status,
      baseGraph: baseGraphStatus,
      enrichedFiles: load.enrichedFiles,
      missReason: load.reason,
    },
  };
}

/**
 * Conventional test-file paths the index never produced nodes for, per
 * the detected adapters' own test-file rules. Deterministic
 * conventions only — a file counts as "outside scope" when no graph
 * node is attributed to it.
 */
function testFilesOutsideIndex(
  repo: string,
  graph: RippleGraph,
  projects: DetectedProject[],
): string[] {
  const indexedFiles = new Set(
    graph.nodes.map((n) => n.file.replace(/\\/g, "/")),
  );
  const claimed = new Set<string>();
  for (const p of projects) {
    for (const f of repoFilePaths(join(repo, p.root), p.adapter.files)) {
      claimed.add(p.root === "" ? f : `${p.root}/${f}`);
    }
  }
  return [...claimed].filter((p) => {
    if (indexedFiles.has(p)) return false;
    return projects.some((pr) => pr.adapter.files.testFile(p));
  });
}
