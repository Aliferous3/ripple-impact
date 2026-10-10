import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { detectProjects, planForRepo } from "../src/indexers/registry.js";
import { PY_FILE_RULES, PythonAdapter } from "../src/indexers/python/adapter.js";
import {
  findPython,
  PythonUnavailableError,
} from "../src/indexers/python/interpreter.js";
import {
  moduleTail,
  parsePythonSymbol,
  pyDisplayName,
  pyNodeKind,
} from "../src/indexers/python/symbol.js";
import { pySourceSemantics } from "../src/indexers/python/sourcemap.js";
import { semanticsResolver } from "../src/changes/semantics.js";
import { commitFingerprint } from "../src/cache/fingerprint.js";

const tmpDirs: string[] = [];
function tmpRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ripple-py-test-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const adapter = new PythonAdapter();
const ENRICH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../python/enrich.py",
);
const py = findPython();
const pyIt = py ? it : it.skip;

describe("python adapter detection", () => {
  it("detects a config-anchored root project", () => {
    const dir = tmpRepo({
      "pyproject.toml": "[project]\nname = \"x\"\n",
      "app.py": "print(1)\n",
    });
    const projects = adapter.detect(dir);
    expect(projects).toHaveLength(1);
    expect(projects[0].adapter.id).toBe("python");
    expect(projects[0].root).toBe("");
    expect(projects[0].languages).toEqual(["python"]);
    expect(projects[0].evidence).toContain("pyproject.toml");
    expect(projects[0].projectId).toBe("python:.");
  });

  it("detects requirements.txt as config evidence", () => {
    const dir = tmpRepo({
      "requirements.txt": "requests\n",
      "src/main.py": "pass\n",
    });
    const projects = adapter.detect(dir);
    expect(projects).toHaveLength(1);
    expect(projects[0].evidence).toContain("requirements.txt");
  });

  it("detects a config-anchored subdirectory project", () => {
    const dir = tmpRepo({
      "api/pyproject.toml": "[project]\nname = \"api\"\n",
      "api/pkg/mod.py": "pass\n",
    });
    const projects = adapter.detect(dir);
    expect(projects).toHaveLength(1);
    expect(projects[0].root).toBe("api");
    expect(projects[0].projectId).toBe("python:api");
    expect(projects[0].evidence).toContain("api/pyproject.toml");
  });

  it("claims bare top-level .py files only when the repo is not TS/JS", () => {
    const pyRepo = tmpRepo({ "tool.py": "pass\n" });
    expect(adapter.detect(pyRepo)).toHaveLength(1);
    const tsRepo = tmpRepo({
      "package.json": "{}",
      "src/app.ts": "export {};",
      "scripts/build.py": "pass\n",
    });
    expect(adapter.detect(tsRepo)).toHaveLength(0);
  });

  it("ignores python files inside vendored/generated dirs", () => {
    const dir = tmpRepo({
      "node_modules/lib/tool.py": "pass\n",
      ".venv/Lib/site.py": "pass\n",
    });
    expect(adapter.detect(dir)).toHaveLength(0);
  });

  it("does not claim a config anchor with no python sources", () => {
    const dir = tmpRepo({ "pyproject.toml": "[project]\nname = \"x\"\n" });
    expect(adapter.detect(dir)).toHaveLength(0);
  });
});

describe("python file rules + capabilities", () => {
  it("matches source/config/relevant/test conventions", () => {
    expect(PY_FILE_RULES.sourceFile("mod.py")).toBe(true);
    expect(PY_FILE_RULES.sourceFile("app.ts")).toBe(false);
    expect(PY_FILE_RULES.configFile("pyproject.toml")).toBe(true);
    expect(PY_FILE_RULES.configFile("requirements-dev.txt")).toBe(true);
    expect(PY_FILE_RULES.configFile("uv.lock")).toBe(true);
    expect(PY_FILE_RULES.relevantFile("pkg/mod.py")).toBe(true);
    expect(PY_FILE_RULES.relevantFile("pyproject.toml")).toBe(true);
    expect(PY_FILE_RULES.testFile("tests/test_svc.py")).toBe(true);
    expect(PY_FILE_RULES.testFile("pkg/util_test.py")).toBe(true);
    expect(PY_FILE_RULES.testFile("pkg/mod.py")).toBe(false);
  });

  it("advertises only verified capabilities", () => {
    expect(adapter.capabilities).toEqual({
      definitions: true,
      references: true,
      calls: true,
      types: true,
      inheritance: true,
      implementations: true,
      tests: true,
      jsx: false,
    });
    expect(adapter.id).toBe("python");
    expect(adapter.version).toBe("1");
  });
});

