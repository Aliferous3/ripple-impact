import { RippleGraph } from "../graph/graph.js";
import type { EdgeKind, GraphEdge, GraphNode } from "../graph/types.js";

/** Edge kinds along which a change propagates upstream (changed → affected). */
export const IMPACT_EDGE_KINDS = ["calls", "implements"] as const;
/** Edge kinds along which only type impact propagates — never runtime. */
export const TYPE_EDGE_KINDS = ["type_depends"] as const;
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
  /**
   * depth === 1, reached purely via type_depends edges — "type-affected".
   * Excludes anything already in `direct`/`transitive` (runtime wins).
   */
  typeDirect: AffectedNode[];
  /** depth >= 2 type-affected, sorted by depth then name. */
  typeTransitive: AffectedNode[];
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

interface BfsSeed {
  node: GraphNode;
  depth: number;
  seed: string;
  path: string[];
  edges: GraphEdge[];
}

/**
 * One reverse BFS over the given edge kinds. `widen` optionally adds extra
 * incoming edges per node (interface dispatch, file→importers).
 */
function bfsAffected(
  graph: RippleGraph,
  seeds: BfsSeed[],
  kinds: EdgeKind[],
  widen?: (graph: RippleGraph, node: GraphNode, incoming: GraphEdge[]) => void,
): Map<string, AffectedNode> {
  const affected = new Map<string, AffectedNode>();
  const minDepth = new Map<string, number>(seeds.map((s) => [s.node.id, s.depth]));
  const enqueued = new Set(seeds.map((s) => `${s.node.id}\n${s.seed}`));

  let frontier = seeds;

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const current of frontier) {
      const incoming = graph.inEdges(current.node.id, kinds);
      widen?.(graph, current.node, incoming);
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
  return affected;
}

/**
 * Reverse impact traversal: who could be affected if `changedNodes` change.
 * Two BFS passes keep the runtime/type distinction hard:
 *
 *   runtime  — calls/implements (+ imports out of file nodes), plus the
 *              interface-dispatch widening. Behavioural impact.
 *   type     — type_depends edges only. A bare `import type` creates no
 *              edge, so nothing propagates without real type usage.
 *
 * A node reachable via both lands in the runtime set only — the stronger
 * claim wins; type impact is reported for what runtime did not explain.
 */
export function impactNodes(graph: RippleGraph, changedNodes: GraphNode[]): ImpactResult {
  const changed = [...changedNodes];
  const seeds = (node: GraphNode): BfsSeed => ({
    node,
    depth: 0,
    seed: node.id,
    path: [node.id],
    edges: [],
  });

  const affected = bfsAffected(
    graph,
    changed.map(seeds),
    [...IMPACT_EDGE_KINDS],
    (g, node, incoming) => {
      // Interface dispatch: if node X implements method Y, a caller typed to Y
      // resolves its call edge to Y — but at runtime it may dispatch to X.
      // Deterministically widen: predecessors of X also include callers of
      // every symbol X implements.
      for (const impl of g.outEdges(node.id, ["implements"])) {
        incoming.push(...g.inEdges(impl.to, ["calls"]));
      }
      // File nodes: a module-scope change can affect importers.
      if (node.kind === "file" || node.kind === "test") {
        incoming.push(...g.inEdges(node.id, ["imports"]));
      }
    },
  );

  // Type seeds additionally include `interface` ancestors of changed members:
  // adding/modifying/removing an interface member IS a change to the
  // interface's shape, so consumers of `User` are type-affected when
  // `User#email` changes. Deliberately NOT class ancestors — a method-body
  // change inside a class does not alter the class's declared shape, and
  // claiming otherwise would implicate every `x: C` consumer. The runtime
  // BFS never sees ancestor seeds.
  const typeSeeds: BfsSeed[] = changed.map(seeds);
  for (const n of changed) {
    let cur = n.id;
    const path = [n.id];
    const edges: GraphEdge[] = [];
    const seen = new Set([n.id]);
    for (;;) {
      const parentEdge = graph.inEdges(cur, ["contains"]).find((e) => {
        const p = graph.node(e.from);
        return p && p.kind === "interface" && !seen.has(p.id);
      });
      if (!parentEdge) break;
      const parent = graph.node(parentEdge.from)!;
      seen.add(parent.id);
      path.push(parent.id);
      edges.push(parentEdge);
      typeSeeds.push({
        node: parent,
        depth: path.length - 1,
        seed: n.id,
        path: [...path],
        edges: [...edges],
      });
      cur = parent.id;
    }
  }
  const typeAffected = bfsAffected(graph, typeSeeds, [...TYPE_EDGE_KINDS]);
  for (const id of affected.keys()) typeAffected.delete(id);

  const relevant = new Set<string>([
    ...changed.map((n) => n.id),
    ...affected.keys(),
    ...typeAffected.keys(),
  ]);

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
    typeDirect: [...typeAffected.values()].filter((a) => a.depth === 1),
    typeTransitive: [...typeAffected.values()]
      .filter((a) => a.depth >= 2)
      .sort((a, b) => a.depth - b.depth || a.node.name.localeCompare(b.node.name)),
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
