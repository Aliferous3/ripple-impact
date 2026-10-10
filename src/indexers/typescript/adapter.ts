import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { IndexOptions } from "../indexer.js";
import type {
  DetectedProject,
  LanguageAdapter,
  LanguageCapabilities,
  ProjectFileRules,
} from "../adapter.js";
import type { RippleGraph } from "../../graph/graph.js";
import { tsSemantics } from "../../changes/semantics.js";
import { ScipIndexer } from "../scip/scip-indexer.js";

/**
 * TypeScript/JavaScript adapter — wraps the proven scip-typescript +
 * TypeScript-AST-enrichment implementation as the first production
 * language adapter.
 *
 * scip-typescript indexes the whole family (.ts/.tsx/.js/.jsx/.mts/
 * .cts/.mjs/.cjs) from tsconfig/jsconfig, and the enrichment pass
 * classifies call sites, JSX tags, type positions and `import type`
 * bindings — so TypeScript and JavaScript are one adapter, not two.
 */

/** Anything scip-typescript could index or resolve through. */
export const TS_CODE_EXT = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;
/** Config whose content changes what the index/graph means. */
export const TS_CONFIG_RE =
  /^(tsconfig[^/\\]*\.json|jsconfig[^/\\]*\.json|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;
/** Files worth waking the watcher for — sources + the config inputs. */
export const TS_RELEVANT_RE =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|d\.ts)$|(^|\/)tsconfig[^/]*\.json$|(^|\/)jsconfig[^/]*\.json$|(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/i;
/** Conventional TS/JS test files — `*.test.*`, `*.spec.*`, test dirs. */
const TS_TEST_RE = /(\.test\.|\.spec\.|\/tests?\/|\/__tests__\/)/i;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".ripple",
  "dist",
  "out",
  "coverage",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

export const TS_FILE_RULES: ProjectFileRules = {
  sourceFile: (name) => TS_CODE_EXT.test(name),
  configFile: (name) => TS_CONFIG_RE.test(name),
  relevantFile: (relPath) => TS_RELEVANT_RE.test(relPath),
  testFile: (relPath) => TS_TEST_RE.test(relPath),
};

const CAPABILITIES: LanguageCapabilities = {
  definitions: true,
  references: true,
  calls: true,
  types: true,
  inheritance: true,
  implementations: true,
  tests: true,
  jsx: true,
};

/** Bounded walk — claims a project when TS/JS source files exist. */
function hasSources(dir: string, depth = 0): boolean {
  if (depth > 6) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && TS_CODE_EXT.test(String(e.name))) return true;
    if (
      e.isDirectory() &&
      !SKIP_DIRS.has(String(e.name)) &&
      hasSources(join(dir, String(e.name)), depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

/** Config-anchored TS/JS project dirs below root (bounded, skip-dirs aware). */
function findSubProjects(
  adapter: TypeScriptJavaScriptAdapter,
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
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    const childDir = join(root, childRel);
    const anchored =
      existsSync(join(childDir, "tsconfig.json")) ||
      existsSync(join(childDir, "jsconfig.json"));
    if (anchored && hasSources(childDir)) {
      const evidence: string[] = [];
      if (existsSync(join(childDir, "tsconfig.json"))) evidence.push(`${childRel}/tsconfig.json`);
      if (existsSync(join(childDir, "jsconfig.json"))) evidence.push(`${childRel}/jsconfig.json`);
      if (existsSync(join(childDir, "package.json"))) evidence.push(`${childRel}/package.json`);
      out.push({
        adapter,
        root: childRel,
        languages: [...adapter.languages],
        evidence,
        projectId: `${adapter.id}:${childRel}`,
      });
      continue; // a claimed project covers everything beneath it
    }
    out.push(...findSubProjects(adapter, root, childRel, depth + 1));
  }
  return out;
}

export class TypeScriptJavaScriptAdapter implements LanguageAdapter {
  readonly id = "typescript-javascript";
  readonly version = "1";
  readonly languages = ["typescript", "javascript"] as const;
  readonly capabilities = CAPABILITIES;
  readonly files = TS_FILE_RULES;
  private readonly indexer = new ScipIndexer();

  detect(root: string): DetectedProject[] {
    if (!hasSources(root)) return [];
    const anchored =
      existsSync(join(root, "tsconfig.json")) ||
      existsSync(join(root, "jsconfig.json"));
    if (!anchored) {
      // No root tsconfig/jsconfig: prefer config-anchored subdirectory
      // projects (monorepo: frontend/tsconfig.json + api/pyproject.toml).
      // A bare root claim would make scip-typescript fail at the repo
      // root; a claimed subdir indexes exactly its own tree.
      const subs = findSubProjects(this, root, "", 0);
      if (subs.length > 0) return subs;
      // A repo anchored to another language's config (e.g. pyproject.toml)
      // with a stray .js/.ts file is not a TS project — a loose-source
      // claim here would fail the analysis a real adapter could serve.
      const foreignAnchor =
        existsSync(join(root, "pyproject.toml")) ||
        existsSync(join(root, "setup.py")) ||
        existsSync(join(root, "setup.cfg")) ||
        existsSync(join(root, "Pipfile")) ||
        existsSync(join(root, "pyrightconfig.json"));
      if (foreignAnchor) return [];
    }
    const evidence: string[] = [];
    if (existsSync(join(root, "tsconfig.json"))) evidence.push("tsconfig.json");
    if (existsSync(join(root, "jsconfig.json"))) evidence.push("jsconfig.json");
    if (existsSync(join(root, "package.json"))) evidence.push("package.json");
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

  index(options: IndexOptions): Promise<RippleGraph> {
    return this.indexer.index(options);
  }

  sourceSemantics(projectRelPath: string) {
    return TS_FILE_RULES.sourceFile(projectRelPath) ? tsSemantics : undefined;
  }
}
