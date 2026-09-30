import type { RippleGraph } from "../graph/graph.js";
import type { GraphEdge, SourceRange } from "../graph/types.js";
import type { AffectedNode, ImpactResult } from "./traverse.js";

/** Format a 0-based range as 1-based `L:C-L:C` for humans. */
export function formatRange(r: SourceRange): string {
  return `${r.startLine + 1}:${r.startChar + 1}-${r.endLine + 1}:${r.endChar + 1}`;
}

export function formatEvidence(edge: GraphEdge): string {
  return edge.evidence
    .map(
      (e) =>
        `${e.file}:${formatRange(e.range)} (${e.source}${e.detail ? `, ${e.detail}` : ""})`,
    )
    .join("; ");
}

export function formatImpact(result: ImpactResult, graph: RippleGraph): string {
  const lines: string[] = [];

  lines.push("Changed symbol:");
  for (const n of result.changed) lines.push(`  ${n.name}  (${n.file})`);

  lines.push("", "Direct:");
  for (const a of result.direct) lines.push(`  ${a.node.name}  (${a.node.file})`);

  lines.push("", "Transitive:");
  for (const a of result.transitive) {
    lines.push(`  ${a.node.name}  (${a.node.file})`);
  }

  lines.push("", "Relevant tests (call or reference an affected symbol — not a coverage claim):");
  for (const t of result.relevantTests) lines.push(`  ${t.file}`);

  if (result.referencing.length > 0) {
    lines.push("", "Referencing only (no call/implements edge — not reported as affected):");
    for (const r of result.referencing) {
      lines.push(`  ${r.node.name}  (${r.node.kind}, ${r.node.file}) — ${r.edge.kind}`);
    }
  }

  lines.push("", "Impact paths:");
  const all = [...result.direct, ...result.transitive];
  for (const a of all) lines.push(formatPath(a, graph));

  return lines.join("\n");
}

function formatPath(affected: AffectedNode, graph: RippleGraph): string {
  const lines: string[] = [];
  for (let i = 0; i < affected.path.length; i++) {
    const node = graph.node(affected.path[i]);
    const name = node?.name ?? affected.path[i];
    if (i === 0) {
      lines.push(`  ${name}`);
    } else {
      const edge = affected.edges[i - 1];
      const evidence = edge ? `   [${edge.kind} @ ${formatEvidence(edge)}]` : "";
      lines.push(`  <- ${name}${evidence}`);
    }
  }
  return lines.join("\n");
}
