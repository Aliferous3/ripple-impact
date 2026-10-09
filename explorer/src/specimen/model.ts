import type {
  AffectedJson,
  AnalysisResult,
  ChangedSymbolJson,
  DiffHunk,
} from "../types.js";

/**
 * SpecimenViewModel — deterministic mapping from the engine's
 * AnalysisResult to Design #33 specimen plates. Pure data organization:
 * no causal semantics are invented here; every plate, edge, and path
 * originates in the analysis payload.
 */

export type PlateCategory =
  | "changed"
  | "changedType"
  | "deleted"
  | "direct"
  | "transitive"
  | "type"
  | "test"
  | "reference"
  | "uncertain";

/** Class-mark variant — coarser than category: semantic group. */
export type ImpactKey =
  | "changed"
  | "direct"
  | "transitive"
  | "type"
  | "test"
  | "reference"
  | "uncertain"
  | "deleted";

export type RelKind = string;

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

export interface EvidenceHop {
  n: string;
  name: string;
  rel: string;
  note?: string;
  /** True for the hop that is the changed root. */
  root?: boolean;
}

export interface DiffLine {
  sign: "-" | "+";
  text: string;
}

export interface SpecimenDiff {
  file: string;
  oldRange: string;
  newRange: string;
  removed: string[];
  added: string[];
}

export interface Specimen {
  id: string;
  num: string;
  name: string;
  /** Plate header label, e.g. "CHANGED", "TYPE", "DELETED". */
  impact: string;
  impactKey: ImpactKey;
  category: PlateCategory;
  /** Short deterministic note under OPEN WHY. */
  note: string;
  /** Templated deterministic sentence — relationships only, no prose invention. */
  description: string;
  file: string;
  range: string;
  depth: string;
  /** Evidence state: "proven" | "reference only" | "inferred" | weak confidence. */
  confidence: string;
  subsystem: string;
  /** Causal root count as a string (plate metadata). */
  roots: string;
  /** Number of evidence edges on the primary path. */
  edges: number;
  status: string;
  evidenceFoot: string;
  evidence: EvidenceHop[];
  /** Additional causal paths beyond the primary one. */
  extraPaths: RootPath[];
  sourceFile: string;
  /** 1-based line window for /api/source. */
  sourceRange?: { start: number; end: number };
  /** Lines to mark inside the source preview. */
  markLines: number[];
  diffs: SpecimenDiff[];
  warning: boolean;
  warningCodes: string[];
  /** Structured data retained for WHY expansion. */
  paths: RootPath[];
  incoming: { label: string; rel: RelKind; evidence: EvidenceGroup[]; confidence?: string }[];
  changedInfo?: ChangedSymbolJson;
  deletedInfo?: AnalysisResult["deleted"][number];
  testVia?: { symbol: string; edgeKind: string }[];
  refRel?: RelKind;
  typeOnly?: boolean;
  changeKind?: string;
  kind: string;
  depthN: number;
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
  plateIds: string[];
}

