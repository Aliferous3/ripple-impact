import type {
  AffectedJson,
  AnalysisResult,
  ChangedSymbolJson,
  DiffHunk,
} from "../types.js";

/**
 * CascadeViewModel — deterministic mapping from the engine's
 * AnalysisResult to the Cascade document. Pure data organization: no
 * causal semantics are invented here; every row/edge/path originates in
 * the analysis payload.
 */

export type TierId =
  | "changed"
  | "deleted"
  | "direct"
  | "transitive"
  | "type"
  | "tests"
  | "references";

export type RelKind =
  | "calls"
  | "jsx_uses"
  | "type_depends"
  | "imports"
  | "references"
  | "implements"
  | "former-caller"
  | "covers"
  | string;

export interface EvidenceSite {
  file: string;
  line: number;
  source: string;
  detail?: string;
}

/** Evidence records deduplicated by file+line for presentation only. */
export interface EvidenceGroup {
  rel: RelKind;
  file: string;
  line: number;
  sites: EvidenceSite[];
}

export interface PathEdgeView {
  rel: RelKind;
  confidence?: string;
  evidence: EvidenceSite[];
}

export interface RootPath {
  rootId: string;
  rootLabel: string;
  /** Root → … → this node, root first. */
  steps: { id: string; label: string; file: string }[];
  /** edges[i] connects steps[i] → steps[i+1]. */
  edges: PathEdgeView[];
}

export interface CascadeRow {
  id: string;
  tier: TierId;
  label: string;
  kind: string;
  file: string;
  line?: number;
  depth: number;
  changeKind?: string;
  typeOnly?: boolean;
  /** Nearest hop toward the changed root — the row's direct claim. */
  parent?: { label: string; rel: RelKind; file: string; line?: number };
  roots: { id: string; label: string }[];
  paths: RootPath[];
  /** Grouped evidence from the primary path's final edge. */
  evidence: EvidenceGroup[];
  /** All edge evidence across incoming relationships (WHY body). */
  incoming: { label: string; rel: RelKind; evidence: EvidenceGroup[]; confidence?: string }[];
  warnings: string[];
  hasDiff: boolean;
  changedInfo?: ChangedSymbolJson;
  deletedInfo?: AnalysisResult["deleted"][number];
  /** References tier only: which relationship connects this row. */
  refRel?: RelKind;
  /** Tests tier only: symbols the test is connected to. */
  testVia?: { symbol: string; edgeKind: string }[];
  /** Weakest edge confidence on the primary path, if the engine says so. */
  confidence?: string;
}

export interface CascadeTier {
  id: TierId;
  label: string;
  note: string;
  color: string;
  rows: CascadeRow[];
}

export interface Cluster {
  path: string;
  total: number;
  runtime: number;
  type: number;
  tests: number;
  refs: number;
  warn: number;
  maxDepth: number;
  rowIds: string[];
}

export interface CascadeModel {
  tiers: CascadeTier[];
  byId: Map<string, CascadeRow>;
  warnings: AnalysisResult["warnings"];
  /** Total affected rows (excludes changed/deleted roots). */
  impactRows: number;
  /** Subsystem rollup — populated when impactRows > ROLLUP_THRESHOLD. */
  clusters: Cluster[] | null;
  meta: {
    repoName: string;
    oldRev: string;
    newRev: string;
    base?: string;
    totalMs: number;
  };
}

export const ROLLUP_THRESHOLD = 120;

export const TIER_META: Record<TierId, { label: string; note: string; color: string }> = {
  changed: { label: "CHANGED", note: "what you actually modified", color: "#f0a24b" },
  deleted: { label: "DELETED", note: "present at base, absent in working tree", color: "#e3657d" },
  direct: { label: "DIRECT", note: "depends on changed runtime code", color: "#52b8e8" },
  transitive: { label: "TRANSITIVE", note: "reached through one or more hops", color: "#52b8e8" },
  type: { label: "TYPE-AFFECTED", note: "compile-time contract consumers", color: "#a98bf0" },
  tests: { label: "TESTS", note: "deterministically connected — not a coverage claim", color: "#4fc3a1" },
  references: { label: "REFERENCES", note: "related, but impact not proven", color: "#5b6676" },
};

export const TIER_ORDER: TierId[] = [
  "changed",
  "deleted",
  "direct",
  "transitive",
  "type",
  "tests",
  "references",
];

