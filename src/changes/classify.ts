import type { DiffHunk } from "../git/types.js";
import { inRanges } from "./ast-defs.js";
import { tsSemantics, type SourceSemantics } from "./semantics.js";

export type HunkClass = "code" | "non-semantic";

/**
 * Deterministically classifies whether a diff hunk changed executable code.
 *
 * For each side of the hunk, every changed line is reduced to its
 * non-comment, non-whitespace characters (comment regions come from the real
 * file's AST, so `//` inside a string literal still counts as code). If both
 * sides reduce to the same string, nothing semantic changed — the hunk is
 * "non-semantic" and covers: comment edits, comment add/remove on code
 * lines, whitespace, reindentation, and line reflows.
 *
 * Whitespace inside string, regex, and template-literal text is preserved
 * (literal char ranges come from the file's AST), so `"$ git log"` →
 * `"$  git log"` is correctly "code". Whitespace inside `${...}` template
 * substitutions remains ordinary code whitespace and stays filterable.
 *
 * When a file's text is unavailable the hunk is classified "code"
 * (conservative: better to attribute than to silently drop).
 */
export function classifyHunk(
  fileName: string,
  hunk: DiffHunk,
  oldText: string | undefined,
  newText: string | undefined,
  semantics: SourceSemantics = tsSemantics,
): HunkClass {
  if (oldText !== undefined && newText !== undefined) {
    const oldCode = codeChars(fileName, oldText, hunk.removedLines, hunk.oldRange.start, semantics);
    const newCode = codeChars(fileName, newText, hunk.addedLines, hunk.newRange.start, semantics);
    return oldCode === newCode ? "non-semantic" : "code";
  }
  const strip = (s: string): string => s.replace(/\s+/g, "");
  return strip(hunk.removedLines.join("\n")) === strip(hunk.addedLines.join("\n"))
    ? "non-semantic"
    : "code";
}

/**
 * Concatenated non-comment, non-whitespace characters of `lines`
 * (file line numbers starting at `firstLine`, 1-based).
 */
function codeChars(
  fileName: string,
  text: string,
  lines: string[],
  firstLine: number,
  semantics: SourceSemantics,
): string {
  const comments = semantics.commentRanges(fileName, text);
  const literals = semantics.literalRanges(fileName, text);
  const lineStarts = lineStartOffsets(text);
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const lineNo = firstLine + i - 1; // 0-based
    const start = lineStarts[lineNo];
    if (start === undefined) continue;
    const end = lineNo + 1 < lineStarts.length ? lineStarts[lineNo + 1] : text.length;
    for (let c = start; c < Math.min(end, start + lines[i].length); c++) {
      const ch = text[c];
      if (/\s/.test(ch) && !inRanges(literals, c)) continue;
      if (inRanges(comments, c)) continue;
      out += ch;
    }
  }
  return out;
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}
