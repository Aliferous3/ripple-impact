import { describe, expect, it } from "vitest";
import {
  ROLLUP_THRESHOLD,
  buildSpecimen,
  relevantHunks,
  tombstoneId,
  whyTitle,
} from "../explorer/src/specimen/model.js";
import type { AnalysisResult, AffectedJson } from "../explorer/src/types.js";

function affected(o: Partial<AffectedJson> & { id: string; name: string }): AffectedJson {
  return { kind: "function", file: "src/a.ts", depth: 1, roots: [], paths: [], ...o };
}

function base(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    schemaVersion: 2,
    repo: { root: "/repo/app", fingerprint: "fp" },
    comparison: { oldRev: "abc123def", newRev: "working tree" },
    changed: [],
    direct: [],
    transitive: [],
    typeImpact: { direct: [], transitive: [] },
    deleted: [],
    referencing: [],
    tests: [],
    nonSemantic: [],
    unmappedFiles: [],
    renamedFiles: [],
    diffFiles: [],
    warnings: [],
    timings: { gitDiffMs: 0, indexMs: 0, mapMs: 0, traverseMs: 0, fingerprintMs: 0, totalMs: 42 },
    cache: { index: "hit", graph: "hit", baseGraph: "not-required", enrichedFiles: 0, missReason: "" },
    ...over,
  };
}

describe("specimen model — plate ordering + categories", () => {
  it("orders plates changed → deleted → direct → transitive → type → test → reference", () => {
    const a = base({
      changed: [{ id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] }],
      direct: [affected({ id: "d1", name: "fnB()", roots: ["c1"], depth: 1 })],
      transitive: [affected({ id: "t1", name: "fnC()", roots: ["c1"], depth: 2 })],
      typeImpact: { direct: [affected({ id: "ty1", name: "mkA()", depth: 1, roots: ["c1"] })], transitive: [] },
      deleted: [{ name: "gone()", file: "src/g.ts", formerCallers: [{ id: "fc", name: "useG()", file: "src/u.ts" }], resolved: true }],
      referencing: [{ id: "r1", name: "App()", kind: "function", file: "src/App.tsx", edgeKind: "references", targetId: "t1" }],
      tests: [{ file: "tests/a.test.ts", via: [{ testId: "tid", symbol: "fnB()", symbolId: "d1", edgeKind: "calls" }] }],
    });
    const m = buildSpecimen(a);
    expect(m.plates.map((p) => p.category)).toEqual([
      "changed", "deleted", "direct", "transitive", "type", "test", "reference",
    ]);
    expect(m.plates.map((p) => p.impact)).toEqual([
      "CHANGED", "DELETED", "DIRECT", "TRANSITIVE", "TYPE", "TEST", "REFERENCE",
    ]);
    expect(m.plates.map((p) => p.num)).toEqual(["01", "02", "03", "04", "05", "06", "07"]);
  });

  it("labels type-only changed roots as CHANGED TYPE", () => {
    const a = base({
      changed: [{ id: "c1", name: "types.ts (module scope)", kind: "module", file: "src/types.ts", changeKind: "modified", typeOnly: true, evidence: [] }],
    });
    const p = buildSpecimen(a).plates[0];
    expect(p.category).toBe("changedType");
    expect(p.impact).toBe("CHANGED TYPE");
    expect(p.typeOnly).toBe(true);
    expect(p.description).toContain("compile-time");
  });

  it("keeps runtime membership when a node is both runtime- and type-affected", () => {
    const a = base({
      direct: [affected({ id: "x", name: "both()", depth: 1 })],
      typeImpact: { direct: [], transitive: [affected({ id: "x", name: "both()", depth: 3 })] },
    });
    const m = buildSpecimen(a);
    expect(m.plates).toHaveLength(1);
    expect(m.plates[0].category).toBe("direct");
  });

  it("deduplicates references already present as impact plates", () => {
    const a = base({
      direct: [affected({ id: "d1", name: "fnB()", depth: 1 })],
      referencing: [{ id: "d1", name: "fnB()", kind: "function", file: "src/a.ts", edgeKind: "references", targetId: "x" }],
    });
    const m = buildSpecimen(a);
    expect(m.plates).toHaveLength(1);
    expect(m.plates[0].category).toBe("direct");
  });
});

