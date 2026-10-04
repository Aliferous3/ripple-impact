import ts from "typescript";
import type { SourceRange } from "../../graph/types.js";

/**
 * Syntactic call-site classifier.
 *
 * SCIP records *that* an identifier references a symbol but not *how* it is
 * used. This pass walks the TypeScript AST (parser only — no type checker;
 * symbol identity is already resolved by SCIP) and records the source ranges
 * of every call-expression callee name. A SCIP reference occurrence whose
 * range matches a callee range is therefore a `calls` relationship; anything
 * else stays `references`.
 *
 * Covered: `f()`, `obj.m()`, `new C()`, `obj["m"]()`, `tag\`...\``.
 * `await f()`, `f()()` etc. fall out naturally since the callee expression is
 * still a CallExpression callee.
 *
 * It also records JSX component-tag ranges (`jsxTagRanges`): `<Foo />` and
 * `<Foo></Foo>` execute `Foo` when rendered, so a matching SCIP occurrence
 * becomes a `jsx_uses` edge rather than a bare `references`. Only
 * component-shaped tags qualify — uppercase identifiers and member tags
 * whose property name is uppercase (`<UI.Button />`). Intrinsics (`<div>`)
 * and unprovable tags (`<motion.div>`, `<a:b>`) are never recorded.
 */

export type RangeKey = string;

export function rangeKey(r: SourceRange): RangeKey {
  return `${r.startLine}:${r.startChar}:${r.endLine}:${r.endChar}`;
}

export interface FileCallSites {
  /** Range keys (0-based line/char) of identifiers/names used as call callees. */
  calleeRanges: Set<RangeKey>;
  /**
   * Range keys of JSX tag names that denote components: `<Foo />`,
   * `<Foo></Foo>`, `</Foo>` (identifier starting uppercase) and
   * `<UI.Button />` (property name starting uppercase). Intrinsic DOM tags
   * like `<div>` are never recorded.
   */
  jsxTagRanges: Set<RangeKey>;
}

export function classifyFile(fileName: string, sourceText: string): FileCallSites {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    scriptKindFor(fileName),
  );
  const calleeRanges = new Set<RangeKey>();
  const jsxTagRanges = new Set<RangeKey>();

  const keyOf = (nameNode: ts.Node): RangeKey => {
    const start = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(nameNode.getEnd());
    return `${start.line}:${start.character}:${end.line}:${end.character}`;
  };

  const record = (nameNode: ts.Node): void => {
    calleeRanges.add(keyOf(nameNode));
  };

  /**
   * The node whose range a SCIP occurrence would report for a JSX tag:
   * `Foo` for `<Foo/>`, `Button` for `<UI.Button/>`. Returns undefined for
   * anything not provably a component — intrinsics (`<div>`), lowercase
   * member tags (`<motion.div>`), namespaced tags (`<a:b>`).
   */
  const jsxComponentNameNode = (tag: ts.JsxTagNameExpression): ts.Node | undefined => {
    const upper = (s: string): boolean => /^[A-Z]/.test(s);
    if (ts.isIdentifier(tag)) return upper(tag.text) ? tag : undefined;
    if (ts.isPropertyAccessExpression(tag)) {
      return upper(tag.name.text) ? tag.name : undefined;
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = calleeNameNode(node.expression);
      if (callee) record(callee);
    } else if (ts.isTaggedTemplateExpression(node)) {
      const callee = calleeNameNode(node.tag);
      if (callee) record(callee);
    } else if (
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxOpeningElement(node) ||
      ts.isJsxClosingElement(node)
    ) {
      const tag = jsxComponentNameNode(node.tagName);
      if (tag) jsxTagRanges.add(keyOf(tag));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { calleeRanges, jsxTagRanges };
}

/**
 * For `f()`/`new f()` return the node whose range a SCIP occurrence would use:
 *  - `f()`        -> the identifier `f`
 *  - `a.b.c()`    -> the property name `c`
 *  - `a["b"]()`   -> the string literal `"b"`
 *  - anything else (e.g. `(getFn())()`) -> undefined; inner refs are handled
 *    on their own terms.
 */
function calleeNameNode(expr: ts.Expression): ts.Node | undefined {
  if (ts.isIdentifier(expr) || ts.isPrivateIdentifier(expr)) return expr;
  if (ts.isPropertyAccessExpression(expr)) return expr.name;
  if (
    ts.isElementAccessExpression(expr) &&
    ts.isStringLiteralLike(expr.argumentExpression)
  ) {
    return expr.argumentExpression;
  }
  return undefined;
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs"))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
