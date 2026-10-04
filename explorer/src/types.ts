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

export interface NodeDetail {
  node: {
    id: string;
    kind: string;
    name: string;
    file: string;
    range?: { startLine: number; startChar: number; endLine: number; endChar: number };
    extent?: { startLine: number; startChar: number; endLine: number; endChar: number };
  };
  out: { to: string; toName: string; kind: string; confidence: string; evidence: unknown[] }[];
  in: { from: string; fromName: string; kind: string; confidence: string; evidence: unknown[] }[];
  reach: { symbols: number; files: number; tests: number; directCallers: number };
}

export interface SourcePreview {
  file: string;
  start: number;
  end: number;
  totalLines: number;
  lines: string[];
}
