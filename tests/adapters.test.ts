import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detectProjects, planForRepo } from "../src/indexers/registry.js";
import { TypeScriptJavaScriptAdapter } from "../src/indexers/typescript/adapter.js";
import { mergeGraphs, type GraphFragment } from "../src/graph/merge.js";
import { RippleGraph } from "../src/graph/graph.js";
import { commitFingerprint, repoFingerprint } from "../src/cache/fingerprint.js";
import { impactNodes } from "../src/impact/traverse.js";
import type { Evidence } from "../src/graph/types.js";

const tmpDirs: string[] = [];
function tmpRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ripple-adapter-test-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const ev = (file: string): Evidence => ({
  file,
  range: { startLine: 0, startChar: 0, endLine: 0, endChar: 1 },
  source: "scip",
  detail: "test",
});

function fakeFragment(
  projectId: string,
  adapterId: string,
  projectRoot: string,
  build: (g: RippleGraph) => void,
): GraphFragment {
  const g = new RippleGraph(projectRoot);
  build(g);
  return { projectId, adapterId, projectRoot, graph: g };
}

describe("adapter detection", () => {
  const adapter = new TypeScriptJavaScriptAdapter();

  it("detects a TypeScript project with config evidence", () => {
    const dir = tmpRepo({
      "tsconfig.json": "{}",
      "src/app.ts": "export const a = 1;",
    });
    const projects = adapter.detect(dir);
    expect(projects).toHaveLength(1);
    expect(projects[0].adapter.id).toBe("typescript-javascript");
    expect(projects[0].root).toBe("");
    expect(projects[0].languages).toEqual(["typescript", "javascript"]);
    expect(projects[0].evidence).toContain("tsconfig.json");
    expect(projects[0].projectId).toBe("typescript-javascript:.");
  });

  it("detects a JavaScript-only project", () => {
    const dir = tmpRepo({ "src/util.js": "module.exports = {};" });
    expect(adapter.detect(dir)).toHaveLength(1);
  });

  it("claims nothing in a Python-only repo — unsupported stays honest", () => {
    const dir = tmpRepo({
      "pyproject.toml": "[project]",
      "app/main.py": "def main(): pass",
    });
    expect(adapter.detect(dir)).toHaveLength(0);
    expect(detectProjects(dir)).toHaveLength(0);
    expect(planForRepo(dir)).toBeUndefined();
  });

  it("exposes honest capabilities", () => {
    expect(adapter.capabilities).toEqual({
      definitions: true,
      references: true,
      calls: true,
      types: true,
      inheritance: true,
      implementations: true,
      tests: true,
      jsx: true,
    });
  });
});

describe("cache-key isolation", () => {
  it("different adapter sets produce different fingerprints", () => {
    const dir = tmpRepo({ "a.ts": "export const a = 1;" });
    const ts = repoFingerprint(dir, {
      adapters: [{ id: "typescript-javascript", version: "1" }],
    });
    const py = repoFingerprint(dir, {
      adapters: [{ id: "python", version: "1" }],
    });
    const multi = repoFingerprint(dir, {
      adapters: [
        { id: "typescript-javascript", version: "1" },
        { id: "python", version: "1" },
      ],
    });
    expect(ts.key).not.toBe(py.key);
    expect(ts.key).not.toBe(multi.key);
    expect(py.key).not.toBe(multi.key);
    // Order-independent.
    const multiReversed = repoFingerprint(dir, {
      adapters: [
        { id: "python", version: "1" },
        { id: "typescript-javascript", version: "1" },
      ],
    });
    expect(multiReversed.key).toBe(multi.key);
  });

  it("adapter version participates in commit fingerprints", () => {
    const a = commitFingerprint("abc123", { adapters: [{ id: "x", version: "1" }] });
    const b = commitFingerprint("abc123", { adapters: [{ id: "x", version: "2" }] });
    expect(a.key).not.toBe(b.key);
  });
});

