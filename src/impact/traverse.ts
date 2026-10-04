import { RippleGraph } from "../graph/graph.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";

/** Edge kinds along which a change propagates upstream (changed → affected). */
export const IMPACT_EDGE_KINDS = ["calls", "implements"] as const;
/** Edge kinds recorded as "references" only — never conflated with calls. */
export const REFERENCE_EDGE_KINDS = ["references", "imports"] as const;

export interface AffectedNode {
  node: GraphNode;
  /** 0 = the changed node itself; 1 = direct caller; >=2 = transitive. */
  depth: number;
  /** Node ids from a changed symbol to this node, inclusive (first found). */
  path: string[];
  /** The edges traversed, in order from changed → this node (first found). */
  edges: GraphEdge[];
  /** Ids of every changed root that reaches this node. */
  roots: string[];
  /** One witness path per contributing root (root id → path + edges). */
  pathsByRoot: Record<string, { path: string[]; edges: GraphEdge[] }>;
}

export interface ImpactResult {
  changed: GraphNode[];
  /** depth === 1 */
  direct: AffectedNode[];
  /** depth >= 2, sorted by depth then name */
  transitive: AffectedNode[];
  /**
   * Nodes that reference/import a changed or affected symbol but do NOT call
   * (or implement) it. Reported separately: a reference is evidence of a
   * coupling, not proof of behavioural impact.
   */
  referencing: { node: GraphNode; edge: GraphEdge }[];
  /** Test files whose code calls or references a changed/affected symbol. */
  relevantTests: { file: string; via: { node: GraphNode; edge: GraphEdge }[] }[];
}

/**
 * Which reversed edge kinds propagate impact out of `node`.
 * File/module nodes additionally propagate over `imports` in-edges: a change
 * to module-scope code (imports, top-level statements) can affect importers.
 */
function impactKindsFor(node: GraphNode): string[] {
  return node.kind === "file" || node.kind === "test"
    ? [...IMPACT_EDGE_KINDS, "imports"]
    : [...IMPACT_EDGE_KINDS];
}

/**
 * Reverse impact traversal: who could be affected if `changedNodes` change.
 * BFS over reversed calls/implements edges (+ imports out of file nodes);
 * minimum-depth visit makes it terminating on cycles. With multiple roots,
 * each affected node records every root that reached it plus one witness
 * path per root — provenance is preserved, nodes are deduplicated.
 */
export function impactNodes(graph: RippleGraph, changedNodes: GraphNode[]): ImpactResult {
  const changed = [...changedNodes];
  const affected = new Map<string, AffectedNode>();
  const minDepth = new Map<string, number>(changed.map((n) => [n.id, 0]));
  const enqueued = new Set(changed.map((n) => `${n.id}\n${n.id}`));

  let frontier = changed.map((node) => ({
    node,
    depth: 0,
    seed: node.id,
    path: [node.id],
    edges: [] as GraphEdge[],
  }));

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const current of frontier) {
      const incoming = graph.inEdges(current.node.id, [...IMPACT_EDGE_KINDS]);
      // Interface dispatch: if node X implements method Y, a caller typed to Y
      // resolves its call edge to Y — but at runtime it may dispatch to X.
      // Deterministically widen: predecessors of X also include callers of
      // every symbol X implements.
      for (const impl of graph.outEdges(current.node.id, ["implements"])) {
        incoming.push(...graph.inEdges(impl.to, ["calls"]));
      }
      // File nodes: a module-scope change can affect importers.
      if (current.node.kind === "file" || current.node.kind === "test") {
        incoming.push(...graph.inEdges(current.node.id, ["imports"]));
      }
      for (const edge of incoming) {
        if (edge.from === current.node.id) continue;
        const depth = current.depth + 1;
        const path = [...current.path, edge.from];
        const edges = [...current.edges, edge];
        const known = minDepth.get(edge.from);
        if (known !== undefined && known < depth) continue;
        const pred = graph.node(edge.from);
        if (!pred) continue;
        if (known === undefined) minDepth.set(edge.from, depth);
        let entry = affected.get(edge.from);
        if (!entry) {
          entry = {
            node: pred,
            depth,
            path,
            edges,
            roots: [],
            pathsByRoot: {},
          };
          affected.set(edge.from, entry);
        }
        // Record provenance for this root (one witness path per root).
        if (!entry.pathsByRoot[current.seed]) {
          entry.pathsByRoot[current.seed] = { path, edges };
          entry.roots.push(current.seed);
        }
        // Enqueue once per (node, root) so provenance propagates fully.
        const key = `${edge.from}\n${current.seed}`;
        if (!enqueued.has(key)) {
          enqueued.add(key);
          next.push({ node: pred, depth, seed: current.seed, path, edges });
        }
      }
    }
    frontier = next;
  }

  const relevant = new Set<string>([...changed.map((n) => n.id), ...affected.keys()]);

  const referencing: ImpactResult["referencing"] = [];
  const seenRef = new Set<string>();
  for (const id of relevant) {
    for (const edge of graph.inEdges(id, [...REFERENCE_EDGE_KINDS])) {
      if (relevant.has(edge.from) || seenRef.has(edge.from)) continue;
      const pred = graph.node(edge.from);
      if (!pred) continue;
      seenRef.add(edge.from);
      referencing.push({ node: pred, edge });
    }
  }

  // Tests: a test node is relevant when it calls or references a symbol in the
  // affected set (or the changed symbol itself). This is a *reachability*
  // claim only — we do not claim semantic coverage.
  const testEdges = new Map<string, { node: GraphNode; edge: GraphEdge }[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "test") continue;
    for (const edge of graph.outEdges(node.id)) {
      if (edge.kind === "contains") continue;
      if (!relevant.has(edge.to)) continue;
      const list = testEdges.get(node.file) ?? [];
      list.push({ node, edge });
      testEdges.set(node.file, list);
    }
  }
  const relevantTests = [...testEdges.entries()]
    .map(([file, via]) => ({ file, via }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return {
    changed,
    direct: [...affected.values()].filter((a) => a.depth === 1),
    transitive: [...affected.values()]
      .filter((a) => a.depth >= 2)
      .sort((a, b) => a.depth - b.depth || a.node.name.localeCompare(b.node.name)),
    referencing,
    relevantTests,
  };
}

/**
 * Name-based entry point (Tranche 0 CLI/tests): resolves symbol names to
 * nodes then runs the same traversal.
 */
export function impact(
  graph: RippleGraph,
  symbolNames: string[],
  fileHint?: string,
): ImpactResult {
  const changed: GraphNode[] = [];
  for (const name of symbolNames) {
    let matches = graph.findByName(name);
    if (fileHint) {
      const filtered = matches.filter((m) =>
        m.file.replace(/\\/g, "/").includes(fileHint),
      );
      if (filtered.length > 0) matches = filtered;
    }
    if (matches.length === 0) {
      throw new Error(`No symbol found matching "${name}"`);
    }
    if (matches.length > 1) {
      const names = matches.map((m) => `${m.name} (${m.file})`).join(", ");
      throw new Error(`Ambiguous symbol "${name}": ${names}`);
    }
    changed.push(matches[0]);
  }
  return impactNodes(graph, changed);
}
