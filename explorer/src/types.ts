/**
 * The explorer consumes the engine's AnalysisResult verbatim — this file
 * only re-exports the stable types so components never invent parallel
 * schemas.
 */
export type {
  AnalysisResult,
  AffectedJson,
  ChangedSymbolJson,
} from "../../src/api/analyze.js";
export type { ChangedFile, DiffHunk, LineRange } from "../../src/git/types.js";
export type { SourceRange } from "../../src/graph/types.js";

export interface SourcePreview {
  file: string;
  start: number;
  end: number;
  totalLines: number;
  lines: string[];
}
