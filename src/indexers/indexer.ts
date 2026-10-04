import type { RippleGraph } from "../graph/graph.js";

export interface IndexOptions {
  /** Project root to index. */
  root: string;
  /** Use a pre-generated index instead of running the indexer. */
  indexPath?: string;
  /** Where to write the raw index (defaults to <root>/index.scip). */
  outputPath?: string;
  /** Optional sink for enrichment stats (files AST-classified). */
  statsOut?: { enrichedFiles?: number };
  /** Directory for the content-addressed per-file enrichment cache. */
  enrichCacheDir?: string;
}

export interface Indexer {
  index(options: IndexOptions): Promise<RippleGraph>;
}
