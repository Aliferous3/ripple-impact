import type { SourceRange } from "../graph/types.js";
import type { DetectedProject } from "../indexers/adapter.js";
import {
  commentRanges,
  extractDefs,
  literalRanges,
  typeOnlyModuleRanges,
  type SourceDef,
} from "./ast-defs.js";

/**
 * Per-language source semantics — the deterministic facts change mapping
 * needs beyond the normalized graph:
 *
 *  - extractDefs:           named defs + extents in raw file text (for
 *                           deleted-def tombstones and added-vs-modified)
 *  - commentRanges:         comment char ranges (hunk "non-semantic" test)
 *  - literalRanges:         ranges where whitespace is semantically
 *                           significant (string/template literal text)
 *  - typeOnlyModuleRanges:  top-level statements that can never execute
 *                           runtime bindings (import type, TYPE_CHECKING)
 *
 * Every implementation must be honest: ranges it cannot produce must come
 * back empty/conservative, never guessed.
 */
export interface SourceSemantics {
  extractDefs(file: string, text: string): SourceDef[];
  commentRanges(file: string, text: string): [number, number][];
  literalRanges(file: string, text: string): [number, number][];
  typeOnlyModuleRanges(file: string, text: string): SourceRange[];
}

/** TypeScript/JavaScript semantics — the compiler-backed implementation. */
export const tsSemantics: SourceSemantics = {
  extractDefs: (file, text) => extractDefs(file, text),
  commentRanges: (file, text) => commentRanges(file, text),
  literalRanges: (file, text) => literalRanges(file, text),
  typeOnlyModuleRanges: (file, text) => typeOnlyModuleRanges(file, text),
};

const TS_SOURCE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;

/** Pre-adapter behavior: TS-family extensions get TS semantics. */
const legacyTsResolver = (path: string): SourceSemantics | undefined =>
  TS_SOURCE.test(path) ? tsSemantics : undefined;

/**
 * Resolves source semantics for a repo-relative path by asking each
 * detected project's adapter (project-root-relative check). A path no
 * adapter claims gets no semantics — the caller treats it as not-indexed,
 * exactly like a non-source file.
 */
export function semanticsResolver(
  projects: DetectedProject[] | undefined,
): (path: string) => SourceSemantics | undefined {
  if (!projects || projects.length === 0) return legacyTsResolver;
  return (path) => {
    for (const p of projects) {
      const rel =
        p.root === ""
          ? path
          : path.startsWith(`${p.root}/`)
            ? path.slice(p.root.length + 1)
            : undefined;
      if (rel === undefined) continue;
      const sem = p.adapter.sourceSemantics?.(rel);
      if (sem) return sem;
    }
    return legacyTsResolver(path);
  };
}
