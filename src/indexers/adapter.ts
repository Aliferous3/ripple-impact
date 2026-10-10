import type { SourceSemantics } from "../changes/semantics.js";
import type { Indexer } from "./indexer.js";

/**
 * Language adapter boundary — the seam between "how a language family is
 * indexed" and "what the normalized Ripple graph means".
 *
 * Everything downstream of a LanguageAdapter (changed-symbol mapping,
 * impact traversal, evidence paths, AnalysisResult) consumes only the
 * normalized graph. An adapter is the ONLY place that may know how a
 * specific language family is indexed, which files/config it owns, and
 * which edge kinds it can honestly produce.
 *
 * Invariants:
 *  - An adapter claims only what it can PROVE. If it cannot produce a
 *    call edge with evidence, it must not manufacture one — `references`
 *    or nothing. Textual/regex "dependency analysis" is not indexing.
 *  - Capabilities advertise what a detected project can supply, so
 *    downstream features degrade honestly instead of inventing edges.
 *  - Detection is per-project, not per-repo: a monorepo may host
 *    several projects (frontend/ TS, api/ Python, ...). One repo is
 *    never assumed to be one language.
 */

/** Free-form language identifier ("typescript", "python", "rust", ...). */
export type LanguageId = string;

export interface LanguageCapabilities {
  /** Symbol definitions resolved to canonical ids. */
  definitions: boolean;
  /** Reference occurrences resolved to canonical ids. */
  references: boolean;
  /** Call sites distinguished from plain references. */
  calls: boolean;
  /** Type-position usage distinguished from runtime usage. */
  types: boolean;
  /** Inheritance/subtype relationships. */
  inheritance: boolean;
  /** Interface/trait implementation relationships. */
  implementations: boolean;
  /** Test files/symbols identifiable for relevant-test reporting. */
  tests: boolean;
  /** JSX element usage (`jsx_uses` edges) — TS/JS family only. */
  jsx?: boolean;
}

/**
 * Which repository files an adapter owns. These rules feed the cache
 * fingerprint, the filesystem watcher, and test-scope visibility — the
 * generic engine must not hardcode a language's file conventions.
 */
export interface ProjectFileRules {
  /** Source file the adapter can index (basename or repo-relative path). */
  sourceFile(name: string): boolean;
  /** Config whose content changes what the index/graph means. */
  configFile(name: string): boolean;
  /** File whose change should trigger re-analysis in watch mode. */
  relevantFile(relPath: string): boolean;
  /** Conventional test file for the language (may be unindexed). */
  testFile(relPath: string): boolean;
}

/** A language project detected inside a repository. */
export interface DetectedProject {
  /** The adapter that claimed this project. */
  adapter: LanguageAdapter;
  /**
   * Project root relative to the repository root, forward slashes.
   * "" means the repository root itself.
   */
  root: string;
  /** Languages covered by this project. */
  languages: LanguageId[];
  /** Config evidence that drove detection (repo-relative paths). */
  evidence: string[];
  /**
   * Stable identity for provenance and cache scoping:
   * "<adapterId>:<root or '.'>".
   */
  projectId: string;
}

export interface LanguageAdapter extends Indexer {
  /** Stable adapter identity, e.g. "typescript-javascript". */
  readonly id: string;
  /**
   * Adapter implementation version — participates in cache keys so an
   * adapter upgrade invalidates its own artifacts only.
   */
  readonly version: string;
  readonly languages: readonly LanguageId[];
  readonly capabilities: LanguageCapabilities;
  readonly files: ProjectFileRules;
  /**
   * Claim zero or more projects inside `root`. An empty result means
   * "not mine" — detection must never guess.
   */
  detect(root: string): DetectedProject[];
  /**
   * Source semantics for a project-relative path — comment/literal ranges,
   * def extraction, and type-only statements used by change mapping.
   * Returns undefined for paths the adapter does not treat as source.
   */
  sourceSemantics?(projectRelPath: string): SourceSemantics | undefined;
}
