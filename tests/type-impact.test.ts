import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { RippleGraph } from "../src/graph/graph.js";
import type { GraphNode } from "../src/graph/types.js";
import { impactNodes } from "../src/impact/traverse.js";
import { diffImpact } from "../src/changes/pipeline.js";

// ---------------------------------------------------------------------------
// Unit level: hand-built graphs prove the traversal contract — type_depends
// propagates only into the type sets, runtime sets win on overlap, and type
// impact never leaks into calls/implements reach.
// ---------------------------------------------------------------------------

function node(id: string, kind: GraphNode["kind"] = "function"): GraphNode {
  return {
    id,
    name: id,
    kind,
    file: `${id}.ts`,
    range: { startLine: 0, startChar: 0, endLine: 1, endChar: 0 },
  };
}

function graphWith(edges: [string, string, string][]): RippleGraph {
  const g = new RippleGraph("/repo");
  for (const [from, to, kind] of edges) {
    g.addNode(node(from));
    g.addNode(node(to, kind === "type_depends" ? "interface" : "function"));
    g.addEdge(
      from,
      to,
      kind as never,
      { file: "x.ts", range: { startLine: 0, startChar: 0, endLine: 0, endChar: 1 }, source: "typescript-ast" },
      "certain",
    );
  }
  return g;
}

describe("type-impact traversal (hand-built graphs)", () => {
  it("type_depends edge → consumer is type-affected, not runtime-affected", () => {
    const g = graphWith([["renderUser", "User", "type_depends"]]);
    const r = impactNodes(g, [g.node("User")!]);
    expect(r.direct).toHaveLength(0);
    expect(r.typeDirect.map((a) => a.node.id)).toEqual(["renderUser"]);
    expect(r.typeTransitive).toHaveLength(0);
  });

  it("type chains propagate transitively through type_depends only", () => {
    const g = graphWith([
      ["Profile", "User", "type_depends"],
      ["renderProfile", "Profile", "type_depends"],
    ]);
    const r = impactNodes(g, [g.node("User")!]);
    expect(r.typeDirect.map((a) => a.node.id)).toEqual(["Profile"]);
    expect(r.typeTransitive.map((a) => a.node.id)).toEqual(["renderProfile"]);
    expect(r.typeTransitive[0].depth).toBe(2);
  });

  it("runtime reachability wins over type on overlap", () => {
    const g = graphWith([
      ["C", "User", "calls"],
      ["C", "User", "type_depends"],
    ]);
    const r = impactNodes(g, [g.node("User")!]);
    expect(r.direct.map((a) => a.node.id)).toEqual(["C"]);
    expect(r.typeDirect).toHaveLength(0);
  });

  it("callers of a type-affected node are NOT implicated (conservative boundary)", () => {
    // User changed → renderUser type-affected. handleRequest calls renderUser,
    // but type impact does not travel down calls edges.
    const g = graphWith([
      ["renderUser", "User", "type_depends"],
      ["handleRequest", "renderUser", "calls"],
    ]);
    const r = impactNodes(g, [g.node("User")!]);
    expect(r.typeDirect.map((a) => a.node.id)).toEqual(["renderUser"]);
    expect(r.direct).toHaveLength(0);
    expect(r.transitive).toHaveLength(0);
    expect(r.typeTransitive).toHaveLength(0);
  });

  it("type-affected provenance carries witness paths and evidence", () => {
    const g = graphWith([["renderUser", "User", "type_depends"]]);
    const r = impactNodes(g, [g.node("User")!]);
    const a = r.typeDirect[0];
    expect(a.roots).toEqual(["User"]);
    const p = a.pathsByRoot["User"];
    expect(p.path).toEqual(["User", "renderUser"]);
    expect(p.edges[0].kind).toBe("type_depends");
    expect(p.edges[0].evidence[0].file).toBe("x.ts");
  });

  it("references/imports still never propagate", () => {
    const g = graphWith([
      ["r1", "User", "references"],
      ["r2", "User", "imports"],
    ]);
    const r = impactNodes(g, [g.node("User")!]);
    expect(r.direct).toHaveLength(0);
    expect(r.typeDirect).toHaveLength(0);
    expect(r.referencing.map((x) => x.node.id).sort()).toEqual(["r1", "r2"]);
  });
});

// ---------------------------------------------------------------------------
// Integration: real SCIP index over a scratch git repo. A type-only diff must
// surface type-affected consumers — and ONLY real consumers.
// ---------------------------------------------------------------------------

const REPO = join(tmpdir(), "ripple-t3-types");

