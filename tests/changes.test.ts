import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { diffImpact, type DiffImpactResult } from "../src/changes/pipeline.js";

const REPO = resolve("tmp/git-scenarios");

function git(...args: string[]): string {
  return execFileSync("git", ["-C", REPO, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

/** Check out `head`, then diff → map → impact against `base`. */
async function scenario(
  head: string,
  base: string,
): Promise<DiffImpactResult> {
  git("checkout", "-q", head);
  return diffImpact({ repo: REPO, base });
}

const names = (r: DiffImpactResult): string[] =>
  r.changeSet.changed.map((c) => c.name);

beforeAll(async () => {
  if (!existsSync(join(REPO, ".git"))) {
    execFileSync("npx", ["tsx", "scripts/setup-git-fixture.ts"], {
      stdio: "inherit",
      shell: true,
    });
  }
}, 120_000);

describe("changed-symbol mapping (real git)", () => {
  it("body change inside a function → that function only", async () => {
    const r = await scenario("s1-one-fn-modified", "s0-base");
    expect(names(r)).toEqual(["beta()"]);
    expect(r.changeSet.changed[0].changeKind).toBe("modified");
    expect(names(r)).not.toContain("alpha()");
    expect(names(r)).not.toContain("gamma()");
  });

  it("one of several siblings → siblings not falsely marked", async () => {
    const r = await scenario("s2-sibling-isolation", "s1-one-fn-modified");
    expect(names(r)).toEqual(["gamma()"]);
    expect(names(r)).not.toContain("alpha()");
    expect(names(r)).not.toContain("beta()");
  });

  it("two functions in different files → both changed", async () => {
    const r = await scenario("s3-two-fns", "s2-sibling-isolation");
    expect(names(r)).toContain("alpha()");
    expect(names(r)).toContain("isEmpty()");
    expect(names(r)).not.toContain("beta()");
    expect(names(r)).not.toContain("gamma()");
    expect(names(r)).not.toContain("normalizePath()");
  });

  it("added function → changeKind 'added'", async () => {
    const r = await scenario("s4-fn-added", "s3-two-fns");
    const issueToken = r.changeSet.changed.find((c) => c.name === "issueToken()");
    expect(issueToken).toBeDefined();
    expect(issueToken!.changeKind).toBe("added");
    // siblings untouched
    expect(names(r)).not.toContain("refreshSession()");
    expect(names(r)).not.toContain("validateUser()");
  });

  it("deleted function → tombstone; base graph resolves former callers", async () => {
    const r = await scenario("s5-fn-deleted", "s4-fn-added");
    const dead = r.changeSet.changed.find((c) => c.name === "legacyToken");
    expect(dead).toBeDefined();
    expect(dead!.changeKind).toBe("deleted");
    expect(dead!.node).toBeUndefined(); // not in the current graph
    const info = r.deletedImpact.find((d) => d.name === "legacyToken");
    expect(info!.callers.map((c) => c.name)).toContain("mintLegacy()");
    // deleted symbols must not enter the current-graph impact roots
    expect(r.impact.changed.map((n) => n.name)).not.toContain("legacyToken");
  });

  it("signature change → the function is changed", async () => {
    const r = await scenario("s6-signature-change", "s5-fn-deleted");
    expect(names(r)).toContain("refreshSession()");
    expect(names(r)).not.toContain("validateUser()");
    expect(names(r)).not.toContain("issueToken()");
  });

  it("pure file rename → no symbols changed", async () => {
    const r = await scenario("s7-file-renamed", "s6-signature-change");
    expect(r.changeSet.renamedFiles).toEqual([
      { from: "src/util.ts", to: "src/utils.ts" },
    ]);
    expect(r.changeSet.changed).toEqual([]);
  });

  it("function moved between files → 'renamed' with provenance", async () => {
    const r = await scenario("s8-fn-moved", "s7-file-renamed");
    const beta = r.changeSet.changed.find((c) => c.name === "beta()");
    expect(beta).toBeDefined();
    expect(beta!.changeKind).toBe("renamed");
    expect(beta!.renamedFrom).toEqual({ name: "beta", file: "src/extra.ts" });
    expect(beta!.file).toBe("src/moved.ts");
    // the moved symbol is a real node in the current graph
    expect(beta!.node).toBeDefined();
  });

  it("comment-only change → nothing changed", async () => {
    const r = await scenario("s9-comment-only", "s8-fn-moved");
    expect(r.changeSet.changed).toEqual([]);
    expect(r.changeSet.nonSemantic.length).toBeGreaterThan(0);
    expect(r.changeSet.nonSemantic.every((n) => n.kind === "non-semantic")).toBe(true);
  });

  it("formatting-only change → nothing changed", async () => {
    const r = await scenario("s10-formatting", "s9-comment-only");
    expect(r.changeSet.changed).toEqual([]);
    expect(r.changeSet.nonSemantic.length).toBeGreaterThan(0);
  });

  it("disconnected module change → no auth-chain impact", async () => {
    const r = await scenario("s11-disconnected", "s10-formatting");
    expect(names(r)).toContain("formatNotification()");
    const affected = [...r.impact.direct, ...r.impact.transitive].map((a) => a.node.name);
    expect(affected).not.toContain("checkout()");
    expect(affected).not.toContain("authenticateRequest()");
    expect(affected).not.toContain("completePayment()");
  });

  it("multi-downstream change → direct + transitive + tests", async () => {
    const r = await scenario("s12-multi-downstream", "s11-disconnected");
    expect(names(r)).toEqual(["validateUser()"]);
    const direct = r.impact.direct.map((a) => a.node.name);
    const transitive = r.impact.transitive.map((a) => a.node.name);
    expect(direct).toContain("authenticateRequest()");
    expect(direct).toContain("accountSettings()");
    expect(transitive).toContain("checkout()");
    expect(transitive).toContain("completePayment()");
    expect(transitive).toContain("testCheckout()");
    expect(r.impact.relevantTests.map((t) => t.file)).toContain("tests/app.test.ts");
    // negatives
    expect([...direct, ...transitive]).not.toContain("sendNotification()");
    expect([...direct, ...transitive]).not.toContain("refreshSession()");
  });

  it("change with no downstream → empty impact", async () => {
    const r = await scenario("s13-no-downstream", "s12-multi-downstream");
    expect(names(r)).toEqual(["completePayment()"]);
    expect(r.impact.direct).toEqual([]);
    expect(r.impact.transitive).toEqual([]);
  });

  it("multiple roots → dedup + per-root provenance", async () => {
    const r = await scenario("s14-multi-root", "s13-no-downstream");
    expect(names(r).sort()).toEqual(["refreshSession()", "validateUser()"]);
    const auth = r.impact.direct.find((a) => a.node.name === "authenticateRequest()");
    expect(auth).toBeDefined();
    const rootNames = auth!.roots.map((id) => r.graph.node(id)?.name).sort();
    expect(rootNames).toEqual(["refreshSession()", "validateUser()"]);
    // one witness path per root
    expect(Object.keys(auth!.pathsByRoot)).toHaveLength(2);
    // dedup: authenticateRequest appears exactly once
    expect(
      r.impact.direct.filter((a) => a.node.name === "authenticateRequest()"),
    ).toHaveLength(1);
  });

  it("import-only change → module scope, not every function", async () => {
    const r = await scenario("s15-import-only", "s14-multi-root");
    const scope = r.changeSet.changed.find((c) => c.changeKind === "module-scope");
    expect(scope).toBeDefined();
    expect(scope!.file).toBe("src/settings.ts");
    expect(names(r)).not.toContain("accountSettings()");
  });

  it("import type change → typeOnly module-scope, zero runtime propagation", async () => {
    const r = await scenario("s16-import-type", "s15-import-only");
    const scope = r.changeSet.changed.find((c) => c.changeKind === "module-scope");
    expect(scope).toBeDefined();
    expect(scope!.file).toBe("src/session.ts");
    expect(scope!.typeOnly).toBe(true);
    // session.ts is imported by auth.ts + settings.ts — none may be flagged.
    expect(r.impact.direct).toEqual([]);
    expect(r.impact.transitive).toEqual([]);
    // and no type impact either — the imported type is never consumed
    expect(r.impact.typeDirect).toEqual([]);
    expect(r.impact.typeTransitive).toEqual([]);
  });

  it("unindexed test files surface TEST_FILES_OUTSIDE_INDEX_SCOPE", async () => {
    git("checkout", "-q", "s15-import-only");
    const dir = join(REPO, "test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "outside.test.mjs"), "console.log(1);\n");
    try {
      const r = await diffImpact({ repo: REPO });
      const w = r.warnings.find((x) => x.code === "TEST_FILES_OUTSIDE_INDEX_SCOPE");
      expect(w).toBeDefined();
      expect(w!.files).toContain("test/outside.test.mjs");
      // indexed test files must not be reported as outside scope
      expect(w!.files ?? []).not.toContain("tests/app.test.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("working-tree diff (no base) → uncommitted change detected", async () => {
    git("checkout", "-q", "s15-import-only");
    const file = join(REPO, "src/notify.ts");
    const orig = readFileSync(file, "utf8");
    try {
      writeFileSync(file, orig.replace("[notification]", "[notice]"));
      const r = await diffImpact({ repo: REPO });
      expect(names(r)).toContain("formatNotification()");
      expect(r.diff.oldRev).toBe("HEAD");
    } finally {
      git("checkout", "-q", "--", "src/notify.ts");
    }
  });
});
