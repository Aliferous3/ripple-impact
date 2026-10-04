/** Position/range as 0-based line/character (SCIP convention). */
export interface SourceRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export type NodeKind =
  | "file"
  | "function"
  | "method"
  | "class"
  | "interface"
  | "variable"
  | "test";

export interface GraphNode {
  /** Stable identifier. For SCIP-sourced nodes this is the SCIP symbol string. */
  id: string;
  kind: NodeKind;
  /** Short display name, e.g. "refreshSession()", "Session#refresh()". */
  name: string;
  /** Repo-relative file path. */
  file: string;
  /** Range of the symbol's name at its definition site. */
  range?: SourceRange;
  /**
   * Full declaration extent (signature + body) when known — SCIP
   * `enclosing_range`. Used to map changed line ranges to symbols.
   */
  extent?: SourceRange;
}

export type EdgeKind =
  | "contains"
  | "imports"
  | "calls"
  /**
   * A symbol renders another as a JSX element (`<Foo />` inside a component's
   * returned JSX). Deterministic AST evidence: the tag name's range is a JSX
   * opening/closing/self-closing tag that resolved to an indexed symbol.
   * Only component-shaped tags are recorded (uppercase identifier or
   * `<UI.Button />`-style member whose property name is uppercase) —
   * intrinsics like `<div>` never produce edges. Propagates runtime impact:
   * rendering a component executes it.
   */
  | "jsx_uses"
  | "references"
  | "implements"
  /**
   * A symbol consumes another symbol in a genuine type position
   * (annotation, type reference, heritage clause, `typeof`). Propagates
   * type impact — never runtime impact. Not created by bare imports.
   */
  | "type_depends";

export type EvidenceSource = "scip" | "typescript-ast";

/**
 * Why Ripple believes a relationship exists. Every edge carries at least one
 * piece of evidence pointing at concrete source code.
 */
export interface Evidence {
  file: string;
  range: SourceRange;
  source: EvidenceSource;
  /** What the evidence is, e.g. "call-site", "import-specifier", "identifier". */
  detail?: string;
}

export interface GraphEdge {
  /** Node id of the dependent end (e.g. the caller). */
  from: string;
  /** Node id of the depended-upon end (e.g. the callee). */
  to: string;
  kind: EdgeKind;
  evidence: Evidence[];
  confidence: "certain" | "high" | "inferred";
}

export interface RippleGraphData {
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
