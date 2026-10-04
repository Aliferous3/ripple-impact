import { diffImpact, type AnalysisWarning, type CacheReport, type DiffImpactTimings } from "../changes/pipeline.js";
import type { ChangedSymbol, NonSemanticChange, UnmappedFile } from "../changes/types.js";
import type { GraphNode, SourceRange } from "../graph/types.js";
import { GRAPH_SCHEMA_VERSION } from "../graph/serialize.js";
import { RippleGraph } from "../graph/graph.js";
import { getGraphForRepo } from "../cache/graph.js";
import { impactNodes } from "../impact/traverse.js";

/** Machine-readable analysis output schema version (JSON contract). */
export const API_SCHEMA_VERSION = 1;

export interface AffectedJson {
  id: string;
  name: string;
  kind: string;
  file: string;
  range?: SourceRange;
  depth: number;
  /** Changed-root ids that caused this node to appear. */
  roots: string[];
  /** One witness path per root. */
  paths: {
    root: string;
    nodes: { id: string; name: string; file: string }[];
    edges: {
      from: string;
      to: string;
      kind: string;
      evidence: { file: string; range: SourceRange; source: string; detail?: string }[];
    }[];
  }[];
}

export interface ChangedSymbolJson {
  id?: string;
  name: string;
  kind: string;
  file: string;
  changeKind: ChangedSymbol["changeKind"];
  renamedFrom?: { name: string; file: string };
  evidence: { file: string; oldRange?: { start: number; end: number }; newRange?: { start: number; end: number } }[];
}

export interface AnalysisResult {
  schemaVersion: number;
  repo: { root: string; fingerprint: string };
  comparison: { oldRev: string; newRev: string; base?: string };
  changed: ChangedSymbolJson[];
  direct: AffectedJson[];
  transitive: AffectedJson[];
  deleted: { name: string; file: string; formerCallers: { name: string; file: string }[]; resolved: boolean }[];
  referencing: { name: string; kind: string; file: string; edgeKind: string }[];
  tests: { file: string; via: { symbol: string; edgeKind: string }[] }[];
  nonSemantic: NonSemanticChange[];
  unmappedFiles: UnmappedFile[];
  renamedFiles: { from: string; to: string }[];
  warnings: AnalysisWarning[];
  timings: DiffImpactTimings & { totalMs: number };
  cache: CacheReport;
}

function toAffectedJson(
  list: { node: GraphNode; depth: number; roots: string[]; pathsByRoot: Record<string, { path: string[]; edges: import("../graph/types.js").GraphEdge[] }> }[],
  graph: RippleGraph,
): AffectedJson[] {
  return list.map((a) => ({
    id: a.node.id,
    name: a.node.name,
    kind: a.node.kind,
    file: a.node.file,
    range: a.node.range,
    depth: a.depth,
    roots: a.roots,
    paths: a.roots.map((rootId) => {
      const p = a.pathsByRoot[rootId];
      return {
        root: rootId,
        nodes: (p?.path ?? []).map((id) => {
          const n = graph.node(id);
          return { id, name: n?.name ?? id, file: n?.file ?? "" };
        }),
        edges: (p?.edges ?? []).map((e) => ({
          from: e.from,
          to: e.to,
          kind: e.kind,
          evidence: e.evidence.map((ev) => ({
            file: ev.file,
            range: ev.range,
            source: ev.source,
            detail: ev.detail,
          })),
        })),
      };
    }),
  }));
}

function toChangedJson(c: ChangedSymbol): ChangedSymbolJson {
  return {
    id: c.node?.id,
    name: c.name,
    kind: c.node?.kind ?? "unknown",
    file: c.file,
    changeKind: c.changeKind,
    renamedFrom: c.renamedFrom,
    evidence: c.evidence,
  };
}

/**
 * Application-level entry point — returns structured data, no presentation.
 * Consumed by the CLI (--json and text renderers) and the future UI.
 */
