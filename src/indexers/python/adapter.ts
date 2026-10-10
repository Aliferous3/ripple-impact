import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { IndexOptions } from "../indexer.js";
import type {
  DetectedProject,
  LanguageAdapter,
  LanguageCapabilities,
  ProjectFileRules,
} from "../adapter.js";
import type { RippleGraph } from "../../graph/graph.js";
import type { SourceSemantics } from "../../changes/semantics.js";
import { buildPythonGraphFromScipIndex } from "./graph.js";
import { findPython, requirePython, type PythonEnv } from "./interpreter.js";
import { pySourceSemantics } from "./sourcemap.js";

const require = createRequire(import.meta.url);

/**
 * Python adapter (experimental) — scip-python (Pyright-based SCIP) for
 * semantic facts + a stdlib-ast enrichment pass for call/type-position
 * classification. Same contract as the TypeScript adapter: prove the edge
 * or emit a plain reference.
 *
 * Honesty boundaries:
 *  - calls only where syntax shows a call AND SCIP resolves the callee;
 *  - decorators are references, not calls;
 *  - dynamic constructs (getattr(...)( ), globals()[n](), monkey patching,
 *    metaclasses, exec/eval) produce no fabricated edges;
 *  - stdlib/site-packages symbols never become repository nodes;
 *  - a missing/<3.10 interpreter fails analysis with a structured error
 *    rather than a degraded silent attempt.
 */

export const PY_SOURCE_RE = /\.(py|pyi)$/;
/** Config whose content changes what the index/graph means. */
export const PY_CONFIG_RE =
  /^(pyproject\.toml|setup\.py|setup\.cfg|requirements[^/\\]*\.txt|Pipfile(\.lock)?|poetry\.lock|uv\.lock|tox\.ini|pyrightconfig\.json|\.python-version)$/;
/** Files worth waking the watcher for. */
export const PY_RELEVANT_RE =
  /\.(py|pyi)$|(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|uv\.lock|tox\.ini|pyrightconfig\.json|\.python-version)$/i;
/** Conventional Python test files: test_*.py, *_test.py, tests?/ dirs. */
export const PY_TEST_RE =
  /(^|\/)tests?\/[^/]*\.py$|(^|\/)test_[^/]*\.py$|(^|\/)[^/]*_test\.py$/i;

const PY_SKIP_DIRS = new Set([
  ".git",
  ".ripple",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".env",
  "site-packages",
  "dist",
  "build",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".eggs",
  ".idea",
  ".vscode",
]);

export const PY_FILE_RULES: ProjectFileRules = {
  sourceFile: (name) => PY_SOURCE_RE.test(name),
  configFile: (name) => PY_CONFIG_RE.test(name),
  relevantFile: (relPath) => PY_RELEVANT_RE.test(relPath),
  testFile: (relPath) => PY_TEST_RE.test(relPath),
};

const CAPABILITIES: LanguageCapabilities = {
  definitions: true,
  references: true,
  calls: true, // syntactic call position ∩ SCIP resolution
  types: true, // annotation/base-class position ∩ SCIP resolution
  inheritance: true, // SCIP is_implementation on class bases
  implementations: true,
  tests: true,
  jsx: false,
};

/** Any Python config anchor directly inside dir. */
function configEvidence(dir: string, prefix: string): string[] {
  const names = [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "Pipfile",
    "pyrightconfig.json",
    "tox.ini",
  ];
  const out: string[] = [];
  for (const n of names) {
    if (existsSync(join(dir, n))) out.push(prefix ? `${prefix}/${n}` : n);
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile() && /^requirements[^/\\]*\.txt$/i.test(e.name)) {
      out.push(prefix ? `${prefix}/${e.name}` : e.name);
    }
  }
  return out;
}

