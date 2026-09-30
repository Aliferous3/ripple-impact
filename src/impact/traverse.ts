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
  /** Node ids from the changed symbol to this node, inclusive. */
  path: string[];
  /** The edges traversed, in order from changed → this node. */
  edges: GraphEdge[];
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
 * Reverse impact traversal: who could be affected if `symbols` change.
 * Breadth-first over reversed calls/implements edges; visited set makes it
 * terminating on cycles. First-discovered path is kept as the explanation.
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

  const affected = new Map<string, AffectedNode>();
  let frontier = changed.map((node) => ({
    node,
    depth: 0,
    path: [node.id],
    edges: [] as GraphEdge[],
  }));
  const visited = new Set(changed.map((n) => n.id));

  while (frontier.length > 0) {
    const next: AffectedNode[] = [];
    for (const current of frontier) {
      const incoming = graph.inEdges(current.node.id, [...IMPACT_EDGE_KINDS]);
      // Interface dispatch: if node X implements method Y, a caller typed to Y
      // resolves its call edge to Y — but at runtime it may dispatch to X.
      // Deterministically widen: predecessors of X also include callers of
      // every symbol X implements.
      for (const impl of graph.outEdges(current.node.id, ["implements"])) {
        incoming.push(...graph.inEdges(impl.to, ["calls"]));
      }
      for (const edge of incoming) {
        if (visited.has(edge.from)) continue;
        visited.add(edge.from);
        const pred = graph.node(edge.from);
        if (!pred) continue;
        const entry: AffectedNode = {
          node: pred,
          depth: current.depth + 1,
          path: [...current.path, pred.id],
          edges: [...current.edges, edge],
        };
        affected.set(pred.id, entry);
        next.push(entry);
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
