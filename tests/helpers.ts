import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ScipIndexer } from "../src/indexers/scip/scip-indexer.js";
import type { RippleGraph } from "../src/graph/graph.js";

const graphCache = new Map<string, RippleGraph>();

export async function fixtureGraph(name: string): Promise<RippleGraph> {
  const cached = graphCache.get(name);
  if (cached) return cached;
  const dir = resolve("fixtures", name);
  const indexPath = join(dir, "index.scip");
  const indexer = new ScipIndexer();
  // Reuse the checked-in/generated index when present; otherwise index now.
  const graph = existsSync(indexPath)
    ? await indexer.index({ root: dir, indexPath })
    : await indexer.index({ root: dir });
  graphCache.set(name, graph);
  return graph;
}
