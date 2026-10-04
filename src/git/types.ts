/** A line range in a file, 1-based inclusive start / exclusive end. */
export interface LineRange {
  /** First line (1-based). */
  start: number;
  /** One past the last line. start === end means "no lines" (pure deletion point). */
  end: number;
}

export interface DiffHunk {
  /** Line range in the OLD revision. */
  oldRange: LineRange;
  /** Line range in the NEW revision (working tree or HEAD). */
  newRange: LineRange;
  /** Removed line contents (without the leading `-`). */
  removedLines: string[];
  /** Added line contents (without the leading `+`). */
  addedLines: string[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  /** Repo-relative path in the NEW revision. */
  path: string;
  /** Repo-relative path in the OLD revision (renames only). */
  oldPath?: string;
  status: FileStatus;
  hunks: DiffHunk[];
}

export interface GitDiff {
  /** Ref/desc of the old side ("HEAD", "merge-base of main", a sha). */
  oldRev: string;
  /** Description of the new side for display ("working tree", "HEAD"). */
  newRev: string;
  files: ChangedFile[];
  /** Untracked files treated as additions. */
  untrackedFiles: string[];
}

export interface DiffOptions {
  /** Repo root containing .git. */
  repo: string;
  /**
   * Base ref. Semantics:
   *  - omitted: diff = HEAD → working tree (staged + unstaged + untracked)
   *  - given:   diff = merge-base(base, HEAD) → working tree
   *             i.e. "everything my branch changed, plus local edits"
   */
  base?: string;
}
