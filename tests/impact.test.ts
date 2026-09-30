import { describe, expect, it } from "vitest";
import { impact, type ImpactResult } from "../src/impact/traverse.js";
import { fixtureGraph } from "./helpers.js";

const names = (list: { node: { name: string } }[]) => list.map((a) => a.node.name);
const nodeNames = (list: { name: string }[]) => list.map((n) => n.name);
const files = (result: ImpactResult) => result.relevantTests.map((t) => t.file);
const refNames = (result: ImpactResult) =>
  result.referencing.map((r) => r.node.name);

describe("fixtures/basic — main chain", () => {
  const load = async () => impact(await fixtureGraph("basic"), ["refreshSession"]);

  it("marks the changed symbol", async () => {
    expect(nodeNames((await load()).changed)).toEqual(["refreshSession()"]);
  });

  it("finds the direct caller", async () => {
    expect(names((await load()).direct)).toEqual(["authenticateRequest()"]);
  });

  it("finds transitive callers", async () => {
    expect(names((await load()).transitive)).toEqual(
      expect.arrayContaining(["checkout()", "completePayment()"]),
    );
  });

  it("does NOT implicate the unrelated notification chain", async () => {
    const result = await load();
    const all = [
      ...nodeNames(result.changed),
      ...names(result.direct),
      ...names(result.transitive),
    ];
    expect(all).not.toContain("sendNotification()");
    expect(all).not.toContain("formatNotification()");
  });

  it("maps relevant tests through graph relationships", async () => {
    expect(files(await load())).toEqual(
      expect.arrayContaining([
        "src/tests/auth.test.ts",
        "src/tests/checkout.test.ts",
      ]),
    );
  });

  it("retains a concrete evidence path for the deepest impact", async () => {
    const result = await load();
    const deepest = result.transitive.find(
      (a) => a.node.name === "completePayment()",
    );
    expect(deepest).toBeDefined();
    const pathNames = deepest!.path.map((id) =>
      id.split("/").pop()!.replace(/\.$/, ""),
    );
    expect(pathNames).toEqual([
      "refreshSession()",
      "authenticateRequest()",
      "checkout()",
      "completePayment()",
    ]);
    expect(deepest!.depth).toBe(3);
    for (const edge of deepest!.edges) {
      expect(edge.kind).toBe("calls");
      expect(edge.evidence.length).toBeGreaterThan(0);
      expect(edge.evidence[0].file).toMatch(/\.ts$/);
    }
  });
});

describe("fixtures/linear — A→B→C", () => {
  it("change C: B direct, A transitive", async () => {
    const result = impact(await fixtureGraph("linear"), ["c"]);
    expect(names(result.direct)).toEqual(["b()"]);
    expect(names(result.transitive)).toEqual(["a()"]);
  });
});

describe("fixtures/disconnected — A→B, C→D", () => {
  it("only the connected component is affected", async () => {
    const result = impact(await fixtureGraph("disconnected"), ["b"]);
    expect(names(result.direct)).toEqual(["a()"]);
    expect(names(result.transitive)).toEqual([]);
    const all = [...names(result.direct), ...names(result.transitive)];
    expect(all).not.toContain("c()");
    expect(all).not.toContain("d()");
  });
});

