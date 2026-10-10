import type { SourceRange } from "../../graph/types.js";

/** SCIP occurrence range → Ripple SourceRange (0-based line/char). */
export function toRange(r: number[]): SourceRange {
  if (r.length === 3) {
    return { startLine: r[0], startChar: r[1], endLine: r[0], endChar: r[2] };
  }
  return { startLine: r[0], startChar: r[1], endLine: r[2], endChar: r[3] };
}

/** `outer` fully contains `inner` (inclusive bounds). */
export function contains(outer: SourceRange, inner: SourceRange): boolean {
  const starts = outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startChar <= inner.startChar);
  const ends = outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endChar >= inner.endChar);
  return starts && ends;
}

/** Rough size used to pick the innermost containing definition. */
export function extentSize(r: SourceRange): number {
  return (r.endLine - r.startLine) * 1_000_000 + (r.endChar - r.startChar);
}