export const REL_META: Record<string, { arrow: string; label: string }> = {
  calls: { arrow: "→", label: "calls" },
  jsx_uses: { arrow: "→", label: "jsx_uses" },
  implements: { arrow: "→", label: "implements" },
  type_depends: { arrow: "⇢", label: "type_depends" },
  imports: { arrow: "⇠", label: "imports" },
  references: { arrow: "⋯", label: "references" },
  "former-caller": { arrow: "⇥", label: "former caller" },
  covers: { arrow: "⊨", label: "covers" },
  git_diff: { arrow: "±", label: "git diff" },
};

export const TIER_GLYPH: Record<TierId, string> = {
  changed: "◆",
  deleted: "⊘",
  direct: "●",
  transitive: "◐",
  type: "▲",
  tests: "⬚",
  references: "○",
};

/** Synthetic id matching the mapper's tombstone keying. */
export function tombstoneId(file: string, name: string): string {
  return `deleted:${file}:${name}`;
}

function groupEvidence(rel: RelKind, sites: EvidenceSite[]): EvidenceGroup[] {
  const byLine = new Map<string, EvidenceGroup>();
  for (const s of sites) {
    const key = `${s.file}:${s.line}`;
    const g = byLine.get(key);
    if (g) g.sites.push(s);
    else byLine.set(key, { rel, file: s.file, line: s.line, sites: [s] });
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

const WEAK_CONFIDENCE: Record<string, number> = { certain: 0, high: 1, inferred: 2 };

function weakestConfidence(paths: RootPath[]): string | undefined {
  let worst: string | undefined;
  for (const p of paths)
    for (const e of p.edges)
      if (e.confidence && e.confidence !== "certain")
        if (!worst || (WEAK_CONFIDENCE[e.confidence] ?? 0) > (WEAK_CONFIDENCE[worst] ?? 0))
          worst = e.confidence;
  return worst;
}

/** Hunks whose old/new side intersects the changed symbol's evidence ranges. */
export function relevantHunks(c: ChangedSymbolJson, a: AnalysisResult): { file: string; hunk: DiffHunk }[] {
  const file = a.diffFiles.find((f) => f.path === c.file || f.oldPath === c.file);
  if (!file) return [];
  const overlap = (hs: number, he: number, s?: number, e?: number) =>
    s === undefined || e === undefined || (hs < e && s < he);
  return file.hunks
    .filter((h) =>
      c.evidence.some(
        (ev) =>
          overlap(h.newRange.start, h.newRange.end, ev.newRange?.start, ev.newRange?.end) ||
          overlap(h.oldRange.start, h.oldRange.end, ev.oldRange?.start, ev.oldRange?.end),
      ),
    )
    .map((hunk) => ({ file: file.path, hunk }));
}

export function buildCascade(a: AnalysisResult): CascadeModel {
  const rows = new Map<string, CascadeRow>();
  const labelOf = new Map<string, string>();
  const fileOf = new Map<string, string>();

  const warnFor = (name: string, file: string): string[] =>
    a.warnings
      .filter((w) => w.symbol === name || w.file === file)
      .map((w) => w.code);

  // ── changed roots ────────────────────────────────────────────
  for (const c of a.changed) {
    if (c.changeKind === "deleted") continue; // handled with deleted tier
    const id = c.id ?? `changed:${c.file}:${c.name}`;
    labelOf.set(id, c.name);
    fileOf.set(id, c.file);
    rows.set(id, {
      id,
      tier: "changed",
      label: c.name,
      kind: c.kind,
      file: c.file,
      line: c.evidence.find((e) => e.newRange)?.newRange?.start,
      depth: 0,
      changeKind: c.changeKind,
      typeOnly: c.typeOnly,
      roots: [{ id, label: c.name }],
      paths: [],
      evidence: [],
      incoming: [],
      warnings: warnFor(c.name, c.file),
      hasDiff: relevantHunks(c, a).length > 0,
      changedInfo: c,
    });
  }

  // ── deleted ──────────────────────────────────────────────────
  const deletedByKey = new Map<string, AnalysisResult["deleted"][number]>();
  for (const d of a.deleted) deletedByKey.set(`${d.file}:${d.name}`, d);
  const seenDeleted = new Set<string>();
  const addDeleted = (id: string, name: string, file: string, d?: AnalysisResult["deleted"][number]) => {
    if (seenDeleted.has(id)) return;
    seenDeleted.add(id);
    labelOf.set(id, name);
    fileOf.set(id, file);
    const changedEntry = a.changed.find((c) => c.changeKind === "deleted" && c.file === file && c.name === name);
    rows.set(id, {
      id,
      tier: "deleted",
      label: name,
      kind: changedEntry?.kind ?? "function",
      file,
      depth: 0,
      changeKind: "deleted",
      roots: [{ id, label: name }],
      paths: [],
      evidence: [],
      incoming: [],
      warnings: warnFor(name, file),
      hasDiff: !!changedEntry && relevantHunks(changedEntry, a).length > 0,
      changedInfo: changedEntry,
      deletedInfo: d,
      confidence: "inferred",
    });
  };
  for (const d of a.deleted) addDeleted(tombstoneId(d.file, d.name), d.name, d.file, d);
  for (const c of a.changed)
    if (c.changeKind === "deleted" && !deletedByKey.has(`${c.file}:${c.name}`))
      addDeleted(tombstoneId(c.file, c.name), c.name, c.file, undefined);

  // ── affected (runtime + type) ────────────────────────────────
  const putAffected = (list: AffectedJson[], tier: TierId) => {
    for (const af of list) {
      labelOf.set(af.id, af.name);
      fileOf.set(af.id, af.file);
      if (rows.has(af.id)) continue; // runtime membership wins over type

      const paths: RootPath[] = af.paths.map((p) => ({
        rootId: p.root,
        rootLabel: labelOf.get(p.root) ?? af.roots.find((r) => r === p.root) ?? p.root,
        steps: p.nodes.map((n) => ({ id: n.id, label: n.name, file: n.file })),
        edges: p.edges.map((e) => ({
          rel: e.kind,
          confidence: e.confidence,
          evidence: e.evidence.map((ev) => ({
            file: ev.file,
            line: ev.range.startLine + 1,
            source: ev.source,
            detail: ev.detail,
          })),
        })),
      }));

      // Immediate parent = last edge + its source node on the primary path.
      const primary = af.paths[0];
      const lastEdge = primary?.edges[primary.edges.length - 1];
      const parentStep = primary && primary.nodes.length > 1 ? primary.nodes[primary.nodes.length - 2] : undefined;
      const firstSite = lastEdge?.evidence[0];
      const parent = parentStep
        ? {
            label: parentStep.name,
            rel: (lastEdge?.kind ?? "references") as RelKind,
            file: firstSite?.file ?? parentStep.file,
            line: firstSite ? firstSite.range.startLine + 1 : undefined,
          }
        : undefined;

      // All incoming relationships across every witness path.
      const seenIncoming = new Map<string, { label: string; rel: RelKind; evidence: EvidenceSite[]; confidence?: string }>();
      for (const p of af.paths) {
        const e = p.edges[p.edges.length - 1];
        const from = p.nodes.length > 1 ? p.nodes[p.nodes.length - 2] : undefined;
        if (!e || !from) continue;
        const key = `${from.id}${e.kind}`;
        const cur = seenIncoming.get(key);
        const sites = e.evidence.map((ev) => ({
          file: ev.file, line: ev.range.startLine + 1, source: ev.source, detail: ev.detail,
        }));
        if (cur) cur.evidence.push(...sites);
        else seenIncoming.set(key, { label: from.name, rel: e.kind, evidence: sites, confidence: e.confidence });
      }

      rows.set(af.id, {
        id: af.id,
        tier,
        label: af.name,
        kind: af.kind,
        file: af.file,
        line: af.range ? af.range.startLine + 1 : undefined,
        depth: af.depth,
        parent,
        roots: af.roots.map((r) => ({ id: r, label: labelOf.get(r) ?? r })),
        paths,
        evidence: lastEdge
          ? groupEvidence(
              lastEdge.kind,
              lastEdge.evidence.map((ev) => ({
                file: ev.file, line: ev.range.startLine + 1, source: ev.source, detail: ev.detail,
              })),
            )
          : [],
        incoming: [...seenIncoming.values()].map((x) => ({
          label: x.label, rel: x.rel, evidence: groupEvidence(x.rel, x.evidence), confidence: x.confidence,
        })),
        warnings: warnFor(af.name, af.file),
        hasDiff: false,
        confidence: weakestConfidence(paths),
      });
    }
  };
  putAffected(a.direct, "direct");
  putAffected(a.transitive, "transitive");
  putAffected(a.typeImpact.direct, "type");
  putAffected(a.typeImpact.transitive, "type");

  // ── tests — group via edges by test node ─────────────────────
  const testById = new Map<string, { file: string; via: { symbol: string; edgeKind: string }[] }>();
  for (const t of a.tests)
    for (const v of t.via) {
      const cur = testById.get(v.testId) ?? { file: t.file, via: [] };
      cur.via.push({ symbol: v.symbol, edgeKind: v.edgeKind });
      testById.set(v.testId, cur);
    }
  for (const [testId, t] of testById) {
    if (rows.has(testId)) continue;
    const name = t.file.split("/").pop() ?? t.file;
    const viaRows = t.via.map((v) => {
      const target = [...rows.values()].find((r) => r.label === v.symbol);
      return { symbol: v.symbol, edgeKind: v.edgeKind, depth: target?.depth ?? 1 };
    });
    rows.set(testId, {
      id: testId,
      tier: "tests",
      label: name,
      kind: "test",
      file: t.file,
      depth: Math.min(...viaRows.map((v) => v.depth)) + 1,
      parent: viaRows[0]
        ? { label: viaRows[0].symbol, rel: viaRows[0].edgeKind as RelKind, file: t.file, line: undefined }
        : undefined,
      roots: [],
      paths: [],
      evidence: [],
      incoming: [],
      warnings: warnFor(name, t.file),
      hasDiff: false,
      testVia: t.via,
    });
  }

  // ── references — related, unproven ───────────────────────────
  const seenRefs = new Set<string>();
  for (const r of a.referencing) {
    if (rows.has(r.id) || seenRefs.has(r.id)) continue;
    seenRefs.add(r.id);
    const targetLabel = labelOf.get(r.targetId);
    rows.set(r.id, {
      id: r.id,
      tier: "references",
      label: r.name,
      kind: r.kind,
      file: r.file,
      depth: Number.MAX_SAFE_INTEGER,
      parent: targetLabel
        ? { label: targetLabel, rel: r.edgeKind as RelKind, file: r.file, line: undefined }
        : undefined,
      roots: [],
      paths: [],
      evidence: [],
      incoming: [],
      warnings: warnFor(r.name, r.file),
      hasDiff: false,
      refRel: r.edgeKind,
    });
  }

  // ── tiers ────────────────────────────────────────────────────
  const tiers: CascadeTier[] = TIER_ORDER.map((id) => ({
    id,
    ...TIER_META[id],
    rows: [...rows.values()]
      .filter((r) => r.tier === id)
      .sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label)),
  }));

  const impactRows = tiers
    .filter((t) => t.id !== "changed" && t.id !== "deleted")
    .reduce((n, t) => n + t.rows.length, 0);

  // ── subsystem rollup (deterministic: first two path segments) ─
  let clusters: Cluster[] | null = null;
  if (impactRows > ROLLUP_THRESHOLD) {
    const groups = new Map<string, Cluster>();
    const bucket = (file: string): string => {
      const segs = file.split("/");
      return segs.length > 1 ? segs.slice(0, 2).join("/") : segs[0];
    };
    for (const r of rows.values()) {
      if (r.tier === "changed") continue;
      const path = bucket(r.file);
      const c = groups.get(path) ?? {
        path, total: 0, runtime: 0, type: 0, tests: 0, refs: 0, warn: 0, maxDepth: 0, rowIds: [],
      };
      c.total++;
      c.rowIds.push(r.id);
      if (r.tier === "direct" || r.tier === "transitive" || r.tier === "deleted") c.runtime++;
      else if (r.tier === "type") c.type++;
      else if (r.tier === "tests") c.tests++;
      else c.refs++;
      if (r.warnings.length) c.warn++;
      if (r.depth !== Number.MAX_SAFE_INTEGER) c.maxDepth = Math.max(c.maxDepth, r.depth);
      groups.set(path, c);
    }
    clusters = [...groups.values()].sort((a, b) => b.total - a.total || a.path.localeCompare(b.path));
  }

  const repoPath = a.repo.root.replace(/\\/g, "/");
  return {
    tiers,
    byId: rows,
    warnings: a.warnings,
    impactRows,
    clusters,
    meta: {
      repoName: repoPath.split("/").filter(Boolean).pop() ?? repoPath,
      oldRev: a.comparison.oldRev,
      newRev: a.comparison.newRev,
      base: a.comparison.base,
      totalMs: Math.round(a.timings.totalMs),
    },
  };
}

/** WHY title per tier — semantic, never "details". */
export function whyTitle(r: CascadeRow): string {
  switch (r.tier) {
    case "changed":
      return `WHY IS ${r.label.toUpperCase()} CHANGED`;
    case "deleted":
      return `WHY WAS ${r.label.toUpperCase()} DELETED — AND WHAT USED TO DEPEND ON IT`;
    case "type":
      return `WHY IS ${r.label.toUpperCase()} TYPE-AFFECTED`;
    case "tests":
      return `WHY IS ${r.label.toUpperCase()} A RELEVANT TEST`;
    case "references":
      return `WHY IS ${r.label.toUpperCase()} ONLY A REFERENCE`;
    default:
      return `WHY IS ${r.label.toUpperCase()} AFFECTED`;
  }
}