/** Bounded walk — true when a .py file exists under dir (skip-dirs aware). */
function hasPySources(dir: string, depth = 0): boolean {
  if (depth > 6) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && PY_SOURCE_RE.test(String(e.name))) return true;
    if (
      e.isDirectory() &&
      !PY_SKIP_DIRS.has(String(e.name)) &&
      hasPySources(join(dir, String(e.name)), depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

/** Direct .py files at the top level of dir (non-recursive). */
function hasTopLevelPy(dir: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && PY_SOURCE_RE.test(String(e.name)));
}

/** Config-anchored Python project dirs below root (bounded, skip-dirs aware). */
function findSubProjects(
  adapter: PythonAdapter,
  root: string,
  rel: string,
  depth: number,
): DetectedProject[] {
  if (depth > 4) return [];
  const dir = rel ? join(root, rel) : root;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DetectedProject[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = String(e.name);
    if (PY_SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    const childDir = join(root, childRel);
    const evidence = configEvidence(childDir, childRel);
    if (evidence.length > 0 && hasPySources(childDir)) {
      out.push({
        adapter,
        root: childRel,
        languages: ["python"],
        evidence,
        projectId: `python:${childRel}`,
      });
      continue; // a claimed project covers everything beneath it
    }
    out.push(...findSubProjects(adapter, root, childRel, depth + 1));
  }
  return out;
}

const LAUNCHER = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../python/scip-python-launcher.cjs",
);

function scipPythonEntry(): string {
  return join(
    dirname(require.resolve("@sourcegraph/scip-python/package.json")),
    "index.js",
  );
}

/** Best-effort [project] name/version from pyproject.toml for stable ids. */
function pyprojectIdentity(root: string): { name: string; version: string } {
  const fallback = { name: "python-project", version: "0.0.0" };
  try {
    const text = readFileSync(join(root, "pyproject.toml"), "utf8");
    const project = text.match(/\[project\]([\s\S]*?)(?=\n\[|\s*$)/)?.[1] ?? "";
    const name = project.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const version = project.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    return {
      name: name ?? fallback.name,
      version: version ?? fallback.version,
    };
  } catch {
    return fallback;
  }
}

class PythonIndexer {
  constructor(private readonly env: PythonEnv) {}

  async index(options: IndexOptions): Promise<RippleGraph> {
    const root = resolve(options.root);
    let indexPath = options.indexPath;
    if (!indexPath) {
      indexPath = options.outputPath ?? join(root, "index.scip");
      const { name, version } = pyprojectIdentity(root);
      // The launcher neutralizes path.sep inside the child (upstream
      // RegExp crash workaround), which makes scip-python's internal
      // path comparisons expect forward slashes — a backslash --cwd
      // makes every file look "outside the project" and emits an
      // empty index. Normalize all path arguments to POSIX form.
      const posixPath = (p: string) => p.replace(/\\/g, "/");
      try {
        execFileSync(
          process.execPath,
          [
            LAUNCHER,
            scipPythonEntry(),
            "index",
            "--project-name",
            name,
            "--project-version",
            version,
            "--cwd",
            posixPath(root),
            "--output",
            posixPath(indexPath),
          ],
          { stdio: "pipe", windowsHide: true },
        );
      } catch (err) {
        const e = err as { stderr?: Buffer; stdout?: Buffer };
        const captured = String(e.stderr ?? "").trim() || String(e.stdout ?? "").trim();
        const tail = captured.split("\n").slice(-8).join("\n");
        throw new Error(
          `PYTHON_INDEXER_FAILED: scip-python failed to index ${root}` +
            (tail ? `:\n${tail}` : ` (${(err as Error).message})`),
        );
      }
    }
    if (!existsSync(indexPath)) {
      throw new Error(`PYTHON_INDEXER_FAILED: SCIP index not found: ${indexPath}`);
    }
    return buildPythonGraphFromScipIndex(readFileSync(indexPath), root, {
      python: this.env,
      enrichCacheDir: options.enrichCacheDir,
      statsOut: options.statsOut,
      isTestFile: PY_FILE_RULES.testFile,
    });
  }
}

export class PythonAdapter implements LanguageAdapter {
  readonly id = "python";
  readonly version = "1";
  readonly languages = ["python"] as const;
  readonly capabilities = CAPABILITIES;
  readonly files = PY_FILE_RULES;

  detect(root: string): DetectedProject[] {
    const evidence = configEvidence(root, "");
    // 1. Config-anchored root project — the common single-project case.
    if (evidence.length > 0 && hasPySources(root)) {
      return [
        {
          adapter: this,
          root: "",
          languages: [...this.languages],
          evidence,
          projectId: `${this.id}:.`,
        },
      ];
    }
    // 2. Config-anchored subdirectory projects (monorepo: api/, backend/).
    const subs = findSubProjects(this, root, "", 0);
    if (subs.length > 0) return subs;
    // 3. Bare top-level .py files with no config: claim only when the repo
    //    does not look primarily TS/JS (a stray build.py must not turn a
    //    JavaScript repository into a Python project).
    const looksTs =
      existsSync(join(root, "package.json")) ||
      existsSync(join(root, "tsconfig.json")) ||
      existsSync(join(root, "jsconfig.json"));
    if (!looksTs && hasTopLevelPy(root)) {
      return [
        {
          adapter: this,
          root: "",
          languages: [...this.languages],
          evidence: ["*.py"],
          projectId: `${this.id}:.`,
        },
      ];
    }
    return [];
  }

  async index(options: IndexOptions): Promise<RippleGraph> {
    const env = requirePython(); // honest decline — never degraded silence
    return new PythonIndexer(env).index(options);
  }

  private pySem?: SourceSemantics;
  sourceSemantics(projectRelPath: string): SourceSemantics | undefined {
    if (!PY_FILE_RULES.sourceFile(projectRelPath)) return undefined;
    this.pySem ??= pySourceSemantics(() => findPython());
    return this.pySem;
  }
}
