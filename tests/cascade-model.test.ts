import { describe, expect, it } from "vitest";
import {
  ROLLUP_THRESHOLD,
  buildCascade,
  relevantHunks,
  tombstoneId,
  whyTitle,
} from "../explorer/src/cascade/model.js";
import type { AnalysisResult, AffectedJson } from "../explorer/src/types.js";

const RANGE = { startLine: 10, startChar: 0, endLine: 11, endChar: 1 };

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

describe("cascade model — tier mapping", () => {
  it("maps every analysis bucket to its tier in canonical order", () => {
    const a = base({
      changed: [{ id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] }],
      direct: [affected({ id: "d1", name: "fnB()", roots: ["c1"], depth: 1 })],
      transitive: [affected({ id: "t1", name: "fnC()", roots: ["c1"], depth: 2 })],
      typeImpact: { direct: [affected({ id: "ty1", name: "mkA()", depth: 1, roots: ["ty"] })], transitive: [] },
      deleted: [{ name: "gone()", file: "src/g.ts", formerCallers: [{ id: "fc", name: "useG()", file: "src/u.ts" }], resolved: true }],
      referencing: [{ id: "r1", name: "App()", kind: "function", file: "src/App.tsx", edgeKind: "references", targetId: "t1" }],
      tests: [{ file: "tests/a.test.ts", via: [{ testId: "tid", symbol: "fnB()", symbolId: "d1", edgeKind: "calls" }] }],
    });
    const m = buildCascade(a);
    expect(m.tiers.map((t) => t.id)).toEqual([
      "changed", "deleted", "direct", "transitive", "type", "tests", "references",
    ]);
    expect(m.tiers[0].rows.map((r) => r.label)).toEqual(["fnA()"]);
    expect(m.tiers[1].rows[0].id).toBe(tombstoneId("src/g.ts", "gone()"));
    expect(m.tiers[2].rows[0].label).toBe("fnB()");
    expect(m.tiers[3].rows[0].label).toBe("fnC()");
    expect(m.tiers[4].rows[0].label).toBe("mkA()");
    expect(m.tiers[5].rows[0].label).toBe("a.test.ts");
    expect(m.tiers[6].rows[0].label).toBe("App()");
  });

  it("keeps runtime membership when a node is both runtime- and type-affected", () => {
    const a = base({
      direct: [affected({ id: "x", name: "both()", depth: 1 })],
      typeImpact: { direct: [], transitive: [affected({ id: "x", name: "both()", depth: 3 })] },
    });
    const m = buildCascade(a);
    expect(m.byId.get("x")!.tier).toBe("direct");
  });

  it("deleted rows carry former-caller evidence + tombstone semantics", () => {
    const a = base({
      deleted: [{ name: "gone()", file: "src/g.ts", formerCallers: [{ id: "fc", name: "useG()", file: "src/u.ts" }], resolved: false }],
    });
    const row = buildCascade(a).byId.get(tombstoneId("src/g.ts", "gone()"))!;
    expect(row.tier).toBe("deleted");
    expect(row.deletedInfo!.formerCallers[0].name).toBe("useG()");
    expect(row.deletedInfo!.resolved).toBe(false);
    expect(whyTitle(row)).toContain("DELETED");
  });
});

