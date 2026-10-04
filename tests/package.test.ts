import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ALLOWED = /^(package\.json|README\.md|LICENSE|dist\/.+\.js|dist\/explorer\/.+)$/;

// `npm pack --dry-run --json` reports the exact publish inventory without
// building (scripts ignored — build is covered separately).
function packedFiles(): string[] {
  // shell: true — Node ≥20.12 blocks direct .cmd spawn on Windows
  const out = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
  });
  const [parsed] = JSON.parse(out) as [{ files: { path: string }[] }];
  return parsed.files.map((f) => f.path);
}

describe("package contents", () => {
  it("ships only the allowlist: dist JS, explorer assets, docs", () => {
    const files = packedFiles();
    expect(files.length).toBeGreaterThan(20);
    const rejected = files.filter((f) => !ALLOWED.test(f));
    expect(rejected).toEqual([]);
  });

  it("never ships dev detritus", () => {
    const files = packedFiles().join("\n");
    for (const bad of ["tmp/", "tests/", "fixtures/", "e2e/", ".ripple", "node_modules", ".env", ".ts\"", "src/"])
      expect(files).not.toContain(bad);
  });

  it("bin target exists and has a shebang", () => {
    const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
    expect(pkg.name).toBe("ripple-impact");
    expect(pkg.bin.ripple).toBe("dist/cli/index.js");
    if (existsSync(`${ROOT}/dist/cli/index.js`))
      expect(readFileSync(`${ROOT}/dist/cli/index.js`, "utf8").startsWith("#!")).toBe(true);
  });

  it("explorer bundle path resolves next to the compiled server", () => {
    if (!existsSync(`${ROOT}/dist/explorer/index.html`)) return; // dist not built
    expect(existsSync(`${ROOT}/dist/server/explorer.js`)).toBe(true);
  });

  it("runtime deps stay minimal — no test/build tooling", () => {
    const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@sourcegraph/scip-typescript",
      "chokidar",
      "typescript",
    ]);
    // typescript IS a runtime dep (AST enrichment imports it directly)
    for (const dev of ["vitest", "playwright", "vite", "tsx", "react"])
      expect(pkg.dependencies[dev]).toBeUndefined();
  });
});