describe("mergeGraphs", () => {
  const FRAG_A = () =>
    fakeFragment("fake-ts:frontend", "fake-ts", "frontend", (g) => {
      g.addNode({ id: "A#save", kind: "function", name: "User.save", file: "user.ts" });
      g.addNode({ id: "A#caller", kind: "function", name: "handler", file: "handler.ts" });
      g.addEdge("A#caller", "A#save", "calls", ev("handler.ts"));
    });
  const FRAG_B = () =>
    fakeFragment("fake-py:api", "fake-py", "api", (g) => {
      g.addNode({ id: "A#save", kind: "function", name: "User.save", file: "user.py" });
      g.addNode({ id: "B#route", kind: "function", name: "route", file: "routes.py" });
      g.addEdge("B#route", "A#save", "calls", ev("routes.py"));
    });

  it("keeps colliding ids namespaced and edges inside their fragments", () => {
    const merged = mergeGraphs("/repo", [FRAG_A(), FRAG_B()]);
    expect(merged.node("fake-ts:frontend::A#save")?.file).toBe("frontend/user.ts");
    expect(merged.node("fake-py:api::A#save")?.file).toBe("api/user.py");
    // Same display name, different symbols — no identity confusion.
    expect(merged.findByName("User.save")).toHaveLength(2);
    // Edges stayed inside their own fragment.
    expect(merged.outEdges("A#caller", ["calls"])[0].to).toBe("fake-ts:frontend::A#save");
    expect(merged.outEdges("B#route", ["calls"])[0].to).toBe("fake-py:api::A#save");
    // No edge crosses fragments.
    expect(merged.outEdges("A#caller").every((e) => !e.to.startsWith("fake-py"))).toBe(true);
    // Provenance retained on both sides of the collision.
    expect(merged.node("fake-ts:frontend::A#save")?.provenance?.project).toBe("fake-ts:frontend");
    expect(merged.node("fake-py:api::A#save")?.provenance?.adapter).toBe("fake-py");
  });

  it("does not namespace ids that only one fragment defines", () => {
    const merged = mergeGraphs("/repo", [FRAG_A(), FRAG_B()]);
    expect(merged.node("A#caller")).toBeDefined();
    expect(merged.node("B#route")).toBeDefined();
  });

  it("is deterministic", () => {
    const a = mergeGraphs("/repo", [FRAG_B(), FRAG_A()]);
    const b = mergeGraphs("/repo", [FRAG_A(), FRAG_B()]);
    const shape = (g: RippleGraph) => ({
      nodes: g.nodes.map((n) => n.id).sort(),
      edges: g.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort(),
    });
    expect(shape(a)).toEqual(shape(b));
  });

  it("impact never jumps languages without an explicit edge", () => {
    const merged = mergeGraphs("/repo", [FRAG_A(), FRAG_B()]);
    const seeds = merged.findByName("User.save").filter(
      (n) => n.provenance?.project === "fake-py:api",
    );
    const res = impactNodes(merged, seeds);
    const impacted = [...res.direct, ...res.transitive].map((a) => a.node.id);
    // Only the python caller — the identically-named TS symbol is untouched.
    expect(impacted).toEqual(["B#route"]);
  });

  it("an explicit bridge edge is the ONLY cross-language path", () => {
    const merged = mergeGraphs("/repo", [FRAG_A(), FRAG_B()]);
    // Explicit adapter-emitted bridge: TS caller → Python symbol.
    merged.addEdge("A#caller", "fake-py:api::A#save", "calls", {
      file: "frontend/api.gen.ts",
      range: { startLine: 3, startChar: 0, endLine: 3, endChar: 8 },
      source: "scip",
      detail: "openapi-generated-client",
    });
    const pySave = merged.findByName("User.save").filter(
      (n) => n.provenance?.project === "fake-py:api",
    );
    const res = impactNodes(merged, pySave);
    const impacted = new Set([...res.direct, ...res.transitive].map((a) => a.node.id));
    // Cross-language propagation happens only through the explicit edge.
    expect(impacted).toEqual(new Set(["B#route", "A#caller"]));
    const bridgeEdge = merged
      .outEdges("A#caller", ["calls"])
      .find((e) => e.to === "fake-py:api::A#save");
    expect(bridgeEdge?.evidence[0].detail).toBe("openapi-generated-client");
  });

  it("stamps provenance on every merged node", () => {
    const merged = mergeGraphs("/repo", [FRAG_A()]);
    expect(merged.nodes.every((n) => n.provenance?.adapter === "fake-ts")).toBe(true);
    expect(merged.nodes.every((n) => n.provenance?.project === "fake-ts:frontend")).toBe(true);
  });
});
