import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitFingerprint, repoFingerprint } from "../src/cache/fingerprint.js";
import { RippleCache } from "../src/cache/store.js";
import { getGraphForRepo } from "../src/cache/graph.js";
import { graphFromData, graphToData, RippleGraph } from "../src/graph/graph.js";
import {
  GRAPH_SCHEMA_VERSION,
  InvalidGraphArtifact,
  validateGraphArtifact,
} from "../src/graph/serialize.js";
import { diffImpact } from "../src/changes/pipeline.js";
import { analyzeRepository, analyzeSymbol, API_SCHEMA_VERSION } from "../src/api/analyze.js";
import { impactNodes } from "../src/impact/traverse.js";
import { fixtureGraph } from "./helpers.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const TMP = join(tmpdir(), "ripple-t1-tests");

// ---------------------------------------------------------------------------
// Scratch repo: c1 has exported helper() + local `temporary` inside process();
// c2 deletes helper() and removes the local. Exercises tombstones, deleted-local
// attribution, and automatic base graphs.
// ---------------------------------------------------------------------------
const REPO = join(TMP, "scratch");
const PROC_V1 = `export function helper(): string {
  return "h";
}

export function process(): string {
  const temporary = "tmp";
  return temporary.toUpperCase() + helper();
}

export function caller(): string {
  return process();
}
`;
const PROC_V2 = `export function process(): string {
  return "TMP";
}

export function caller(): string {
  return process();
}
`;
const OTHER_TS = `export function unrelated(): number {
  return 1;
}
`;

// Second repo: duplicate symbol names for selector-disambiguation tests.
const AMBIG = join(TMP, "ambig");

function commitAll(msg: string): string {
  git(REPO, "add", "-A");
  git(REPO, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg);
  return git(REPO, "rev-parse", "HEAD").trim();
}

function sha256FileTree(repo: string): Map<string, string> {
  const files = git(repo, "ls-files").split("\n").filter(Boolean).sort();
  const out = new Map<string, string>();
  for (const f of files) {
    out.set(f, createHash("sha256").update(readFileSync(join(repo, f))).digest("hex"));
  }
  return out;
}