describe("cascade model — evidence paths", () => {
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

  it("immediate parent is the final hop, evidence grouped by line", () => {
    const a = base({
      changed: [{ id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] }],
      transitive: [affected({ id: "t1", name: "Share()", file: "src/c.tsx", roots: ["c1"], depth: 2, paths: [path] })],
    });
    const row = buildCascade(a).byId.get("t1")!;
    expect(row.parent!.label).toBe("fnB()");
    expect(row.parent!.rel).toBe("jsx_uses");
    expect(row.parent!.line).toBe(21);
    expect(row.evidence).toHaveLength(1);
    expect(row.evidence[0].rel).toBe("jsx_uses");

    const mid = row.incoming[0];
    expect(mid.label).toBe("fnB()");
    expect(mid.rel).toBe("jsx_uses");
  });

  it("groups two call sites on one line into one visual row (presentation dedup)", () => {
    const callsPath = {
      root: "c1",
      nodes: [
        { id: "c1", name: "fnA()", file: "src/a.ts" },
        { id: "d1", name: "fnB()", file: "src/b.ts" },
      ],
      edges: [path.edges[0]],
    };
    const a = base({
      changed: [{ id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] }],
      direct: [affected({ id: "d1", name: "fnB()", roots: ["c1"], depth: 1, paths: [callsPath] })],
    });
    const row = buildCascade(a).byId.get("d1")!;
    // the edge into d1 is `calls` at src/b.ts:10 with 2 sites on the same line
    expect(row.evidence).toHaveLength(1);
    expect(row.evidence[0].sites).toHaveLength(2);
    expect(row.evidence[0].line).toBe(10);
  });

  it("multi-root nodes keep one row with all paths", () => {
    const p2 = { ...path, root: "c2", nodes: [{ id: "c2", name: "fnZ()", file: "src/z.ts" }, { id: "d1", name: "fnB()", file: "src/b.ts" }], edges: [path.edges[0]] };
    const a = base({
      changed: [
        { id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] },
        { id: "c2", name: "fnZ()", kind: "function", file: "src/z.ts", changeKind: "modified", evidence: [] },
      ],
      direct: [affected({ id: "d1", name: "fnB()", roots: ["c1", "c2"], depth: 1, paths: [path, p2] })],
    });
    const row = buildCascade(a).byId.get("d1")!;
    expect(row.roots.map((r) => r.label)).toEqual(["fnA()", "fnZ()"]);
    expect(row.paths).toHaveLength(2);
  });
});

describe("cascade model — warnings, tests, references", () => {
  it("attaches warnings to rows by file or symbol", () => {
    const a = base({
      changed: [{ id: "c1", name: "fnA()", kind: "function", file: "src/a.ts", changeKind: "modified", evidence: [] }],
      warnings: [{ code: "BINARY_SKIPPED", message: "m", file: "src/a.ts" }],
    });
    expect(buildCascade(a).byId.get("c1")!.warnings).toEqual(["BINARY_SKIPPED"]);
  });

  it("groups test via-edges into one test row", () => {
    const a = base({
      tests: [{
        file: "tests/m.test.ts",
        via: [
          { testId: "tid", symbol: "a()", symbolId: "x", edgeKind: "calls" },
          { testId: "tid", symbol: "b()", symbolId: "y", edgeKind: "references" },
        ],
      }],
    });
    const m = buildCascade(a);
    const testsTier = m.tiers.find((t) => t.id === "tests")!;
    expect(testsTier.rows).toHaveLength(1);
    expect(testsTier.rows[0].testVia).toHaveLength(2);
    expect(whyTitle(testsTier.rows[0])).toContain("RELEVANT TEST");
  });

  it("references rows carry their unproven relationship", () => {
    const a = base({
      transitive: [affected({ id: "t1", name: "Share()", depth: 2 })],
      referencing: [{ id: "r1", name: "App()", kind: "function", file: "src/App.tsx", edgeKind: "imports", targetId: "t1" }],
    });
    const row = buildCascade(a).byId.get("r1")!;
    expect(row.tier).toBe("references");
    expect(row.refRel).toBe("imports");
    expect(row.parent!.label).toBe("Share()");
    expect(whyTitle(row)).toContain("ONLY A REFERENCE");
  });
});

describe("cascade model — large rollup", () => {
  it("rolls up by deterministic path bucket above the threshold", () => {
    const tr = Array.from({ length: ROLLUP_THRESHOLD + 1 }, (_, i) =>
      affected({ id: `n${i}`, name: `f${i}()`, file: i % 2 ? `src/auth/x${i}.ts` : `src/api/y${i}.ts`, depth: i % 5 }),
    );
    const m = buildCascade(base({ transitive: tr }));
    expect(m.clusters).not.toBeNull();
    const paths = m.clusters!.map((c) => c.path);
    expect(paths).toContain("src/auth");
    expect(paths).toContain("src/api");
    expect(m.clusters!.reduce((n, c) => n + c.total, 0)).toBe(ROLLUP_THRESHOLD + 1);
    for (const c of m.clusters!) expect(c.rowIds).toHaveLength(c.total);
  });

  it("stays flat under the threshold", () => {
    const m = buildCascade(base({ direct: [affected({ id: "x", name: "a()" })] }));
    expect(m.clusters).toBeNull();
  });
});

describe("cascade model — hunks", () => {
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
});
