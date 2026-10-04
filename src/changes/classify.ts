import type { DiffHunk } from "../git/types.js";
import { commentRanges } from "./ast-defs.js";

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
 * Caveat (documented): a whitespace-only change *inside a string literal*
 * is misclassified non-semantic, since literal contents are not parsed for
 * whitespace significance.
 *
 * When a file's text is unavailable the hunk is classified "code"
 * (conservative: better to attribute than to silently drop).
 */
export function classifyHunk(
  fileName: string,
  hunk: DiffHunk,
  oldText: string | undefined,
  newText: string | undefined,
): HunkClass {
  if (oldText !== undefined && newText !== undefined) {
    const oldCode = codeChars(fileName, oldText, hunk.removedLines, hunk.oldRange.start);
    const newCode = codeChars(fileName, newText, hunk.addedLines, hunk.newRange.start);
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
): string {
  const comments = commentRanges(fileName, text);
  const lineStarts = lineStartOffsets(text);
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    const lineNo = firstLine + i - 1; // 0-based
    const start = lineStarts[lineNo];
    if (start === undefined) continue;
    const end = lineNo + 1 < lineStarts.length ? lineStarts[lineNo + 1] : text.length;
    for (let c = start; c < Math.min(end, start + lines[i].length); c++) {
      const ch = text[c];
      if (/\s/.test(ch)) continue;
      if (comments.some(([s, e]) => c >= s && c < e)) continue;
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