describe("specimen model — evidence paths", () => {
  const path = {
    root: "c1",
    nodes: [
      { id: "c1", name: "fnA()", file: "src/a.ts" },
      { id: "d1", name: "fnB()", file: "src/b.ts" },
      { id: "t1", name: "Share()", file: "src/c.tsx" },
    ],
    edges: [
      {
        from: "d1", to: "c1", kind: "calls", confidence: "certain",
        evidence: [
          { file: "src/b.ts", range: { startLine: 9, startChar: 2, endLine: 9, endChar: 12 }, source: "typescript-ast", detail: "call-site" },
          { file: "src/b.ts", range: { startLine: 9, startChar: 40, endLine: 9, endChar: 50 }, source: "typescript-ast", detail: "call-site" },
        ],
      },
      {
        from: "t1", to: "d1", kind: "jsx_uses", confidence: "certain",
        evidence: [{ file: "src/c.tsx", range: { startLine: 20, startChar: 4, endLine: 20, endChar: 11 }, source: "typescript-ast", detail: "jsx-element" }],
      },
    ],
  };

  it("evidence path is root-first with verbatim relationship labels", () => {
    const a = base({
      changed: [{ id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] }],
      transitive: [affected({ id: "t1", name: "Share()", file: "src/c.tsx", roots: ["c1"], depth: 2, paths: [path] })],
    });
    const p = buildSpecimen(a).byId.get("t1")!;
    expect(p.evidence.map((h) => h.name)).toEqual(["fnA()", "fnB()", "Share()"]);
    expect(p.evidence[0].root).toBe(true);
    expect(p.evidence[0].rel).toBe("git_diff");
    expect(p.evidence[1].rel).toBe("calls");
    expect(p.evidence[1].note).toBe("b.ts:10");
    expect(p.evidence[2].rel).toBe("jsx_uses"); // never renamed to "calls"
    expect(p.evidence[2].note).toBe("c.tsx:21");
    expect(p.edges).toBe(2);
    expect(p.confidence).toBe("proven");
  });

  it("groups duplicate same-line evidence (presentation dedup only)", () => {
    const callsPath = { ...path, nodes: path.nodes.slice(0, 2), edges: [path.edges[0]] };
    const a = base({
      changed: [{ id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] }],
      direct: [affected({ id: "d1", name: "fnB()", roots: ["c1"], depth: 1, paths: [callsPath] })],
    });
    const p = buildSpecimen(a).byId.get("d1")!;
    expect(p.incoming[0].evidence).toHaveLength(1);
    expect(p.incoming[0].evidence[0].sites).toHaveLength(2);
  });

  it("multi-root plates keep every causal path", () => {
    const p2 = { ...path, root: "c2", nodes: [{ id: "c2", name: "fnZ()", file: "src/z.ts" }, { id: "d1", name: "fnB()", file: "src/b.ts" }], edges: [path.edges[0]] };
    const a = base({
      changed: [
        { id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] },
        { id: "c2", name: "fnZ()", kind: "function", file: "src/z.ts", changeKind: "modified", evidence: [] },
      ],
      direct: [affected({ id: "d1", name: "fnB()", roots: ["c1", "c2"], depth: 1, paths: [path, p2] })],
    });
    const p = buildSpecimen(a).byId.get("d1")!;
    expect(p.roots).toBe("2");
    expect(p.paths).toHaveLength(2);
    expect(p.extraPaths).toHaveLength(1);
    expect(p.extraPaths[0].rootLabel).toBe("fnZ()");
    expect(p.description).toContain("calls");
  });
});

describe("specimen model — deleted, tests, references, warnings", () => {
  it("deleted plates carry former callers and inferred confidence", () => {
    const a = base({
      deleted: [{ name: "gone()", file: "src/g.ts", formerCallers: [{ id: "fc", name: "useG()", file: "src/u.ts" }], resolved: false }],
    });
    const p = buildSpecimen(a).byId.get(tombstoneId("src/g.ts", "gone()"))!;
    expect(p.category).toBe("deleted");
    expect(p.impact).toBe("DELETED");
    expect(p.confidence).toBe("inferred");
    expect(p.deletedInfo!.formerCallers[0].name).toBe("useG()");
    expect(p.evidence.map((h) => h.rel)).toEqual(["removed", "former-caller"]);
    expect(p.description).toContain("former caller");
    expect(whyTitle(p)).toContain("DELETED");
  });

  it("test plates expose connected symbols", () => {
    const a = base({
      tests: [{
        file: "tests/m.test.ts",
        via: [
          { testId: "tid", symbol: "a()", symbolId: "x", edgeKind: "calls" },
          { testId: "tid", symbol: "b()", symbolId: "y", edgeKind: "references" },
        ],
      }],
    });
    const p = buildSpecimen(a).plates[0];
    expect(p.category).toBe("test");
    expect(p.testVia).toHaveLength(2);
    expect(p.evidence[1].rel).toBe("calls");
    expect(whyTitle(p)).toContain("RELEVANT TEST");
  });

  it("reference plates are marked reference-only", () => {
    const a = base({
      transitive: [affected({ id: "t1", name: "Share()", depth: 2 })],
      referencing: [{ id: "r1", name: "App()", kind: "function", file: "src/App.tsx", edgeKind: "imports", targetId: "t1" }],
    });
    const p = buildSpecimen(a).byId.get("r1")!;
    expect(p.category).toBe("reference");
    expect(p.confidence).toBe("reference only");
    expect(p.refRel).toBe("imports");
    expect(p.depth).toBe("—");
    expect(whyTitle(p)).toContain("ONLY A REFERENCE");
  });

  it("attaches warnings to plates by file or symbol", () => {
    const a = base({
      changed: [{ id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] }],
      warnings: [{ code: "BINARY_SKIPPED", message: "m", file: "src/a.ts" }],
    });
    const p = buildSpecimen(a).byId.get("c1")!;
    expect(p.warning).toBe(true);
    expect(p.warningCodes).toEqual(["BINARY_SKIPPED"]);
  });

  it("weak edge confidence surfaces on the plate instead of 'proven'", () => {
    const weakPath = {
      root: "c1",
      nodes: [{ id: "c1", name: "fnA()", file: "src/a.ts" }, { id: "d1", name: "fnB()", file: "src/b.ts" }],
      edges: [{ from: "d1", to: "c1", kind: "calls", confidence: "inferred", evidence: [] }],
    };
    const a = base({
      changed: [{ id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] }],
      direct: [affected({ id: "d1", name: "fnB()", roots: ["c1"], depth: 1, paths: [weakPath] })],
    });
    const p = buildSpecimen(a).byId.get("d1")!;
    expect(p.confidence).toBe("inferred");
  });
});