describe("fixtures/cycle — A→B→C→A", () => {
  it("terminates deterministically without duplicates", async () => {
    const result = impact(await fixtureGraph("cycle"), ["cycleA"]);
    expect(names(result.direct)).toEqual(["cycleC()"]);
    expect(names(result.transitive)).toEqual(["cycleB()"]);
    const ids = [
      ...result.direct.map((a) => a.node.id),
      ...result.transitive.map((a) => a.node.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("fixtures/alias — import { computeTotal as totalWithTax }", () => {
  it("resolves the aliased call to the real symbol", async () => {
    const graph = await fixtureGraph("alias");
    const result = impact(graph, ["computeTotal"]);
    expect(names(result.direct)).toEqual(["priceForDisplay()"]);
    const edge = result.direct[0].edges[0];
    expect(edge.kind).toBe("calls");
    expect(edge.to).toContain("computeTotal().");
  });
});

describe("fixtures/reexport — export { foo } from './foo'", () => {
  it("resolves through the re-export to the underlying symbol", async () => {
    const result = impact(await fixtureGraph("reexport"), ["renderToken"]);
    expect(names(result.direct)).toEqual(["consumer()"]);
    expect(result.direct[0].edges[0].to).toContain("`foo.ts`/renderToken().");
  });
});

describe("fixtures/barrel — import through index.ts", () => {
  it("identifies the underlying symbol relationship", async () => {
    const result = impact(await fixtureGraph("barrel"), ["normalizePath"]);
    expect(names(result.direct)).toEqual(["consumer()"]);
    expect(result.direct[0].edges[0].to).toContain("`foo.ts`/normalizePath().");
  });
});

describe("fixtures/methods — session.refresh()", () => {
  it("resolves the method call to Session#refresh()", async () => {
    const result = impact(await fixtureGraph("methods"), ["Session#refresh()"]);
    expect(names(result.direct)).toEqual(
      expect.arrayContaining(["handleRequest()", "handleTyped()"]),
    );
  });

  it("interface dispatch: caller typed to the interface is flagged on implementer change", async () => {
    // handleTyped calls Refresher#refresh; Session#refresh implements it.
    const result = impact(await fixtureGraph("methods"), ["Session#refresh()"]);
    const typed = result.direct.find((a) => a.node.name === "handleTyped()");
    expect(typed).toBeDefined();
    expect(typed!.edges[0].kind).toBe("calls");
    expect(typed!.edges[0].to).toContain("Refresher#refresh().");
  });

  it("interface change propagates to implementer then caller", async () => {
    const result = impact(await fixtureGraph("methods"), ["Refresher#refresh()"]);
    expect(names(result.direct)).toEqual(
      expect.arrayContaining(["Session#refresh()", "handleTyped()"]),
    );
    expect(names(result.transitive)).toEqual(["handleRequest()"]);
  });
});

describe("fixtures/async — await fetchSession()", () => {
  it("resolves normally as a call", async () => {
    const result = impact(await fixtureGraph("async"), ["fetchSession"]);
    expect(names(result.direct)).toEqual(["handleAsyncRequest()"]);
    expect(result.direct[0].edges[0].kind).toBe("calls");
  });
});

describe("fixtures/callbacks — run(loadSession)", () => {
  it("is NOT reported as a call", async () => {
    const result = impact(await fixtureGraph("callbacks"), ["loadSession"]);
    expect(names(result.direct)).toEqual([]);
    expect(names(result.transitive)).toEqual([]);
  });

  it("is preserved as a references edge with evidence", async () => {
    const result = impact(await fixtureGraph("callbacks"), ["loadSession"]);
    expect(refNames(result)).toContain("runSessionLoad()");
    const ref = result.referencing.find(
      (r) => r.node.name === "runSessionLoad()",
    )!;
    expect(ref.edge.kind).toBe("references");
    expect(ref.edge.evidence[0].detail).toBe("identifier");
  });
});

describe("fixtures/unused — import without call", () => {
  it("a referencing function is not flagged as call-affected", async () => {
    const result = impact(await fixtureGraph("unused"), ["expensiveHelper"]);
    expect(names(result.direct)).toEqual([]);
    expect(names(result.transitive)).toEqual([]);
    expect(refNames(result)).toContain("helperIsReferenced()");
    expect(refNames(result)).toContain("consumer.ts");
  });
});

describe("fixtures/jsinterop — .js caller of .ts function", () => {
  it("resolves across the language boundary", async () => {
    const result = impact(await fixtureGraph("jsinterop"), ["tokenize"]);
    expect(names(result.direct)).toEqual(["runTokenizer()"]);
    expect(result.direct[0].node.file).toBe("src/driver.js");
  });
});

describe("graph integrity across all fixtures", () => {
  const fixtureNames = [
    "basic",
    "linear",
    "disconnected",
    "cycle",
    "alias",
    "reexport",
    "barrel",
    "methods",
    "callbacks",
    "async",
    "unused",
    "jsinterop",
  ];
  for (const name of fixtureNames) {
    it(`${name}: every edge carries evidence`, async () => {
      const graph = await fixtureGraph(name);
      for (const edge of graph.edges) {
        expect(
          edge.evidence.length,
          `${edge.from} -${edge.kind}-> ${edge.to}`,
        ).toBeGreaterThan(0);
        for (const ev of edge.evidence) {
          expect(ev.file.length).toBeGreaterThan(0);
          expect(ev.source).toMatch(/scip|typescript-ast/);
        }
      }
    });
  }
});