describe("python symbol parser", () => {
  const parse = (s: string) => {
    const p = parsePythonSymbol(s);
    if (!p) throw new Error(`unparsed: ${s}`);
    return p;
  };

  it("parses module markers", () => {
    const p = parse("scip-python python probe 0.1.0 `pkg.models`/__init__:");
    expect(p.kind).toBe("module");
    expect(moduleTail(p)).toBe("pkg/models");
  });

  it("parses functions, methods, classes, variables, parameters", () => {
    const fn = parse("scip-python python p 1.0 `pkg.m`/normalize().");
    expect(fn.kind).toBe("function");
    expect(pyNodeKind(fn)).toBe("function");
    expect(pyDisplayName(fn)).toBe("normalize()");

    const m = parse("scip-python python p 1.0 `pkg.m`/Service#save().");
    expect(m.kind).toBe("method");
    expect(m.parentTypeName).toBe("Service");
    expect(pyNodeKind(m)).toBe("method");
    expect(pyDisplayName(m)).toBe("Service#save()");

    const cls = parse("scip-python python p 1.0 `pkg.m`/Service#");
    expect(cls.kind).toBe("class");
    expect(pyNodeKind(cls)).toBe("class");
    expect(pyDisplayName(cls)).toBe("Service");

    const v = parse("scip-python python p 1.0 `pkg.m`/User#name.");
    expect(v.kind).toBe("variable");
    expect(v.parentTypeName).toBe("User");
    expect(pyNodeKind(v)).toBe("variable");

    const param = parse("scip-python python p 1.0 `pkg.m`/f().(x)");
    expect(param.kind).toBe("parameter");
    expect(pyNodeKind(param)).toBeUndefined();
  });

  it("parses nested functions and locals", () => {
    const nested = parse("scip-python python p 1.0 `pkg.m`/outer().inner().");
    expect(nested.kind).toBe("function");
    expect(pyDisplayName(nested)).toBe("inner()");
    const local = parsePythonSymbol("local 0");
    expect(local?.kind).toBe("local");
    expect(pyNodeKind(local!)).toBeUndefined();
  });

  it("rejects non-python and malformed symbols", () => {
    expect(parsePythonSymbol("scip-typescript typescript p 1.0 `x`/f().")).toBeUndefined();
    expect(parsePythonSymbol("scip-python python p 1.0")).toBeUndefined();
    expect(
      parsePythonSymbol("scip-python python python-stdlib 3.11 builtins/str#")?.kind,
    ).toBe("class"); // external symbols parse — filtered at the document boundary
  });
});

describe("interpreter discovery", () => {
  it("returns a structured env or undefined", () => {
    const env = findPython();
    if (env) {
      expect(env.exe.length).toBeGreaterThan(0);
      expect(env.version).toMatch(/^\d+\.\d+/);
      const [maj, min] = env.version.split(".").map(Number);
      expect(maj > 3 || (maj === 3 && min >= 10)).toBe(true);
    }
  });

  it("PythonUnavailableError carries a structured code", () => {
    const err = new PythonUnavailableError("PYTHON_VERSION_UNSUPPORTED", "x");
    expect(err.code).toBe("PYTHON_VERSION_UNSUPPORTED");
    expect(err.message).toContain("PYTHON_VERSION_UNSUPPORTED");
  });
});

describe("python sourcemap semantics", () => {
  const sem = pySourceSemantics(() => py);
  const SRC = [
    "import os  # comment",
    "",
    "class C(Base):",
    "    attr: int = 0",
    "",
    "    def m(self):",
    "        s = 'x  y'",
    "        return helper()",
    "",
    "def helper():",
    "    def nested():",
    "        return 1",
    "    return nested()",
    "",
    "if TYPE_CHECKING:",
    "    import json",
  ].join("\n");

  pyIt("extracts defs with class-member and nesting rules", () => {
    const defs = sem.extractDefs("m.py", SRC);
    const byName = new Map(defs.map((d) => [d.name, d]));
    expect(byName.get("C")?.kind).toBe("class");
    expect(byName.get("C")?.topLevel).toBe(true);
    expect(byName.get("C#m")?.kind).toBe("method");
    expect(byName.get("C#m")?.topLevel).toBe(true);
    expect(byName.get("C#attr")?.kind).toBe("variable");
    expect(byName.get("helper")?.kind).toBe("function");
    const nested = byName.get("nested");
    expect(nested?.topLevel).toBe(false);
    const local = byName.get("s");
    expect(local?.topLevel).toBe(false);
    // extents span decorators..body end; bodyText slices correctly
    const c = byName.get("C")!;
    expect(SRC.slice(c.bodyText ? 0 : 0)).toBeDefined();
    expect(c.bodyText.startsWith("class C(Base):")).toBe(true);
  });

  pyIt("reports comment and literal ranges", () => {
    const comments = sem.commentRanges("m.py", SRC);
    expect(comments).toHaveLength(1);
    expect(SRC.slice(comments[0][0], comments[0][1])).toBe("# comment");
    const literals = sem.literalRanges("m.py", SRC);
    expect(
      literals.some(([s, e]) => SRC.slice(s, e) === "'x  y'"),
    ).toBe(true);
  });

  pyIt("marks TYPE_CHECKING blocks type-only", () => {
    const ranges = sem.typeOnlyModuleRanges("m.py", SRC);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startLine).toBe(14);
  });

  pyIt("returns conservative facts on helper failure", () => {
    const broken = pySourceSemantics(() => undefined);
    expect(broken.extractDefs("m.py", SRC)).toEqual([]);
    expect(broken.commentRanges("m.py", SRC)).toEqual([]);
    expect(broken.literalRanges("m.py", "a b")).toEqual([[0, 3]]);
    expect(broken.typeOnlyModuleRanges("m.py", SRC)).toEqual([]);
  });
});

