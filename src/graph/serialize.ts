import type { GraphEdge, GraphNode, RippleGraphData } from "./types.js";

/**
 * Persisted Ripple graph artifact.
 * Bumped on any incompatible change to node/edge/evidence shape — old
 * artifacts are invalidated, never silently reinterpreted.
 */
export const GRAPH_SCHEMA_VERSION = 1;

export interface SerializedGraph {
  schemaVersion: number;
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function serializeGraph(
  root: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): SerializedGraph {
  return { schemaVersion: GRAPH_SCHEMA_VERSION, root, nodes, edges };
}

/**
 * Validates and returns the graph payload, or throws CacheInvalidError.
 * Callers treat a throw as "rebuild" — never as a crash.
 */
export class InvalidGraphArtifact extends Error {}

export function validateGraphArtifact(raw: unknown): SerializedGraph {
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidGraphArtifact("graph artifact is not an object");
  }
  const g = raw as Partial<SerializedGraph>;
  if (g.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new InvalidGraphArtifact(
      `schema version ${String(g.schemaVersion)} !== ${GRAPH_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges) || typeof g.root !== "string") {
    throw new InvalidGraphArtifact("graph artifact missing nodes/edges/root");
  }
  for (const n of g.nodes) {
    if (!n || typeof n.id !== "string" || typeof n.kind !== "string" || typeof n.file !== "string") {
      throw new InvalidGraphArtifact("malformed node in graph artifact");
    }
  }
  for (const e of g.edges) {
    if (
      !e ||
      typeof e.from !== "string" ||
      typeof e.to !== "string" ||
      typeof e.kind !== "string" ||
      !Array.isArray(e.evidence)
    ) {
      throw new InvalidGraphArtifact("malformed edge in graph artifact");
    }
  }
  return g as SerializedGraph;
}
