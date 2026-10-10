import { RippleGraph } from "./graph.js";
import type { GraphNode, NodeProvenance } from "./types.js";

/**
 * Deterministic merge of per-project graph fragments into one
 * repository graph.
 *
 * Guarantees:
 *  - Provenance: every merged node records `{ adapter, project }`.
 *  - No symbol-id collision: when two fragments define the same node id
 *    (e.g. `User.save` from two adapters/projects), BOTH occurrences
 *    are namespaced to `<projectId>::<id>` — symmetric, deterministic,
 *    and impossible to confuse with an unnamespaced symbol.
 *  - No invented edges: fragments contribute only the edges they
 *    produced. Two symbols with similar names stay unrelated unless an
 *    adapter emitted a real edge between them (a future explicit
 *    cross-language bridge — e.g. OpenAPI — would arrive as adapter
 *    evidence, never name-matching).
 *  - Deterministic output: fragments are processed in projectId order;
 *    nodes and edges are added in each fragment's own order, so merging
 *    the same inputs always yields the same graph.
 *
 * File paths are rebased from project-relative to repo-relative using
 * the fragment's project root.
 */

export interface GraphFragment {
  projectId: string;
  adapterId: string;
  /** Project root relative to repo root ("" = repo root). */
  projectRoot: string;
  graph: RippleGraph;
}

export function mergeGraphs(repoRoot: string, fragments: GraphFragment[]): RippleGraph {
  const ordered = [...fragments].sort((a, b) => a.projectId.localeCompare(b.projectId));

  // Pass 1: find ids defined by more than one fragment.
  const idOwners = new Map<string, Set<string>>();
  for (const f of ordered) {
    for (const n of f.graph.nodes) {
      const owners = idOwners.get(n.id) ?? new Set<string>();
      owners.add(f.projectId);
      idOwners.set(n.id, owners);
    }
  }
  const colliding = new Set<string>();
  for (const [id, owners] of idOwners) {
    if (owners.size > 1) colliding.add(id);
  }

  const merged = new RippleGraph(repoRoot);
  const rebase = (rel: string, file: string): string =>
    rel === "" ? file : `${rel}/${file}`;

  for (const f of ordered) {
    const prov: NodeProvenance = { adapter: f.adapterId, project: f.projectId };
    const idMap = new Map<string, string>();
    for (const n of f.graph.nodes) {
      const id = colliding.has(n.id) ? `${f.projectId}::${n.id}` : n.id;
      idMap.set(n.id, id);
      const node: GraphNode = {
        ...n,
        id,
        file: rebase(f.projectRoot, n.file),
        provenance: prov,
      };
      merged.addNode(node);
    }
    for (const e of f.graph.edges) {
      const from = idMap.get(e.from) ?? e.from;
      const to = idMap.get(e.to) ?? e.to;
      for (const ev of e.evidence) {
        merged.addEdge(from, to, e.kind, { ...ev, file: rebase(f.projectRoot, ev.file) }, e.confidence);
      }
    }
  }
  return merged;
}