function git(...args: string[]): string {
  return execFileSync("git", ["-C", REPO, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function commitAll(msg: string): string {
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg);
  return git("rev-parse", "HEAD");
}

const TYPES_V1 = `export interface User {
  name: string;
}
export interface Profile {
  user: User;
}
`;

const TYPES_V2 = `export interface User {
  name: string;
  email: string;
}
export interface Profile {
  user: User;
}
`;

const FILES: Record<string, string> = {
  "src/types.ts": TYPES_V1,
  // consumes User via `import type` in a param annotation
  "src/render.ts": `import type { User } from "./types";
export function renderUser(u: User): string {
  return u.name;
}
`,
  // consumes Profile (transitive type path to User) via a regular import
  "src/viewer.ts": `import { type Profile } from "./types";
export function renderProfile(p: Profile): string {
  return p.user.name;
}
`,
  // imports User but never uses it — must NOT be type-affected
  "src/unused.ts": `import type { User } from "./types";
export const unusedMarker = 1;
`,
  // consumes User only in a return-type position via a value import
  "src/factory.ts": `import { makeUser } from "./helpers";
export function build(name: string) {
  return makeUser(name);
}
`,
  "src/helpers.ts": `import type { User } from "./types";
export function makeUser(name: string): User {
  return { name };
}
`,
  // satisfies / as-position usage
  "src/config.ts": `import type { User } from "./types";
export const defaultUser = { name: "d" } satisfies User;
`,
  // implements a changed interface → runtime implements edge + type edge
  "src/impl.ts": `import type { User } from "./types";
export class UserView implements Pick<User, "name"> {
  name = "";
}
`,
};

let baseSha = "";

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(join(REPO, "src"), { recursive: true });
  writeFileSync(
    join(REPO, "package.json"),
    JSON.stringify({ name: "type-impact-fixture", version: "0.0.1", type: "module" }),
  );
  writeFileSync(
    join(REPO, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["src"],
    }),
  );
  for (const [f, src] of Object.entries(FILES)) {
    writeFileSync(join(REPO, f), src);
  }
  git("init", "-q", REPO);
  baseSha = commitAll("base");
}, 60_000);

describe("type-impact integration (real SCIP + git diff)", () => {
  it("interface field change → real consumers type-affected, nothing runtime-affected", async () => {
    writeFileSync(join(REPO, "src/types.ts"), TYPES_V2);
    const head = commitAll("add email field");

    const r = await diffImpact({ repo: REPO, base: baseSha });

    // The changed symbol is the added member; the interface seeds type
    // propagation because a member change IS a shape change.
    expect(r.changeSet.changed.map((c) => c.name)).toContain("User#email");
    // No calls/implements path from User — runtime sets must stay empty.
    expect(r.impact.direct).toHaveLength(0);
    expect(r.impact.transitive).toHaveLength(0);

    const typeNames = [
      ...r.impact.typeDirect.map((a) => a.node.name),
      ...r.impact.typeTransitive.map((a) => a.node.name),
    ];
    // Real consumers of User:
    expect(typeNames).toContain("renderUser()");   // param annotation (import type)
    expect(typeNames).toContain("makeUser()");     // return annotation
    expect(typeNames).toContain("Profile");        // interface member type
    // `satisfies` lands outside defaultUser's SCIP enclosing_range, so the
    // edge is honestly attributed to the module node.
    expect(typeNames).toContain("config.ts");      // satisfies (module attr.)
    // Transitive: renderProfile consumes Profile which consumes User.
    expect(typeNames).toContain("renderProfile()");

    // Every reported type-affected node must carry evidence + provenance.
    const renderUser = [...r.impact.typeDirect, ...r.impact.typeTransitive]
      .find((a) => a.node.name === "renderUser()")!;
    expect(renderUser.roots.length).toBeGreaterThan(0);
    const pathEdges = renderUser.pathsByRoot[renderUser.roots[0]].edges;
    // Path: User#email --contains--> User --type_depends--> renderUser
    expect(pathEdges.map((e) => e.kind)).toContain("type_depends");
    const typeEdge = pathEdges.find((e) => e.kind === "type_depends")!;
    expect(typeEdge.evidence[0].source).toBe("typescript-ast");
    expect(typeEdge.evidence[0].range.startLine).toBeGreaterThanOrEqual(0);
    void head;
  }, 60_000);

  it("unused `import type` does NOT type-affect the module (negative)", async () => {
    const r = await diffImpact({ repo: REPO, base: baseSha });
    const all = [
      ...r.impact.direct,
      ...r.impact.transitive,
      ...r.impact.typeDirect,
      ...r.impact.typeTransitive,
    ];
    expect(all.map((a) => a.node.name)).not.toContain("unusedMarker");
    // And no file-node type impact for src/unused.ts.
    expect(
      all.filter((a) => a.node.file.endsWith("unused.ts")),
    ).toHaveLength(0);
  }, 60_000);

  it("unrelated non-consumer of the module is NOT implicated", async () => {
    // factory.ts calls makeUser — it consumes helpers.ts at runtime, not
    // User at type level. A User change must not type-affect it.
    const r = await diffImpact({ repo: REPO, base: baseSha });
    const all = [
      ...r.impact.direct,
      ...r.impact.transitive,
      ...r.impact.typeDirect,
      ...r.impact.typeTransitive,
    ];
    expect(all.map((a) => a.node.name)).not.toContain("build()");
  }, 60_000);

  it("type edges carry file/range evidence and deterministic detail", async () => {
    const { getGraphForRepo } = await import("../src/cache/graph.js");
    const { graph } = await getGraphForRepo(REPO);
    const edges = graph.edges.filter((e) => e.kind === "type_depends");
    expect(edges.length).toBeGreaterThanOrEqual(5);
    for (const e of edges) {
      expect(e.evidence.length).toBeGreaterThan(0);
      expect(e.confidence).toBe("certain");
      expect(e.evidence[0].source).toBe("typescript-ast");
      expect(e.evidence[0].file).toMatch(/\.ts$/);
    }
    // No type edge may originate from an import specifier position — i.e.
    // the unused.ts module must have zero outgoing type_depends edges.
    const unusedFile = graph.nodes.find((n) => n.file.endsWith("unused.ts") && n.kind === "file")!;
    const unusedSyms = graph.nodes
      .filter((n) => n.file.endsWith("unused.ts"))
      .map((n) => n.id);
    for (const e of edges) {
      expect(unusedSyms).not.toContain(e.from);
      expect(e.from).not.toBe(unusedFile.id);
    }
  }, 60_000);
});