describe("specimen model — large surface + empty", () => {
  it("clusters deterministically by path bucket above the threshold", () => {
    const tr = Array.from({ length: ROLLUP_THRESHOLD + 1 }, (_, i) =>
      affected({ id: `n${i}`, name: `f${i}()`, file: i % 2 ? `src/auth/x${i}.ts` : `src/api/y${i}.ts`, depth: i % 5 }),
    );
    const m = buildSpecimen(base({ transitive: tr }));
    expect(m.clusters).not.toBeNull();
    const paths = m.clusters!.map((c) => c.path);
    expect(paths).toContain("src/auth");
    expect(paths).toContain("src/api");
    expect(m.clusters!.reduce((n, c) => n + c.total, 0)).toBe(ROLLUP_THRESHOLD + 1);
    expect(m.plates).toHaveLength(ROLLUP_THRESHOLD + 1);
  });

  it("stays flat under the threshold and empty on a clean tree", () => {
    expect(buildSpecimen(base({ direct: [affected({ id: "x", name: "a()" })] })).clusters).toBeNull();
    const empty = buildSpecimen(base());
    expect(empty.plates).toHaveLength(0);
    expect(empty.impactRows).toBe(0);
  });
});

describe("specimen model — hunks + metadata", () => {
  it("relevantHunks picks diff hunks overlapping evidence ranges", () => {
    const a = base({
      diffFiles: [{
        path: "src/a.ts", status: "modified", binary: false,
        hunks: [
          { oldRange: { start: 5, end: 8 }, newRange: { start: 5, end: 8 }, removedLines: ["x"], addedLines: ["y"] },
          { oldRange: { start: 50, end: 55 }, newRange: { start: 50, end: 55 }, removedLines: ["p"], addedLines: ["q"] },
        ],
      }],
    });
    const c = {
      id: "c1", name: "f()", kind: "function", file: "src/a.ts", changeKind: "modified" as const,
      evidence: [{ file: "src/a.ts", oldRange: { start: 51, end: 53 }, newRange: { start: 51, end: 53 } }],
    };
    const h = relevantHunks(c, a);
    expect(h).toHaveLength(1);
    expect(h[0].hunk.oldRange.start).toBe(50);
  });

  it("changed plates carry real diffs + marked lines; no fabricated amplitude", () => {
    const a = base({
      changed: [{
        id: "c1", name: "f()", kind: "function", file: "src/a.ts", changeKind: "modified",
        evidence: [{ file: "src/a.ts", oldRange: { start: 51, end: 53 }, newRange: { start: 51, end: 53 } }],
      }],
      diffFiles: [{
        path: "src/a.ts", status: "modified", binary: false,
        hunks: [{ oldRange: { start: 50, end: 55 }, newRange: { start: 50, end: 55 }, removedLines: ["p"], addedLines: ["q"] }],
      }],
    });
    const p = buildSpecimen(a).plates[0];
    expect(p.diffs).toHaveLength(1);
    expect(p.diffs[0].added).toEqual(["q"]);
    expect(p.markLines).toEqual([51, 52]);
    expect(p.range).toBe("L51–L52");
    expect(p.sourceRange).toEqual({ start: 49, end: 56 });
    expect(p.subsystem).toBe("src/a.ts");
    expect(metaKeys(p)).not.toContain("AMPLITUDE");
  });
});

function metaKeys(p: object): string[] {
  return Object.keys(p);
}
