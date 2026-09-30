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
 */

export type RangeKey = string;

export function rangeKey(r: SourceRange): RangeKey {
  return `${r.startLine}:${r.startChar}:${r.endLine}:${r.endChar}`;
}

export interface FileCallSites {
  /** Range keys (0-based line/char) of identifiers/names used as call callees. */
  calleeRanges: Set<RangeKey>;
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

  const record = (nameNode: ts.Node): void => {
    const start = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(nameNode.getEnd());
    calleeRanges.add(
      `${start.line}:${start.character}:${end.line}:${end.character}`,
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = calleeNameNode(node.expression);
      if (callee) record(callee);
    } else if (ts.isTaggedTemplateExpression(node)) {
      const callee = calleeNameNode(node.tag);
      if (callee) record(callee);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { calleeRanges };
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
