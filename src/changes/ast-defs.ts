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

/** True when `pos` falls inside any [start,end) range (ranges may overlap). */
export function inRanges(ranges: [number, number][], pos: number): boolean {
  return ranges.some(([s, e]) => pos >= s && pos < e);
}

/**
 * Char ranges where whitespace is semantically significant: the contents of
 * string literals and regex literals, plus the literal text chunks of
 * template literals. The `${...}` substitution expressions of a template are
 * deliberately excluded — whitespace there is ordinary code whitespace.
 */
export function literalRanges(fileName: string, text: string): [number, number][] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      // whole node incl. quotes/backticks/slashes — none are whitespace
      ranges.push([node.getStart(sf), node.end]);
    } else if (ts.isTemplateExpression(node)) {
      // `txt${expr}txt` — head `txt${` → +1..-2; middle `}txt${` → +1..-2;
      // tail `}txt`` → +1..-1
      const head = node.head;
      ranges.push([head.getStart(sf) + 1, head.end - 2]);
      for (const span of node.templateSpans) {
        const lit = span.literal;
        const tail = lit.kind === ts.SyntaxKind.TemplateTail;
        ranges.push([lit.getStart(sf) + 1, lit.end - (tail ? 1 : 2)]);
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return ranges;
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

/**
 * Line ranges of top-level statements that are provably type-only and can
 * never execute at runtime: `import type`, `import { type A, type B }`,
 * `import type X = require(...)`, `export type`, `export type { A }`.
 * Mixed imports (`import { type A, B }` or `import def, { type A }`) carry a
 * runtime binding and are NOT included.
 */
export function typeOnlyModuleRanges(fileName: string, text: string): SourceRange[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const rng = (start: number, end: number): SourceRange => ({
    startLine: sf.getLineAndCharacterOfPosition(start).line,
    startChar: sf.getLineAndCharacterOfPosition(start).character,
    endLine: sf.getLineAndCharacterOfPosition(end).line,
    endChar: sf.getLineAndCharacterOfPosition(end).character,
  });
  const ranges: SourceRange[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const cl = st.importClause;
      if (!cl) continue; // `import "x"` — side-effect import, runtime
      const typeOnly =
        !cl.name &&
        (cl.isTypeOnly ||
          (!!cl.namedBindings &&
            ts.isNamedImports(cl.namedBindings) &&
            cl.namedBindings.elements.length > 0 &&
            cl.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (typeOnly) ranges.push(rng(st.getStart(sf), st.end));
    } else if (ts.isExportDeclaration(st) && st.isTypeOnly) {
      ranges.push(rng(st.getStart(sf), st.end));
    } else if (ts.isImportEqualsDeclaration(st) && st.isTypeOnly) {
      ranges.push(rng(st.getStart(sf), st.end));
    } else if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) {
      // `export type A = ...` / `export interface I { ... }` — erasable even
      // when a hunk inside the declaration doesn't map to a member symbol.
      ranges.push(rng(st.getStart(sf), st.end));
    }
  }
  return ranges;
}

/**
 * Strip comments + insignificant whitespace: stable normalization for body
 * comparison. Whitespace inside string/template literals is preserved —
 * changing it changes behavior.
 */
export function normalizeBody(fileName: string, text: string): string {
  const comments = commentRanges(fileName, text);
  const literals = literalRanges(fileName, text);
  let out = "";
  for (let c = 0; c < text.length; c++) {
    const ch = text[c];
    if (/\s/.test(ch) && !inRanges(literals, c)) continue;
    if (inRanges(comments, c)) continue;
    out += ch;
  }
  return out;
}
