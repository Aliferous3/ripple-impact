import type { DetectedProject, LanguageAdapter, ProjectFileRules } from "./adapter.js";
import { TypeScriptJavaScriptAdapter } from "./typescript/adapter.js";
import { PythonAdapter } from "./python/adapter.js";

/**
 * Adapter registry + repository detection.
 *
 * One repository can host multiple projects (per-directory languages).
 * `detectProjects` asks every registered adapter to claim what it can
 * prove — adapters never overlap on the same files today, and merging
 * keeps each fragment's provenance when they someday do.
 */

const ADAPTERS: LanguageAdapter[] = [
  new TypeScriptJavaScriptAdapter(),
  new PythonAdapter(),
];

export function allAdapters(): readonly LanguageAdapter[] {
  return ADAPTERS;
}

/** Every project every registered adapter claims under `root`. */
export function detectProjects(root: string): DetectedProject[] {
  const out: DetectedProject[] = [];
  for (const adapter of ADAPTERS) out.push(...adapter.detect(root));
  return out;
}

export interface RepoIndexPlan {
  projects: DetectedProject[];
  /** OR-merged file rules across all detected adapters. */
  files: ProjectFileRules;
  /** Adapter identities that fed this plan — participates in cache keys. */
  adapters: { id: string; version: string }[];
}

function unionRules(rules: ProjectFileRules[]): ProjectFileRules {
  const or =
    (pick: (r: ProjectFileRules) => (n: string) => boolean) =>
    (n: string) =>
      rules.some((r) => pick(r)(n));
  return {
    sourceFile: or((r) => r.sourceFile),
    configFile: or((r) => r.configFile),
    relevantFile: or((r) => r.relevantFile),
    testFile: or((r) => r.testFile),
  };
}

/**
 * Detection → a single plan consumed by the cache fingerprint, the
 * indexer path, and the watcher. Returns undefined when no adapter can
 * prove ownership — an honest "unsupported", never a guess.
 */
export function planForRepo(root: string): RepoIndexPlan | undefined {
  const projects = detectProjects(root);
  if (projects.length === 0) return undefined;
  return {
    projects,
    files: unionRules(projects.map((p) => p.adapter.files)),
    adapters: projects
      .map((p) => ({ id: p.adapter.id, version: p.adapter.version }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
