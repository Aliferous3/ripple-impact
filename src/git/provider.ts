import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseGitDiff } from "./parse.js";
import type { ChangedFile, DiffOptions, GitDiff } from "./types.js";

/**
 * Git adapter. All diff data comes from `git diff --no-color -U0` — a stable
 * machine-oriented format (hunk headers + changed lines only).
 *
 * Semantics:
 *   getDiff({repo})            → HEAD vs working tree (staged + unstaged tracked
 *                                changes, plus untracked files reported as added)
 *   getDiff({repo, base})      → merge-base(base, HEAD) vs working tree
 *                                ("everything this branch changed + local edits")
 */
export class GitDiffProvider {
  constructor(private readonly repo: string) {}

  getDiff(options: DiffOptions): GitDiff {
    const repo = options.repo ?? this.repo;
    let oldRev = "HEAD";
    if (options.base) {
      oldRev = this.mergeBase(repo, options.base) ?? options.base;
    }

    const raw = git(repo, ["diff", "--no-color", "-U0", oldRev]);
    const files = parseGitDiff(raw);

    // Untracked files are invisible to `git diff`; add them as whole-file adds.
    const untracked = git(repo, ["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const rel of untracked) {
      const abs = join(repo, rel);
      let lines: string[] = [];
      try {
        const buf = readFileSync(abs);
        if (buf.includes(0)) {
          files.push({
            path: rel.split("\\").join("/"),
            status: "added",
            hunks: [],
            binary: true,
          });
          continue;
        }
        lines = buf.toString("utf8").split("\n");
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
      } catch {
        continue;
      }
      files.push({
        path: rel.split("\\").join("/"),
        status: "added",
        hunks:
          lines.length === 0
            ? []
            : [
                {
                  oldRange: { start: 0, end: 0 },
                  newRange: { start: 1, end: lines.length + 1 },
                  removedLines: [],
                  addedLines: lines,
                },
              ],
      });
    }

    return {
      oldRev,
      newRev: "working tree",
      files,
      untrackedFiles: untracked,
    };
  }

  /** File contents at a revision, or undefined if it doesn't exist there. */
  showFile(rev: string, path: string): string | undefined {
    try {
      return git(this.repo, ["show", `${rev}:${path.replace(/\\/g, "/")}`]);
    } catch {
      return undefined;
    }
  }

  /** Working-tree file contents (undefined for deleted/missing files). */
  readWorktreeFile(path: string): string | undefined {
    const abs = join(this.repo, path);
    if (!existsSync(abs)) return undefined;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  }

  revParse(ref: string): string | undefined {
    try {
      return git(this.repo, ["rev-parse", "--verify", ref]).trim();
    } catch {
      return undefined;
    }
  }

  private mergeBase(repo: string, ref: string): string | undefined {
    try {
      return git(repo, ["merge-base", ref, "HEAD"]).trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
