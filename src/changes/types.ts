import type { GraphNode } from "../graph/types.js";
import type { FileStatus, LineRange } from "../git/types.js";

export type ChangeKind =
  /** Existing symbol whose extent intersects changed lines. */
  | "modified"
  /** Symbol whose definition lies entirely inside added lines, or a new file. */
  | "added"
  /** Symbol that existed in the old revision but not in the new one. */
  | "deleted"
  /**
   * Deleted symbol + added symbol with byte-identical normalized bodies
   * (comments/whitespace stripped). Deterministic evidence of a rename/move.
   */
  | "renamed"
  /** Changed lines outside every symbol extent — file-level code
   *  (imports, top-level statements, comments-attached regions). */
  | "module-scope";

export interface ChangedSymbol {
  /** Graph node for present-in-current symbols; absent for deleted ones. */
  node?: GraphNode;
  /** SCIP symbol id, or a tombstone id (`deleted:<file>:<name>`). */
  symbolId: string;
  name: string;
  file: string;
  changeKind: ChangeKind;
  /**
   * For renamed/moved symbols: the old display name (and file, if moved).
   * Only set when normalized bodies matched exactly.
   */
  renamedFrom?: { name: string; file: string };
  /** The hunk line-ranges that justify the attribution. */
  evidence: { file: string; oldRange?: LineRange; newRange?: LineRange }[];
  /**
   * Module-scope changes whose every changed line sits inside provably
   * type-only statements (`import type`, `export type`, all-type named
   * imports). Seeds type-impact traversal only — never runtime propagation.
   */
  typeOnly?: boolean;
}

export interface NonSemanticChange {
  file: string;
  kind: "non-semantic";
  newRange?: LineRange;
  oldRange?: LineRange;
}

export interface UnmappedFile {
  file: string;
  status: FileStatus;
  reason: "binary" | "not-indexed" | "unreadable";
}

export interface ChangeSet {
  changed: ChangedSymbol[];
  nonSemantic: NonSemanticChange[];
  unmappedFiles: UnmappedFile[];
  renamedFiles: { from: string; to: string }[];
}
