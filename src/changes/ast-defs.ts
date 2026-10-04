import ts from "typescript";
import type { SourceRange } from "../graph/types.js";

export interface SourceDef {
  /** Display-ish name: "foo", "Cls", "Cls#method". */
  name: string;
  kind: "function" | "method" | "class" | "variable";
  /** Range of the identifier. */
  nameRange: SourceRange;
  /** Full declaration extent (signature + body), getStart()..end. */
  extent: SourceRange;
  /** Raw source text of the extent (for body comparison / rename detection). */
  bodyText: string;
  /**
   * False when the def is nested inside a function/method/arrow body —
   * i.e. a local that can never be a graph-addressable symbol.
   */
  topLevel: boolean;
}

/**
 * Extracts named declarations + extents from raw source text. Used on OLD
 * revision file contents (from `git show`) to attribute deleted line ranges
 * to symbols that no longer exist in the current index — the deterministic,
 * low-cost alternative to indexing the base revision.
 */
export function extractDefs(fileName: string, text: string): SourceDef[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const defs: SourceDef[] = [];

  const rng = (start: number, end: number): SourceRange => ({
    startLine: sf.getLineAndCharacterOfPosition(start).line,
    startChar: sf.getLineAndCharacterOfPosition(start).character,
    endLine: sf.getLineAndCharacterOfPosition(end).line,
    endChar: sf.getLineAndCharacterOfPosition(end).character,
  });

  const isFnBoundary = (n: ts.Node): boolean =>
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n);

  const visit = (node: ts.Node, classPrefix: string | undefined, insideFn: boolean): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const start = node.getStart(sf);
      defs.push({
        name: (classPrefix ?? "") + node.name.text,
        kind: classPrefix ? "method" : "function",
        nameRange: rng(node.name.getStart(sf), node.name.end),
        extent: rng(start, node.end),
        bodyText: text.slice(start, node.end),
        topLevel: !insideFn,
      });
      node.forEachChild((c) => visit(c, undefined, true));
      return;
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const start = node.getStart(sf);
      const clsName = (classPrefix ?? "") + node.name.text;
      defs.push({
        name: clsName,
        kind: "class",
        nameRange: rng(node.name.getStart(sf), node.name.end),
        extent: rng(start, node.end),
        bodyText: text.slice(start, node.end),
        topLevel: !insideFn,
      });
      for (const member of node.members) {
        const isMethod = ts.isMethodDeclaration(member) ||
          ts.isConstructorDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member);
        const isProp = ts.isPropertyDeclaration(member);
        if (!isMethod && !isProp) continue;
        // PrivateIdentifier covers ES `#x` names; constructors have no name.
        const memberName = ts.isConstructorDeclaration(member)
          ? "<constructor>"
          : member.name?.getText(sf);
        if (!memberName) continue;
        const mStart = member.getStart(sf);
        const nameStart = member.name?.getStart(sf) ?? mStart;
        defs.push({
          // SCIP renders ES-private `#x` members as `Cls##x` — class prefix
          // + getText() reproduces that ("#" + "#x").
          name: `${clsName}#${memberName}`,
          kind: isMethod ? "method" : "variable",
          nameRange: rng(nameStart, member.name?.end ?? nameStart),
          extent: rng(mStart, member.end),
          bodyText: text.slice(mStart, member.end),
          topLevel: true, // class members are graph-addressable
        });
      }
      node.forEachChild((c) => visit(c, undefined, true));
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const start = node.getStart(sf);
        const isFn =
          !!decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
        defs.push({
          name: decl.name.text,
          kind: isFn ? "function" : "variable",
          nameRange: rng(decl.name.getStart(sf), decl.name.end),
          extent: rng(start, decl.end),
          bodyText: text.slice(start, decl.end),
          topLevel: !insideFn,
        });
      }
    }
    node.forEachChild((c) => visit(c, undefined, insideFn || isFnBoundary(node)));
  };

  visit(sf, undefined, false);
  return defs;
}

/** All comment ranges in the file, as [start,end) char offsets. */
export function commentRanges(fileName: string, text: string): [number, number][] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    for (const r of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
      ranges.push([r.pos, r.end]);
    }
    for (const r of ts.getTrailingCommentRanges(text, node.end) ?? []) {
      ranges.push([r.pos, r.end]);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return ranges;
}

/** Strip comments + whitespace: stable normalization for body comparison. */
export function normalizeBody(fileName: string, text: string): string {
  const stripped = stripComments(fileName, text);
  return stripped.replace(/\s+/g, "");
}

function stripComments(fileName: string, text: string): string {
  const removals = commentRanges(fileName, text).sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [s, e] of removals) {
    if (s < pos) continue;
    out += text.slice(pos, s);
    pos = e;
  }
  out += text.slice(pos);
  return out;
}
