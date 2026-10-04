import type { AnalysisResult, AffectedJson, SourceRange } from "./types";

/** Visual categories — the engine's node states, not invented semantics. */
export type Category =
  | "changed"
  | "deleted"
  | "direct"
  | "transitive"
  | "type-affected"
  | "test"
  | "referencing";

export interface VMNode {
  id: string;
  label: string;
  kind: string;
  file: string;
  range?: SourceRange;
  category: Category;
  changeKind?: string;
  depth: number;
  /** Changed-root ids that reach this node (multi-root provenance). */
  roots: string[];
  paths: AffectedJson["paths"];
  changedInfo?: AnalysisResult["changed"][number];
  deletedInfo?: AnalysisResult["deleted"][number];
}

export interface VMEdge {
  id: string;
  /** Canvas direction: changed → affected (impact flows downstream). */
  source: string;
  target: string;
  kind: string;
  confidence?: string;
  weak: boolean; // references / former-caller — drawn dashed
  evidence: { file: string; range: SourceRange; source: string; detail?: string }[];
}

export interface ViewModel {
  nodes: VMNode[];
  edges: VMEdge[];
  byId: Map<string, VMNode>;
  /** Root id → ids of every node+edge that root's impact reaches. */
  focusSet: Map<string, { nodes: Set<string>; edges: Set<string> }>;
}

/** Synthetic id matching the mapper's tombstone keying. */
export function tombstoneId(file: string, name: string): string {
  return `deleted:${file}:${name}`;
}

export function buildViewModel(a: AnalysisResult): ViewModel {
  const nodes = new Map<string, VMNode>();
  const edges = new Map<string, VMEdge>();
  const focus = new Map<string, { nodes: Set<string>; edges: Set<string> }>();
  const addEdge = (e: VMEdge) => {
    const key = `${e.source}\n${e.target}\n${e.kind}`;
    if (!edges.has(key)) edges.set(key, { ...e, id: key });
    return key;
  };
  const focusFor = (rootId: string) => {
    let f = focus.get(rootId);
    if (!f) {
      f = { nodes: new Set([rootId]), edges: new Set() };
      focus.set(rootId, f);
    }
    return f;
  };

  // Changed + deleted roots.
  for (const c of a.changed) {
    const id = c.id ?? tombstoneId(c.file, c.name);
    const isDeleted = c.changeKind === "deleted";
    nodes.set(id, {
      id,
      label: c.name,
      kind: c.kind,
      file: c.file,
      range: undefined,
      category: isDeleted ? "deleted" : "changed",
      changeKind: c.changeKind,
      depth: 0,
      roots: [id],
      paths: [],
      changedInfo: c,
      deletedInfo: a.deleted.find((d) => d.name === c.name && d.file === c.file),
    });
    focusFor(id);
  }

  const putAffected = (list: AffectedJson[], category: Category) => {
    for (const af of list) {
      const existing = nodes.get(af.id);
      const vm: VMNode = existing ?? {
        id: af.id,
        label: af.name,
        kind: af.kind,
        file: af.file,
        range: af.range,
        category,
        depth: af.depth,
        roots: af.roots,
        paths: af.paths,
      };
      if (existing) {
        existing.depth = Math.min(existing.depth, af.depth);
        for (const r of af.roots) if (!existing.roots.includes(r)) existing.roots.push(r);
        existing.paths = af.paths;
      } else {
        nodes.set(af.id, vm);
      }
      // Canvas edges: impact flows callee→caller, so draw to→from.
      for (const p of af.paths) {
        for (const e of p.edges) {
          const key = addEdge({
            id: "",
            source: e.to,
            target: e.from,
            kind: e.kind,
            confidence: e.confidence,
            weak: false,
            evidence: e.evidence,
          });
          const f = focusFor(p.root);
          f.nodes.add(af.id);
          f.edges.add(key);
        }
      }
    }
  };
  putAffected(a.direct, "direct");
  putAffected(a.transitive, "transitive");
  // The engine already excludes runtime-affected ids from the type sets;
  // putAffected keeps any existing category on overlap, so runtime wins.
  putAffected(a.typeImpact.direct, "type-affected");
  putAffected(a.typeImpact.transitive, "type-affected");

  // Test nodes — linked via the test node's edge to the affected symbol.
  for (const t of a.tests) {
    for (const v of t.via) {
      if (!nodes.has(v.testId)) {
        nodes.set(v.testId, {
          id: v.testId,
          label: t.file.split("/").pop() ?? t.file,
          kind: "test",
          file: t.file,
          category: "test",
          depth: Number.MAX_SAFE_INTEGER,
          roots: [],
          paths: [],
        });
      }
      addEdge({
        id: "",
        source: v.symbolId,
        target: v.testId,
        kind: v.edgeKind,
        weak: v.edgeKind !== "calls",
        evidence: [],
      });
      // A test belongs to the focus set of every root reaching its target.
      const target = nodes.get(v.symbolId);
      for (const r of target?.roots ?? []) focusFor(r).nodes.add(v.testId);
    }
  }

  // Referencing-only nodes — dashed, never "affected".
  for (const r of a.referencing) {
    if (!nodes.has(r.id)) {
      nodes.set(r.id, {
        id: r.id,
        label: r.name,
        kind: r.kind,
        file: r.file,
        category: "referencing",
        depth: Number.MAX_SAFE_INTEGER,
        roots: [],
        paths: [],
      });
    }
    addEdge({
      id: "",
      source: r.targetId,
      target: r.id,
      kind: r.edgeKind,
      weak: true,
      evidence: [],
    });
  }

  // Deleted symbols: former callers (from the base graph) as dashed edges.
  for (const d of a.deleted) {
    const id = tombstoneId(d.file, d.name);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: d.name,
        kind: "function",
        file: d.file,
        category: "deleted",
        changeKind: "deleted",
        depth: 0,
        roots: [id],
        paths: [],
        deletedInfo: d,
      });
    }
    for (const c of d.formerCallers) {
      const key = addEdge({
        id: "",
        source: id,
        target: c.id,
        kind: "former-caller",
        weak: true,
        evidence: [],
      });
      // Former callers are affected BY the deletion — focus subgraph for it.
      const f = focusFor(id);
      f.nodes.add(c.id);
      f.edges.add(key);
      if (!nodes.has(c.id)) {
        nodes.set(c.id, {
          id: c.id,
          label: c.name,
          kind: "function",
          file: c.file,
          category: "direct",
          depth: 1,
          roots: [id],
          paths: [],
        });
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], byId: nodes, focusSet: focus };
}

/** Ids a changed root can reach — for "Focus this change". */
export function reachableFrom(vm: ViewModel, rootId: string): Set<string> {
  const f = vm.focusSet.get(rootId);
  return f ? f.nodes : new Set([rootId]);
}
