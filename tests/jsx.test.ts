import { describe, expect, it } from "vitest";
import { impact } from "../src/impact/traverse.js";
import { classifyFile } from "../src/indexers/enrich/call-classifier.js";
import { fixtureGraph } from "./helpers.js";

const names = (list: { node: { name: string } }[]) => list.map((a) => a.node.name);

describe("jsx tag classification (AST-only)", () => {
  const src = [
    `export function App() {`,
    `  return (`,
    `    <main>`,
    `      <Panel></Panel>`,
    `      <UI.Button label="y" />`,
    `      <widgets.helper />`,
    `      <span />`,
    `    </main>`,
    `  );`,
    `}`,
  ].join("\n");

  it("records component tags, skips intrinsics and lowercase members", () => {
    const { jsxTagRanges } = classifyFile("app.tsx", src);
    // Panel (open+close), Button in UI.Button — 3 tag ranges
    expect(jsxTagRanges.size).toBe(3);
  });

  it("never records intrinsic or lowercase-member tags", () => {
    const { jsxTagRanges } = classifyFile("app.tsx", src);
    for (const key of jsxTagRanges) {
      // range keys are startLine:startChar:endLine:endChar, 0-based
      const [ls, cs, , ce] = key.split(":").map(Number);
      const text = src.split("\n")[ls].slice(cs, ce);
      expect(["Panel", "Button"]).toContain(text);
    }
  });
});

describe("fixtures/jsx — jsx_uses edges", () => {
  const load = () => fixtureGraph("jsx");

  it("<Foo /> and <Foo></Foo> create jsx_uses edges to the component", async () => {
    const g = await load();
    const jsxEdges = g.edges.filter((e) => e.kind === "jsx_uses");
    const pairs = jsxEdges.map((e) => `${g.node(e.from)!.name}→${g.node(e.to)!.name}`);
    expect(pairs).toContain("Panel()→Button()");
    expect(pairs).toContain("App()→Panel()");
  });

  it("imported alias <Btn /> resolves to the real component", async () => {
    const g = await load();
    const jsxEdges = g.edges.filter((e) => e.kind === "jsx_uses");
    const targets = jsxEdges
      .filter((e) => g.node(e.from)!.name === "App()")
      .map((e) => g.node(e.to)!.name);
    expect(targets).toContain("Button()");
  });

  it("member JSX <UI.Button /> resolves when provable", async () => {
    const g = await load();
    const jsxEdges = g.edges.filter((e) => e.kind === "jsx_uses");
    const member = jsxEdges.find(
      (e) => g.node(e.from)!.name === "App()" && g.node(e.to)!.name === "Button()",
    );
    expect(member).toBeDefined();
  });

  it("intrinsic/lowercase tags produce no jsx_uses edges", async () => {
    const g = await load();
    for (const e of g.edges.filter((e) => e.kind === "jsx_uses")) {
      const toName = g.node(e.to)!.name;
      expect(toName).not.toBe("span");
      expect(toName).not.toBe("div");
      expect(toName).not.toBe("helper");
      expect(toName).not.toBe("widgets");
    }
  });

  it("JSX impact propagates runtime-affected upstream", async () => {
    const g = await load();
    const r = impact(g, ["Button"]);
    expect(names(r.direct)).toContain("Panel()");
    expect(names(r.direct)).toContain("App()");
  });

  it("jsx_uses evidence is a real source range", async () => {
    const g = await load();
    const edge = g.edges.find(
      (e) => e.kind === "jsx_uses" && g.node(e.to)!.name === "Button()",
    );
    expect(edge).toBeDefined();
    expect(edge!.evidence.length).toBeGreaterThan(0);
    expect(edge!.evidence[0].detail).toBe("jsx-element");
    expect(edge!.evidence[0].file).toContain(".tsx");
  });
});