export async function analyzeRepository(opts: {
  repo: string;
  base?: string;
}): Promise<AnalysisResult> {
  const t0 = performance.now();
  const r = await diffImpact(opts);
  return {
    schemaVersion: API_SCHEMA_VERSION,
    repo: { root: r.graph.root, fingerprint: r.fingerprint },
    comparison: {
      oldRev: r.diff.oldRev,
      newRev: r.diff.newRev,
      base: opts.base,
    },
    changed: r.changeSet.changed.map(toChangedJson),
    direct: toAffectedJson(r.impact.direct, r.graph),
    transitive: toAffectedJson(r.impact.transitive, r.graph),
    deleted: r.deletedImpact.map((d) => ({
      name: d.name,
      file: d.file,
      formerCallers: d.callers.map((c) => ({ name: c.name, file: c.file })),
      resolved: d.resolved,
    })),
    referencing: r.impact.referencing.map((x) => ({
      name: x.node.name,
      kind: x.node.kind,
      file: x.node.file,
      edgeKind: x.edge.kind,
    })),
    tests: r.impact.relevantTests.map((t) => ({
      file: t.file,
      via: t.via.map((v) => ({ symbol: graphName(v.edge.to, r.graph), edgeKind: v.edge.kind })),
    })),
    nonSemantic: r.changeSet.nonSemantic,
    unmappedFiles: r.changeSet.unmappedFiles,
    renamedFiles: r.changeSet.renamedFiles,
    warnings: r.warnings,
    timings: { ...r.timings, totalMs: performance.now() - t0 },
    cache: r.cache,
  };
}

function graphName(id: string, graph: RippleGraph): string {
  return graph.node(id)?.name ?? id;
}

/**
 * Symbol-investigation entry point: resolves `selector` (name or
 * `file::name`), runs impact, and reports ambiguity as a warning rather
 * than silently picking one.
 */
export async function analyzeSymbol(opts: {
  repo: string;
  symbol: string;
}): Promise<
  | { ok: true; result: AnalysisResult }
  | { ok: false; error: string; candidates: { name: string; file: string; selector: string }[] }
> {
  const { repo, symbol } = opts;
  const load = await getGraphForRepo(repo);
  const graph = load.graph;

  let matches: GraphNode[];
  if (symbol.includes("::")) {
    const [file, name] = symbol.split("::");
    matches = graph.findByName(name).filter((m) => m.file === file);
  } else {
    matches = graph.findByName(symbol);
  }

  if (matches.length === 0) {
    return { ok: false, error: `No symbol found matching "${symbol}"`, candidates: [] };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `Ambiguous symbol "${symbol}"`,
      candidates: matches.map((m) => ({
        name: m.name,
        file: m.file,
        selector: `${m.file}::${m.name}`,
      })),
    };
  }

  const res = impactNodes(graph, matches);
  // Reuse the diff-mode serializer with a synthesized changed set.
  const t0 = performance.now();
  const result: AnalysisResult = {
    schemaVersion: API_SCHEMA_VERSION,
    repo: { root: graph.root, fingerprint: load.fingerprint.key },
    comparison: { oldRev: "n/a", newRev: "symbol query" },
    changed: matches.map((m) => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      file: m.file,
      changeKind: "modified",
      evidence: [],
    })),
    direct: toAffectedJson(res.direct, graph),
    transitive: toAffectedJson(res.transitive, graph),
    deleted: [],
    referencing: res.referencing.map((x) => ({
      name: x.node.name,
      kind: x.node.kind,
      file: x.node.file,
      edgeKind: x.edge.kind,
    })),
    tests: res.relevantTests.map((t) => ({
      file: t.file,
      via: t.via.map((v) => ({ symbol: graphName(v.edge.to, graph), edgeKind: v.edge.kind })),
    })),
    nonSemantic: [],
    unmappedFiles: [],
    renamedFiles: [],
    warnings: [],
    timings: {
      gitDiffMs: 0,
      indexMs: load.loadMs,
      mapMs: 0,
      traverseMs: 0,
      fingerprintMs: 0,
      totalMs: performance.now() - t0,
    },
    cache: {
      index: load.status,
      graph: load.status,
      baseGraph: "not-required",
      enrichedFiles: load.enrichedFiles,
      missReason: load.reason,
    },
  };
  return { ok: true, result };
}
