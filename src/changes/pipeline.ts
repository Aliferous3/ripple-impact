import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RippleGraph } from "../graph/graph.js";
import type { GraphNode } from "../graph/types.js";
import { ScipIndexer } from "../indexers/scip/scip-indexer.js";
import { impactNodes, type ImpactResult } from "../impact/traverse.js";
import { GitDiffProvider } from "../git/provider.js";
import type { GitDiff } from "../git/types.js";
import { mapDiffToChangedSymbols } from "./map.js";
import type { ChangeSet } from "./types.js";

export interface DiffImpactTimings {
  gitDiffMs: number;
  indexMs: number;
  mapMs: number;
  traverseMs: number;
  baseIndexMs?: number;
}

export interface DeletedSymbolImpact {
  name: string;
  file: string;
  /** Callers of the deleted symbol *in the base revision graph*. */
  callers: GraphNode[];
}

export interface DiffImpactResult {
  diff: GitDiff;
  graph: RippleGraph;
  changeSet: ChangeSet;
  impact: ImpactResult;
  deletedImpact: DeletedSymbolImpact[];
  timings: DiffImpactTimings;
}

export interface DiffImpactOptions {
  repo: string;
  base?: string;
  /**
   * When true, materialize the base revision in a `git worktree`, index it,
   * and resolve deleted symbols' former callers in that graph. Costs one
   * extra scip-typescript run; gives deleted functions real downstream
   * impact instead of tombstones-without-callers.
   */
  baseGraph?: boolean;
}

export async function diffImpact(opts: DiffImpactOptions): Promise<DiffImpactResult> {
  const repo = resolve(opts.repo);
  const provider = new GitDiffProvider(repo);
  const timings: DiffImpactTimings = {
    gitDiffMs: 0,
    indexMs: 0,
    mapMs: 0,
    traverseMs: 0,
  };

  let t0 = performance.now();
  const diff = provider.getDiff({ repo, base: opts.base });
  timings.gitDiffMs = performance.now() - t0;

  t0 = performance.now();
  const graph = await new ScipIndexer().index({ root: repo });
  timings.indexMs = performance.now() - t0;

  t0 = performance.now();
  const changeSet = mapDiffToChangedSymbols(graph, diff, provider);
  timings.mapMs = performance.now() - t0;

  const changedNodes = changeSet.changed
    .filter((c) => c.node !== undefined)
    .map((c) => c.node!);

  t0 = performance.now();
  const impact = impactNodes(graph, changedNodes);
  timings.traverseMs = performance.now() - t0;

  const deleted = changeSet.changed.filter((c) => c.changeKind === "deleted");
  const deletedImpact: DeletedSymbolImpact[] = [];

  if (deleted.length > 0 && opts.baseGraph) {
    // Option A from the tranche: index the base revision and ask its graph
    // who used to call the deleted symbols.
    t0 = performance.now();
    const worktree = mkdtempSync(join(tmpdir(), "ripple-base-"));
    try {
      execFileSync("git", ["-C", repo, "worktree", "add", "--detach", worktree, diff.oldRev], {
        stdio: "pipe",
        windowsHide: true,
      });
      const baseGraph = await new ScipIndexer().index({ root: worktree });
      for (const d of deleted) {
        const matches = baseGraph.findByName(d.name);
        const base = impactNodes(baseGraph, matches);
        const callers = [...base.direct, ...base.transitive].map((a) => a.node);
        deletedImpact.push({ name: d.name, file: d.file, callers });
      }
    } finally {
      try {
        execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], {
          stdio: "pipe",
          windowsHide: true,
        });
      } catch {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
    timings.baseIndexMs = performance.now() - t0;
  } else {
    for (const d of deleted) {
      deletedImpact.push({ name: d.name, file: d.file, callers: [] });
    }
  }

  return { diff, graph, changeSet, impact, deletedImpact, timings };
}
