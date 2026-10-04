import type { ChangedFile, DiffHunk, FileStatus } from "./types.js";

/**
 * Parses `git diff --no-color -U0` output into structured hunks.
 * -U0 emits zero context lines, so hunk bodies contain only changed lines and
 * hunk ranges are exactly the changed line ranges (not approximations).
 */

const DIFF_GIT = /^diff --git ("?)(.+?)\1 ("?)(.+?)\3$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseGitDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;
  let hunk: DiffHunk | undefined;
  let isBinary = false;
  let sawMarker = false; // saw ---/+++ markers

  const flush = (): void => {
    // Binary files are kept (flagged, no hunks) so callers can surface a
    // BINARY_SKIPPED warning instead of silently dropping them.
    if (current) files.push(isBinary ? { ...current, hunks: [], binary: true } : current);
    current = undefined;
    hunk = undefined;
    isBinary = false;
    sawMarker = false;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    const dg = DIFF_GIT.exec(line);
    if (dg) {
      flush();
      const aPath = unquote(dg[2]);
      const bPath = unquote(dg[4]);
      current = {
        path: stripPrefix(bPath),
        oldPath: stripPrefix(aPath),
        status: "modified",
        hunks: [],
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      isBinary = true;
      continue;
    }
    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("similarity index") || line.startsWith("dissimilarity index") ||
        line.startsWith("index ") || line.startsWith("old mode") ||
        line.startsWith("new mode") || line.startsWith("copy from") ||
        line.startsWith("copy to")) {
      continue;
    }
    if (line.startsWith("--- ")) {
      sawMarker = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      continue;
    }

    const hm = HUNK.exec(line);
    if (hm) {
      hunk = {
        oldRange: { start: Number(hm[1]), end: Number(hm[1]) + Number(hm[2] ?? 1) },
        newRange: { start: Number(hm[3]), end: Number(hm[3]) + Number(hm[4] ?? 1) },
        removedLines: [],
        addedLines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      hunk.addedLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      hunk.removedLines.push(line.slice(1));
    }
    // With -U0 there are no context lines; tolerate and ignore them anyway.
  }
  flush();
  return files;
}

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    return p.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return p;
}

function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}