export interface SpecimenModel {
  plates: Specimen[];
  byId: Map<string, Specimen>;
  warnings: AnalysisResult["warnings"];
  /** Total affected plates (excludes changed/deleted roots). */
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

export const REL_META: Record<string, { label: string }> = {
  calls: { label: "calls" },
  jsx_uses: { label: "jsx_uses" },
  implements: { label: "implements" },
  type_depends: { label: "type_depends" },
  imports: { label: "imports" },
  references: { label: "references" },
  "former-caller": { label: "former caller" },
  covers: { label: "covers" },
  git_diff: { label: "git diff" },
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

const fmtRange = (r?: { start: number; end: number }) =>
  r === undefined ? "—" : r.end <= r.start + 1 ? `L${r.start}` : `L${r.start}–L${r.end - 1}`;

/** Hunks whose old/new side intersects the changed symbol's evidence ranges. */
export function relevantHunks(
  c: ChangedSymbolJson,
  a: AnalysisResult,
): { file: string; hunk: DiffHunk }[] {
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

function toDiffs(c: ChangedSymbolJson | undefined, a: AnalysisResult): SpecimenDiff[] {
  if (!c) return [];
  return relevantHunks(c, a)
    .slice(0, 3)
    .map(({ file, hunk }) => ({
      file,
      oldRange: fmtRange(hunk.oldRange),
      newRange: fmtRange(hunk.newRange),
      removed: hunk.removedLines.slice(0, 8),
      added: hunk.addedLines.slice(0, 8),
    }));
}

/** First-two-segments subsystem bucket — same rule as the rollup. */
export function pathBucket(file: string): string {
  const segs = file.split("/");
  return segs.length > 1 ? segs.slice(0, 2).join("/") : segs[0];
}

/* ------------------------------------------------------------------ */
/* internal row construction — one semantic row per plate               */
/* ------------------------------------------------------------------ */

interface Row {
  id: string;
  category: PlateCategory;
  label: string;
  kind: string;
  file: string;
  line?: number;
  depth: number;
  changeKind?: string;
  typeOnly?: boolean;
  roots: { id: string; label: string }[];
  paths: RootPath[];
  evidence: EvidenceGroup[];
  incoming: { label: string; rel: RelKind; evidence: EvidenceGroup[]; confidence?: string }[];
  warnings: string[];
  changedInfo?: ChangedSymbolJson;
  deletedInfo?: AnalysisResult["deleted"][number];
  refRel?: RelKind;
  testVia?: { symbol: string; edgeKind: string }[];
  confidence?: string;
  /** Fan-out claims for changed plates: first hop of each descendant path. */
  fanout?: { label: string; rel: RelKind; file: string; line?: number }[];
  formerCallers?: { id: string; name: string; file: string }[];
}

const CATEGORY_ORDER: Record<PlateCategory, number> = {
  changed: 0,
  deleted: 1,
  direct: 2,
  transitive: 3,
  type: 4,
  changedType: 0,
  test: 5,
  reference: 6,
  uncertain: 6,
};

export function buildSpecimen(a: AnalysisResult): SpecimenModel {
  const rows = new Map<string, Row>();
  const labelOf = new Map<string, string>();
  const warnFor = (name: string, file: string): string[] =>
    a.warnings.filter((w) => w.symbol === name || w.file === file).map((w) => w.code);

  // ── changed roots ────────────────────────────────────────────
  for (const c of a.changed) {
    if (c.changeKind === "deleted") continue; // handled with deleted
    const id = c.id ?? `changed:${c.file}:${c.name}`;
    labelOf.set(id, c.name);
    rows.set(id, {
      id,
      category: c.typeOnly ? "changedType" : "changed",
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
    const changedEntry = a.changed.find(
      (c) => c.changeKind === "deleted" && c.file === file && c.name === name,
    );
    rows.set(id, {
      id,
      category: "deleted",
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
      changedInfo: changedEntry,
      deletedInfo: d,
      formerCallers: d?.formerCallers ?? [],
      confidence: "inferred",
    });
  };
  for (const d of a.deleted) addDeleted(tombstoneId(d.file, d.name), d.name, d.file, d);
  for (const c of a.changed)
    if (c.changeKind === "deleted" && !deletedByKey.has(`${c.file}:${c.name}`))
      addDeleted(tombstoneId(c.file, c.name), c.name, c.file, undefined);

  // ── affected (runtime + type) ────────────────────────────────
  const putAffected = (list: AffectedJson[], category: PlateCategory) => {
    for (const af of list) {
      labelOf.set(af.id, af.name);
      if (rows.has(af.id)) continue; // runtime membership wins over type

      const paths: RootPath[] = af.paths.map((p) => ({
        rootId: p.root,
        rootLabel: labelOf.get(p.root) ?? p.root,
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

      const primary = af.paths[0];
      const lastEdge = primary?.edges[primary.edges.length - 1];
      const seenIncoming = new Map<
        string,
        { label: string; rel: RelKind; evidence: EvidenceSite[]; confidence?: string }
      >();
      for (const p of af.paths) {
        const e = p.edges[p.edges.length - 1];
        const from = p.nodes.length > 1 ? p.nodes[p.nodes.length - 2] : undefined;
        if (!e || !from) continue;
        const key = `${from.id}${e.kind}`;
        const cur = seenIncoming.get(key);
        const sites = e.evidence.map((ev) => ({
          file: ev.file,
          line: ev.range.startLine + 1,
          source: ev.source,
          detail: ev.detail,
        }));
        if (cur) cur.evidence.push(...sites);
        else
          seenIncoming.set(key, {
            label: from.name,
            rel: e.kind,
            evidence: sites,
            confidence: e.confidence,
          });
      }

      rows.set(af.id, {
        id: af.id,
        category,
        label: af.name,
        kind: af.kind,
        file: af.file,
        line: af.range ? af.range.startLine + 1 : undefined,
        depth: af.depth,
        roots: af.roots.map((r) => ({ id: r, label: labelOf.get(r) ?? r })),
        paths,
        evidence: lastEdge
          ? groupEvidence(
              lastEdge.kind,
              lastEdge.evidence.map((ev) => ({
                file: ev.file,
                line: ev.range.startLine + 1,
                source: ev.source,
                detail: ev.detail,
              })),
            )
          : [],
        incoming: [...seenIncoming.values()].map((x) => ({
          label: x.label,
          rel: x.rel,
          evidence: groupEvidence(x.rel, x.evidence),
          confidence: x.confidence,
        })),
        warnings: warnFor(af.name, af.file),
        confidence: weakestConfidence(paths),
      });
    }
  };
  putAffected(a.direct, "direct");
  putAffected(a.transitive, "transitive");
  putAffected(a.typeImpact.direct, "type");
  putAffected(a.typeImpact.transitive, "type");

  // ── tests ────────────────────────────────────────────────────
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
    rows.set(testId, {
      id: testId,
      category: "test",
      label: name,
      kind: "test",
      file: t.file,
      depth: 1,
      roots: [],
      paths: [],
      evidence: [],
      incoming: [],
      warnings: warnFor(name, t.file),
      testVia: t.via,
    });
  }

  // ── references — related, unproven ───────────────────────────
  const seenRefs = new Set<string>();
  for (const r of a.referencing) {
    if (rows.has(r.id) || seenRefs.has(r.id)) continue;
    seenRefs.add(r.id);
    rows.set(r.id, {
      id: r.id,
      category: "reference",
      label: r.name,
      kind: r.kind,
      file: r.file,
      depth: Number.MAX_SAFE_INTEGER,
      roots: [],
      paths: [],
      evidence: [],
      incoming: [],
      warnings: warnFor(r.name, r.file),
      refRel: r.edgeKind,
    });
  }

  // ── fan-out claims for changed/deleted roots ─────────────────
  for (const row of rows.values()) {
    if (row.category !== "changed" && row.category !== "changedType" && row.category !== "deleted")
      continue;
    const fanout: Row["fanout"] = [];
    for (const other of rows.values()) {
      const p = other.paths[0];
      if (!p || p.rootId !== row.id || p.steps.length < 2) continue;
      const e = p.edges[0];
      const site = e?.evidence[0];
      const step = p.steps[1];
      if (fanout.some((f) => f.label === step.label)) continue;
      fanout.push({ label: step.label, rel: e?.rel ?? "references", file: site?.file ?? step.file, line: site?.line });
      if (fanout.length >= 6) break;
    }
    row.fanout = fanout;
  }

  // ── ordering: category → depth → label ───────────────────────
  const ordered = [...rows.values()].sort(
    (x, y) =>
      CATEGORY_ORDER[x.category] - CATEGORY_ORDER[y.category] ||
      x.depth - y.depth ||
      x.label.localeCompare(y.label),
  );

  const impactRows = ordered.filter(
    (r) => r.category !== "changed" && r.category !== "changedType" && r.category !== "deleted",
  ).length;

  // ── subsystem rollup (deterministic: first two path segments) ─
  let clusters: Cluster[] | null = null;
  if (impactRows > ROLLUP_THRESHOLD) {
    const groups = new Map<string, Cluster>();
    for (const r of ordered) {
      if (r.category === "changed" || r.category === "changedType") continue;
      const path = pathBucket(r.file);
      const c = groups.get(path) ?? {
        path, total: 0, runtime: 0, type: 0, tests: 0, refs: 0, warn: 0, maxDepth: 0, plateIds: [],
      };
      c.total++;
      c.plateIds.push(r.id);
      if (r.category === "direct" || r.category === "transitive" || r.category === "deleted") c.runtime++;
      else if (r.category === "type") c.type++;
      else if (r.category === "test") c.tests++;
      else c.refs++;
      if (r.warnings.length) c.warn++;
      if (r.depth !== Number.MAX_SAFE_INTEGER) c.maxDepth = Math.max(c.maxDepth, r.depth);
      groups.set(path, c);
    }
    clusters = [...groups.values()].sort((x, y) => y.total - x.total || x.path.localeCompare(y.path));
  }

  const plates = ordered.map((r, i) => toSpecimen(r, i + 1, a));
  const byId = new Map(plates.map((p) => [p.id, p]));

  const repoPath = a.repo.root.replace(/\\/g, "/");
  return {
    plates,
    byId,
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

/* ------------------------------------------------------------------ */
/* row → plate                                                         */
/* ------------------------------------------------------------------ */

const IMPACT_LABEL: Record<PlateCategory, string> = {
  changed: "CHANGED",
  changedType: "CHANGED TYPE",
  deleted: "DELETED",
  direct: "DIRECT",
  transitive: "TRANSITIVE",
  type: "TYPE",
  test: "TEST",
  reference: "REFERENCE",
  uncertain: "UNCERTAIN",
};

const IMPACT_KEY: Record<PlateCategory, ImpactKey> = {
  changed: "changed",
  changedType: "changed",
  deleted: "deleted",
  direct: "direct",
  transitive: "transitive",
  type: "type",
  test: "test",
  reference: "reference",
  uncertain: "uncertain",
};

function descriptionFor(r: Row): string {
  switch (r.category) {
    case "changed":
      if (r.changeKind === "added") return `Introduced in the working tree at ${r.file}.`;
      if (r.changeKind === "renamed" && r.changedInfo?.renamedFrom)
        return `Renamed from ${r.changedInfo.renamedFrom.name} in ${r.changedInfo.renamedFrom.file}.`;
      return "Modified in the working tree.";
    case "changedType":
      return "Type contract modified in the working tree — erased at runtime, so impact is compile-time only.";
    case "deleted": {
      const n = r.formerCallers?.length ?? 0;
      return `Removed from the working tree; ${n} former caller${n === 1 ? "" : "s"} reconstructed from the base revision.`;
    }
    case "type": {
      const root = r.paths[0]?.rootLabel;
      return root
        ? `Consumes the changed type ${root} via type_depends evidence — compile-time only.`
        : "Consumes a changed type contract — compile-time impact only.";
    }
    case "test":
      return "Deterministically connected to changed or affected symbols — not a coverage claim.";
    case "reference": {
      const parent = firstIncoming(r);
      return parent
        ? `Related by ${parent.rel} to ${parent.label} — impact is not proven.`
        : "Related to an affected symbol, but no evidence proves impact reaches it.";
    }
    default: {
      const rels = r.paths[0]?.edges.map((e) => e.rel) ?? [];
      const n = rels.length;
      return rels.length
        ? `Reached from a changed root through ${n} proven runtime edge${n === 1 ? "" : "s"}: ${rels.join(" → ")}.`
        : "Reached from a changed root through runtime evidence.";
    }
  }
}

function firstIncoming(r: Row): { label: string; rel: RelKind } | undefined {
  const p = r.paths[0];
  if (p && p.steps.length > 1) {
    const e = p.edges[p.edges.length - 1];
    return { label: p.steps[p.steps.length - 2].label, rel: e?.rel ?? "references" };
  }
  return r.incoming[0] ? { label: r.incoming[0].label, rel: r.incoming[0].rel } : undefined;
}

function noteFor(r: Row): string {
  switch (r.category) {
    case "changed":
      return "this is a changed root";
    case "changedType":
      return "changed type root — no runtime propagation";
    case "deleted":
      return "present at base, absent in the working tree";
    case "direct":
      return "depends on changed runtime code";
    case "transitive":
      return `reached through ${r.depth} hop${r.depth === 1 ? "" : "s"}`;
    case "type":
      return "compile-time contract consumer";
    case "test":
      return "deterministically connected";
    case "reference":
      return "related, but impact not proven";
    default:
      return "";
  }
}

function evidenceHopsFor(r: Row): EvidenceHop[] {
  const hops: EvidenceHop[] = [];
  const num = (i: number) => String(i + 1).padStart(2, "0");
  const site = (e?: PathEdgeView) => {
    const s = e?.evidence[0];
    return s ? `${s.file.split("/").pop()}:${s.line}` : undefined;
  };

  if (r.paths.length > 0) {
    const p = r.paths[0];
    p.steps.forEach((s, i) => {
      const e = i > 0 ? p.edges[i - 1] : undefined;
      hops.push({
        n: num(i),
        name: s.label,
        rel: i === 0 ? "git_diff" : e?.rel ?? "references",
        note: i === 0 ? "origin" : site(e) ?? s.file,
        root: i === 0,
      });
    });
    return hops;
  }

  // Roots and non-path plates — fan-out / former callers / via lists.
  hops.push({ n: "01", name: r.label, rel: r.category === "deleted" ? "removed" : "git_diff", note: r.file, root: true });
  const out = r.category === "deleted"
    ? (r.formerCallers ?? []).map((c) => ({ label: c.name, rel: "former-caller", file: c.file }))
    : r.category === "test"
      ? (r.testVia ?? []).map((v) => ({ label: v.symbol, rel: v.edgeKind, file: r.file }))
      : (r.fanout ?? []).map((f) => ({ label: f.label, rel: f.rel, file: f.file, line: f.line }));
  out.slice(0, 6).forEach((f, i) =>
    hops.push({ n: num(i + 1), name: f.label, rel: f.rel, note: "line" in f && f.line ? `${f.file.split("/").pop()}:${f.line}` : f.file }),
  );
  return hops;
}

function confidenceFor(r: Row): string {
  if (r.category === "reference") return "reference only";
  if (r.category === "deleted") return "inferred";
  if (r.confidence) return r.confidence;
  return "proven";
}

function evidenceFootFor(r: Row): string {
  switch (r.category) {
    case "changed":
    case "changedType":
      return "relationships are deterministic · root";
    case "deleted":
      return "reconstructed from the base revision — call sites will not resolve";
    case "type":
      return "compile-time derivation · type_depends";
    case "test":
      return "test boundary · deterministic link, not coverage";
    case "reference":
      return "reference only · not proven reachable";
    default: {
      const roots = r.roots.length;
      return roots > 1
        ? `reachable from ${roots} changed roots · depth ${r.depth}`
        : `reachable from ${r.paths[0]?.rootLabel ?? "a changed root"} · depth ${r.depth}`;
    }
  }
}

function sourceWindowFor(r: Row): { start: number; end: number } | undefined {
  // Prefer the symbol's own new-side range; fall back to its def line.
  const ev = r.changedInfo?.evidence.find((e) => e.newRange)?.newRange;
  if (ev) return { start: Math.max(1, ev.start - 2), end: ev.end + 3 };
  if (r.line !== undefined) return { start: Math.max(1, r.line - 4), end: r.line + 8 };
  return undefined;
}

function markLinesFor(r: Row): number[] {
  const lines: number[] = [];
  for (const e of r.changedInfo?.evidence ?? []) {
    if (e.newRange) for (let n = e.newRange.start; n < e.newRange.end; n++) lines.push(n);
  }
  if (!lines.length && r.line !== undefined) lines.push(r.line);
  return lines;
}

function displayRange(r: Row): string {
  const ev = r.changedInfo?.evidence.find((e) => e.newRange)?.newRange;
  if (ev) return fmtRange(ev);
  const old = r.changedInfo?.evidence.find((e) => e.oldRange)?.oldRange;
  if (old) return fmtRange(old);
  return r.line !== undefined ? `L${r.line}` : "—";
}

function toSpecimen(r: Row, idx: number, a: AnalysisResult): Specimen {
  const impact = IMPACT_LABEL[r.category];
  return {
    id: r.id,
    num: String(idx).padStart(2, "0"),
    name: r.label,
    impact,
    impactKey: IMPACT_KEY[r.category],
    category: r.category,
    note: noteFor(r),
    description: descriptionFor(r),
    file: r.file,
    range: displayRange(r),
    depth: r.depth === Number.MAX_SAFE_INTEGER ? "—" : `d${r.depth}`,
    confidence: confidenceFor(r),
    subsystem: pathBucket(r.file),
    roots: String(r.roots.length),
    edges: r.paths[0]?.edges.length ?? r.incoming.length,
    status: impact.toLowerCase(),
    evidenceFoot: evidenceFootFor(r),
    evidence: evidenceHopsFor(r),
    extraPaths: r.paths.slice(1),
    sourceFile: r.file,
    sourceRange: sourceWindowFor(r),
    markLines: markLinesFor(r),
    diffs: toDiffs(r.changedInfo, a),
    warning: r.warnings.length > 0,
    warningCodes: r.warnings,
    paths: r.paths,
    incoming: r.incoming,
    changedInfo: r.changedInfo,
    deletedInfo: r.deletedInfo,
    testVia: r.testVia,
    refRel: r.refRel,
    typeOnly: r.typeOnly,
    changeKind: r.changeKind,
    kind: r.kind,
    depthN: r.depth,
  };
}

/** WHY heading per category — semantic, never "details". */
export function whyTitle(s: Specimen): string {
  const n = s.name.toUpperCase();
  switch (s.category) {
    case "changed":
    case "changedType":
      return `WHY IS ${n} CHANGED`;
    case "deleted":
      return `WHY WAS ${n} DELETED — AND WHAT USED TO DEPEND ON IT`;
    case "type":
      return `WHY IS ${n} TYPE-AFFECTED`;
    case "test":
      return `WHY IS ${n} A RELEVANT TEST`;
    case "reference":
      return `WHY IS ${n} ONLY A REFERENCE`;
    default:
      return `WHY IS ${n} AFFECTED`;
  }
}