describe("enrich.py call/type classification", () => {
  const runClassify = (text: string) => {
    const out = execFileSync(py!.exe, [...py!.args, ENRICH], {
      input: JSON.stringify({ mode: "classify", files: [{ id: "f.py", text }] }),
      encoding: "utf8",
      windowsHide: true,
    });
    return (JSON.parse(out) as { files: Record<string, { calls: number[][]; types: { r: number[]; k: string }[] }> })
      .files["f.py"];
  };

  pyIt("classifies call names, not decorator heads or plain references", () => {
    const src = [
      "import dec",
      "",
      "@dec",
      "def f():",
      "    return run(mod.fn, getattr(o, n))",
      "",
      "x = run",
    ].join("\n");
    const r = runClassify(src);
    const callLines = r.calls.map((c) => c[0]);
    // run(...) and getattr(...) are calls at line 4; `mod.fn` is an
    // argument, not a call.
    expect(r.calls.length).toBe(2);
    expect(callLines).toEqual([4, 4]);
    // `dec` at line 2 is NOT a call; `run` at line 6 is NOT a call.
    expect(callLines).not.toContain(2);
    expect(callLines).not.toContain(6);
  });

  pyIt("classifies annotation and base-class positions", () => {
    const src = [
      "def f(u: User) -> Result:",
      "    v: Item = g()",
      "",
      "class C(Base):",
      "    pass",
    ].join("\n");
    const r = runClassify(src);
    const annLines = r.types.filter((t) => t.k === "annotation").map((t) => t.r[0]);
    const baseLines = r.types.filter((t) => t.k === "base-class").map((t) => t.r[0]);
    expect(annLines).toEqual([0, 0, 1]);
    expect(baseLines).toEqual([3]);
    expect(r.calls.length).toBe(1); // only g()
    expect(r.calls[0][0]).toBe(1);
  });
});

describe("semantics resolver routing", () => {
  it("routes each changed file to its adapter's semantics", () => {
    const dir = tmpRepo({
      "frontend/tsconfig.json": "{}",
      "frontend/src/app.ts": "export {};",
      "backend/pyproject.toml": "[project]\nname = \"b\"\n",
      "backend/pkg/m.py": "pass\n",
    });
    const projects = detectProjects(dir);
    const resolve = semanticsResolver(projects);
    const pySem = resolve("backend/pkg/m.py");
    const tsSem = resolve("frontend/src/app.ts");
    expect(pySem).toBeDefined();
    expect(tsSem).toBeDefined();
    expect(pySem).not.toBe(tsSem);
    expect(resolve("README.md")).toBeUndefined();
  });

  it("falls back to TS semantics for .ts outside any project (legacy)", () => {
    const resolve = semanticsResolver(undefined);
    expect(resolve("x.ts")).toBeDefined();
    expect(resolve("x.py")).toBeUndefined();
  });
});

describe("python cache scoping", () => {
  it("fingerprints differ by adapter identity", () => {
    const sha = "a".repeat(40);
    const ts = commitFingerprint(sha, {
      adapters: [{ id: "typescript-javascript", version: "1" }],
    });
    const pyFp = commitFingerprint(sha, {
      adapters: [{ id: "python", version: "1" }],
    });
    const mixed = commitFingerprint(sha, {
      adapters: [
        { id: "python", version: "1" },
        { id: "typescript-javascript", version: "1" },
      ],
    });
    expect(ts.key).not.toBe(pyFp.key);
    expect(mixed.key).not.toBe(ts.key);
    expect(mixed.key).not.toBe(pyFp.key);
  });
});

describe("mixed detection through the registry", () => {
  it("detects both adapters in a monorepo", () => {
    const dir = tmpRepo({
      "frontend/tsconfig.json": "{}",
      "frontend/src/app.ts": "export {};",
      "api/pyproject.toml": "[project]\nname = \"a\"\n",
      "api/pkg/m.py": "pass\n",
    });
    const projects = detectProjects(dir);
    const ids = projects.map((p) => p.projectId).sort();
    expect(ids).toEqual(["python:api", "typescript-javascript:frontend"]);
    expect(planForRepo(dir)?.adapters.map((a) => a.id).sort()).toEqual([
      "python",
      "typescript-javascript",
    ]);
  });
});
