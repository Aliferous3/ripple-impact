import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
  RippleGraphData,
  Evidence,
} from "./types.js";
import { serializeGraph, type SerializedGraph } from "./serialize.js";

export class RippleGraph {
  readonly root: string;
  private readonly nodeMap = new Map<string, GraphNode>();
  private readonly edgeMap = new Map<string, GraphEdge>();
  private readonly outIndex = new Map<string, GraphEdge[]>();
  private readonly inIndex = new Map<string, GraphEdge[]>();
  private readonly nameIndex = new Map<string, GraphNode[]>();

  constructor(root: string) {
    this.root = root;
  }

  addNode(node: GraphNode): GraphNode {
    const existing = this.nodeMap.get(node.id);
    if (existing) return existing;
    this.nodeMap.set(node.id, node);
    const named = this.nameIndex.get(node.name) ?? [];
    named.push(node);
    this.nameIndex.set(node.name, named);
    return node;
  }

  addEdge(
    from: string,
    to: string,
    kind: EdgeKind,
    evidence: Evidence,
    confidence: GraphEdge["confidence"] = "certain",
  ): GraphEdge {
    const key = `${from}\n${to}\n${kind}`;
    let edge = this.edgeMap.get(key);
    if (!edge) {
      edge = { from, to, kind, evidence: [], confidence };
      this.edgeMap.set(key, edge);
      push(this.outIndex, from, edge);
      push(this.inIndex, to, edge);
    }
    // Merge confidence pessimistically and append evidence.
    if (edge.confidence === "certain" && confidence !== "certain") {
      edge.confidence = confidence;
    }
    edge.evidence.push(evidence);
    return edge;
  }

  node(id: string): GraphNode | undefined {
    return this.nodeMap.get(id);
  }

  /** Find non-file nodes whose display name matches `name` (e.g. "checkout" or "checkout()"). */
  findByName(name: string): GraphNode[] {
    const results: GraphNode[] = [];
    for (const node of this.nodeMap.values()) {
      if (node.kind === "file") continue;
      if (node.name === name || node.name === `${name}()` || baseName(node.name) === name) {
        results.push(node);
      }
    }
    return results;
  }

  outEdges(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    return filter(this.outIndex.get(id), kinds);
  }

  inEdges(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    return filter(this.inIndex.get(id), kinds);
  }

  get nodes(): GraphNode[] {
    return [...this.nodeMap.values()];
  }

  get edges(): GraphEdge[] {
    return [...this.edgeMap.values()];
  }

  stats(): { nodes: number; edges: number; byKind: Record<string, number> } {
    const byKind: Record<string, number> = {};
    for (const e of this.edgeMap.values()) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    }
    return { nodes: this.nodeMap.size, edges: this.edgeMap.size, byKind };
  }
}

/** Serialize to the persisted artifact shape (schema-versioned). */
export function graphToData(graph: RippleGraph): SerializedGraph {
  return serializeGraph(graph.root, graph.nodes, graph.edges);
}

/** Rebuild a graph from a validated serialized artifact. */
export function graphFromData(data: SerializedGraph): RippleGraph {
  const g = new RippleGraph(data.root);
  for (const n of data.nodes) g.addNode(n);
  for (const e of data.edges) {
    for (const ev of e.evidence) g.addEdge(e.from, e.to, e.kind, ev, e.confidence);
  }
  return g;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function filter(edges: GraphEdge[] | undefined, kinds?: EdgeKind[]): GraphEdge[] {
  if (!edges) return [];
  if (!kinds) return edges;
  return edges.filter((e) => kinds.includes(e.kind));
}

/** Strip arity/method suffixes: "Session#refresh()" -> "refresh". */
export function baseName(displayName: string): string {
  const last = displayName.split("#").pop() ?? displayName;
  return last.replace(/\(\)$/, "");
}

const TEST_FILE_RE = /(\.test\.|\.spec\.|\/tests?\/|\/__tests__\/)/i;

export function isTestFile(file: string): boolean {
  return TEST_FILE_RE.test(file.replace(/\\/g, "/"));
}
