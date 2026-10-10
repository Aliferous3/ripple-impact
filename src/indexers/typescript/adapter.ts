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

export class TypeScriptJavaScriptAdapter implements LanguageAdapter {
  readonly id = "typescript-javascript";
  readonly version = "1";
  readonly languages = ["typescript", "javascript"] as const;
  readonly capabilities = CAPABILITIES;
  readonly files = TS_FILE_RULES;
  private readonly indexer = new ScipIndexer();

  detect(root: string): DetectedProject[] {
    if (!hasSources(root)) return [];
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
}