let baseSha = "";

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(REPO, "src"), { recursive: true });
  writeFileSync(
    join(REPO, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "es2020" } }),
  );
  writeFileSync(join(REPO, "package.json"), JSON.stringify({ name: "scratch", version: "1.0.0" }));
  writeFileSync(join(REPO, "src", "proc.ts"), PROC_V1);
  writeFileSync(join(REPO, "src", "other.ts"), OTHER_TS);
  git(REPO, "init", "-q");
  baseSha = commitAll("c1");
  writeFileSync(join(REPO, "src", "proc.ts"), PROC_V2);
  commitAll("c2");

  mkdirSync(join(AMBIG, "src"), { recursive: true });
  writeFileSync(join(AMBIG, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  writeFileSync(join(AMBIG, "src", "a.ts"), "export function helper(): string { return 'a'; }\n");
  writeFileSync(join(AMBIG, "src", "b.ts"), "export function helper(): string { return 'b'; }\n");
}, 30_000);

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
describe("graph serialization", () => {
  it("roundtrips and produces identical impact results", async () => {
    const graph = await fixtureGraph("basic");
    const data = graphToData(graph);
    expect(data.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
    const revived = graphFromData(validateGraphArtifact(JSON.parse(JSON.stringify(data))));

    expect(revived.nodes.length).toBe(graph.nodes.length);
    expect(revived.edges.length).toBe(graph.edges.length);
    const before = impactNodes(graph, graph.findByName("checkout"));
    const after = impactNodes(revived, revived.findByName("checkout"));
    expect(after.direct.map((a) => a.node.id).sort())
      .toEqual(before.direct.map((a) => a.node.id).sort());
    expect(after.transitive.map((a) => a.node.id).sort())
      .toEqual(before.transitive.map((a) => a.node.id).sort());
  });

  it("rejects wrong schemaVersion and malformed payloads", () => {
    const data = graphToData(new RippleGraph("r"));
    expect(() => validateGraphArtifact({ ...data, schemaVersion: 999 }))
      .toThrow(InvalidGraphArtifact);
    expect(() => validateGraphArtifact({ ...data, nodes: "nope" }))
      .toThrow(InvalidGraphArtifact);
    expect(() => validateGraphArtifact({ ...data, edges: [{ from: 1 }] }))
      .toThrow(InvalidGraphArtifact);
    expect(() => validateGraphArtifact(null)).toThrow(InvalidGraphArtifact);
  });
});

// --------------------------------------------------------------------------
describe("content-addressed cache", () => {
  it("cold miss → warm hit with identical graph", async () => {
    const cold = await getGraphForRepo(REPO);
    expect(cold.status).toBe("miss");
    const warm = await getGraphForRepo(REPO);
    expect(warm.status).toBe("hit");
    expect(warm.enrichedFiles).toBe(0);
    expect(warm.loadMs).toBeLessThan(cold.loadMs);
    expect(warm.graph.nodes.length).toBe(cold.graph.nodes.length);
    expect(warm.graph.edges.length).toBe(cold.graph.edges.length);
  });

  it("source-file edit invalidates; README edit does not", async () => {
    const fp1 = repoFingerprint(REPO);
    writeFileSync(join(REPO, "README.md"), "# scratch\n");
    expect(repoFingerprint(REPO).key).toBe(fp1.key); // non-source → same key
    const hit = await getGraphForRepo(REPO);
    expect(hit.status).toBe("hit");

    writeFileSync(join(REPO, "src", "other.ts"), OTHER_TS + "\nexport function extra() {}\n");
    const fp2 = repoFingerprint(REPO);
    expect(fp2.key).not.toBe(fp1.key);
    expect((await getGraphForRepo(REPO)).status).toBe("miss");
    expect((await getGraphForRepo(REPO)).status).toBe("hit");
  });

  it("tsconfig and lockfile changes invalidate", async () => {
    const fp = repoFingerprint(REPO);
    writeFileSync(join(REPO, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: false } }));
    expect(repoFingerprint(REPO).key).not.toBe(fp.key);
    expect((await getGraphForRepo(REPO)).status).toBe("miss");

    const fp2 = repoFingerprint(REPO);
    writeFileSync(join(REPO, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    expect(repoFingerprint(REPO).key).not.toBe(fp2.key);
    expect((await getGraphForRepo(REPO)).status).toBe("miss");
  });

  it("commit fingerprints are keyed by immutable SHA", () => {
    const a = commitFingerprint(baseSha);
    const b = commitFingerprint(baseSha);
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(commitFingerprint(git(REPO, "rev-parse", "HEAD")).key);
    expect(a.detail.schemaVersion).toBe(GRAPH_SCHEMA_VERSION);
  });
});

// --------------------------------------------------------------------------
describe("cache corruption", () => {
  function entryDir(): string {
    const fp = repoFingerprint(REPO);
    return join(REPO, ".ripple", "cache", fp.key);
  }

  it("truncated graph.json → miss + rebuild", async () => {
    expect((await getGraphForRepo(REPO)).status).toBe("hit");
    const dir = entryDir();
    const p = join(dir, "graph.json");
    const raw = readFileSync(p, "utf8");
    writeFileSync(p, raw.slice(0, raw.length / 2));
    const probe = new RippleCache(REPO).load(repoFingerprint(REPO));
    expect(probe.status).toBe("miss");
    expect((await getGraphForRepo(REPO)).status).toBe("miss"); // rebuilt
    expect((await getGraphForRepo(REPO)).status).toBe("hit");
  });

  it("invalid JSON → miss", async () => {
    const dir = entryDir();
    writeFileSync(join(dir, "graph.json"), "{not json");
    const probe = new RippleCache(REPO).load(repoFingerprint(REPO));
    expect(probe.status).toBe("miss");
    expect(probe.reason).toBe("invalid JSON");
    expect((await getGraphForRepo(REPO)).status).toBe("miss");
  });

  it("wrong schemaVersion in metadata → miss", async () => {
    await getGraphForRepo(REPO);
    const dir = entryDir();
    const metaPath = join(dir, "metadata.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.schemaVersion = 999;
    writeFileSync(metaPath, JSON.stringify(meta));
    const probe = new RippleCache(REPO).load(repoFingerprint(REPO));
    expect(probe.status).toBe("miss");
    expect(probe.reason).toBe("schema-mismatch");
    expect((await getGraphForRepo(REPO)).status).toBe("miss");
  });

  it("missing metadata.json → miss; missing index.scip → miss", async () => {
    await getGraphForRepo(REPO);
    const dir = entryDir();
    rmSync(join(dir, "metadata.json"));
    expect(new RippleCache(REPO).load(repoFingerprint(REPO)).status).toBe("miss");
    expect((await getGraphForRepo(REPO)).status).toBe("miss");

    rmSync(join(dir, "index.scip"));
    const probe = new RippleCache(REPO).load(repoFingerprint(REPO));
    expect(probe.status).toBe("miss");
    expect(probe.reason).toBe("missing index.scip");
    expect((await getGraphForRepo(REPO)).status).toBe("miss");
    expect((await getGraphForRepo(REPO)).status).toBe("hit");
  });
});

// --------------------------------------------------------------------------
describe("concurrency", () => {
  it("two parallel cold loads leave a valid single cache entry", async () => {
    const fp = repoFingerprint(REPO);
    rmSync(join(REPO, ".ripple"), { recursive: true, force: true });
    const [a, b] = await Promise.all([
      getGraphForRepo(REPO),
      getGraphForRepo(REPO),
    ]);
    expect(a.status).toBe("miss");
    expect(b.status).toBe("miss");
    // Whatever writer won, the stored entry must be complete + valid.
    const probe = new RippleCache(REPO).load(repoFingerprint(REPO));
    expect(probe.status).toBe("hit");
    expect(existsSync(join(REPO, ".ripple", "cache", fp.key, "index.scip"))).toBe(true);
    // No temp files left behind.
    const leftovers = readdirSync(join(REPO, ".ripple", "cache", fp.key))
      .filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
    expect((await getGraphForRepo(REPO)).status).toBe("hit");
  }, 60_000);
});

// --------------------------------------------------------------------------
describe("automatic base graph + working-tree isolation", () => {
  it("deleted symbol triggers base graph; working tree untouched", async () => {
    // Dirty the worktree first — base analysis must not disturb it.
    writeFileSync(join(REPO, "src", "other.ts"), OTHER_TS + "// dirty\n");
    const before = sha256FileTree(REPO);
    const statusBefore = git(REPO, "status", "--porcelain")
      .split("\n")
      .filter((l) => !l.includes(".ripple"))
      .join("\n");

    const r = await diffImpact({ repo: REPO, base: baseSha });
    const deleted = r.changeSet.changed.filter((c) => c.changeKind === "deleted");
    expect(deleted.map((d) => d.name)).toContain("helper");
    expect(r.cache.baseGraph === "miss" || r.cache.baseGraph === "hit").toBe(true);
    const di = r.deletedImpact.find((d) => d.name === "helper");
    expect(di?.resolved).toBe(true);
    expect(di?.callers.map((c) => c.name)).toContain("process()");

    // Tracked files byte-identical; status unchanged apart from new .ripple.
    const after = sha256FileTree(REPO);
    expect(after).toEqual(before);
    const statusAfter = git(REPO, "status", "--porcelain")
      .split("\n")
      .filter((l) => !l.includes(".ripple"))
      .join("\n");
    expect(statusAfter).toBe(statusBefore);
  }, 120_000);

  it("base graph is cached across runs", async () => {
    const r2 = await diffImpact({ repo: REPO, base: baseSha });
    expect(r2.cache.baseGraph).toBe("hit");
  }, 120_000);
});

// --------------------------------------------------------------------------
describe("deleted-local attribution", () => {
  it("deleted local attributes to enclosing function — no top-level tombstone", async () => {
    const r = await diffImpact({ repo: REPO, base: baseSha });
    const names = r.changeSet.changed.map((c) => c.name);
    expect(names).not.toContain("temporary");
    const proc = r.changeSet.changed.find((c) => c.name === "process()");
    expect(proc?.changeKind).toBe("modified");
    // The genuine top-level deletion is still a tombstone.
    expect(r.changeSet.changed.find((c) => c.name === "helper")?.changeKind).toBe("deleted");
    // .ripple cache internals never appear as changed symbols.
    expect(names.every((n) => !n.includes(".ripple"))).toBe(true);
  }, 120_000);
});

// --------------------------------------------------------------------------
describe("analysis API + JSON", () => {
  it("analyzeRepository returns the documented JSON shape", async () => {
    const r = await analyzeRepository({ repo: REPO, base: baseSha });
    expect(r.schemaVersion).toBe(API_SCHEMA_VERSION);
    expect(r.comparison.base).toBe(baseSha);
    const names = r.changed.map((c) => c.name);
    expect(names).toContain("process()");
    expect(names).toContain("helper");
    expect(r.changed.find((c) => c.name === "helper")?.changeKind).toBe("deleted");
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(["hit", "miss"]).toContain(r.cache.index);
    expect(r.cache.baseGraph).not.toBe("not-required");
    expect(r.timings.totalMs).toBeGreaterThan(0);
    // Evidence + provenance preserved.
    for (const c of r.changed) expect(Array.isArray(c.evidence)).toBe(true);
    for (const a of [...r.direct, ...r.transitive]) {
      expect(a.id).toBeTruthy();
      expect(Array.isArray(a.roots)).toBe(true);
      expect(a.paths.length).toBeGreaterThan(0);
    }
    const del = r.deleted.find((d) => d.name === "helper");
    expect(del?.resolved).toBe(true);
    // Serializes cleanly — machine-readable, no terminal strings.
    expect(() => JSON.stringify(r)).not.toThrow();
  }, 120_000);
});

// --------------------------------------------------------------------------
describe("symbol disambiguation", () => {
  it("ambiguous names return candidates instead of silent selection", async () => {
    const r = await analyzeSymbol({ repo: AMBIG, symbol: "helper" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Ambiguous");
      expect(r.candidates.length).toBe(2);
      const selectors = r.candidates.map((c) => c.selector).sort();
      expect(selectors).toEqual(["src/a.ts::helper()", "src/b.ts::helper()"]);
    }
  });

  it("file::name selector resolves exactly one symbol", async () => {
    const r = await analyzeSymbol({ repo: AMBIG, symbol: "src/b.ts::helper" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.changed[0].file).toBe("src/b.ts");
    }
  });

  it("unknown symbol reports cleanly", async () => {
    const r = await analyzeSymbol({ repo: AMBIG, symbol: "nonexistent" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates).toEqual([]);
  });
});
