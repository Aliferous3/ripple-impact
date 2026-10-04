import ts from "typescript";
import type { RangeKey } from "./call-classifier.js";

/**
 * Syntactic type-position classifier — the second half of the "SCIP +
 * deterministic AST enrichment" architecture.
 *
 * SCIP records *that* an identifier references a symbol but not *where* the
 * reference sits grammatically. This pass records the source ranges of named
 * type usages that appear in genuine type positions:
 *
 *   - TypeReference nodes        `x: User`, `Array<User>`, `type A = B`
 *   - Heritage clauses           `class C extends B`, `interface I extends J`,
 *                                `class C implements I`
 *   - Type queries               `typeof value` (type depends on a value)
 *
 * What is deliberately NOT recorded — import/export specifier names are not
 * type nodes, so `import type { User } from "./types"` alone yields no edge:
 * the edge appears only when something actually *consumes* the type. That is
 * the conservative contract: a type-position occurrence is evidence of real
 * type usage, not of a possible relationship.
 *
 * scip-typescript quirk handled here: `import type` statements bind
 * `local N` aliases — SCIP occurrences at type positions then point at a
 * local rather than the imported symbol. The classifier therefore also
 * records the alias table (`import type { A as B } from "m"` → B⇒{m,A}) and
 * the identifier text at each type-position range, so the indexer can
 * resolve a local occurrence back to the real imported symbol.
 */

export type TypePositionDetail =
  | "type-reference"
  | "heritage-clause"
  | "type-query";

export interface TypePositionHit {
  detail: TypePositionDetail;
  /** Identifier text at this range, e.g. "User". */
  name: string;
  /**
   * For qualified names (`ns.User`): the leftmost root identifier ("ns").
   * Undefined for simple names — the local-alias lookup keys off `root`
   * first so `ns.User` resolves through the `ns` binding.
   */
  root?: string;
}

export interface ImportTypeAlias {
  /** Module specifier exactly as written, e.g. "./types". */
  module: string;
  /**
   * Exported name in the target module ("User"), "*" for a namespace alias
   * (`import type * as N`), or "default" for a default import.
   */
  imported: string;
}

export interface FileTypePositions {
  /** Range key → type-position usage at that range. */
  ranges: Map<RangeKey, TypePositionHit>;
  /**
   * Local alias name → import target, for `import type` statements only.
   * Inline `import { type X }` modifiers resolve natively in SCIP and do
   * not appear here.
   */
  importTypeAliases: Map<string, ImportTypeAlias>;
}

export function typePositionsOfFile(
  fileName: string,
  sourceText: string,
): FileTypePositions {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    scriptKindFor(fileName),
  );
  const ranges = new Map<RangeKey, TypePositionHit>();
  const importTypeAliases = new Map<string, ImportTypeAlias>();

  const record = (nameNode: ts.Identifier, hit: Omit<TypePositionHit, "name">): void => {
    const start = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(nameNode.getEnd());
    ranges.set(`${start.line}:${start.character}:${end.line}:${end.character}`, {
      ...hit,
      name: nameNode.text,
    });
  };

  /** Rightmost name of an EntityName (`User` / `ns.User` → `User`). */
  const entityName = (n: ts.EntityName): ts.Identifier =>
    ts.isIdentifier(n) ? n : entityName(n.right);
  /** Leftmost name of a (possibly qualified) EntityName. */
  const entityRoot = (n: ts.EntityName): ts.Identifier | undefined =>
    ts.isIdentifier(n) ? undefined : entityRoot(n.left) ?? n.left as ts.Identifier;
  /** Leftmost identifier of a property-access chain (`a.b.c` → `a`). */
  const leftmost = (e: ts.Expression): ts.Identifier | undefined =>
    ts.isIdentifier(e)
      ? e
      : ts.isPropertyAccessExpression(e)
        ? leftmost(e.expression)
        : undefined;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      // Type-only bindings surface as `local` SCIP symbols — record them so
      // `local` occurrences can be resolved to the imported symbol
      // downstream. Covers `import type {…}` plus inline `import { type X }`
      // specifiers (scip-typescript emits locals for both when no value
      // binding shares the statement).
      const module = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : "";
      const clause = node.importClause;
      const typeOnly = clause.isTypeOnly;
      if (typeOnly && clause.name) {
        importTypeAliases.set(clause.name.text, { module, imported: "default" });
      }
      const nb = clause.namedBindings;
      if (typeOnly && nb && ts.isNamespaceImport(nb)) {
        importTypeAliases.set(nb.name.text, { module, imported: "*" });
      } else if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          if (!typeOnly && !el.isTypeOnly) continue;
          importTypeAliases.set(el.name.text, {
            module,
            imported: (el.propertyName ?? el.name).text,
          });
        }
      }
    }

    if (ts.isTypeReferenceNode(node)) {
      const name = entityName(node.typeName);
      const root = entityRoot(node.typeName);
      record(name, { detail: "type-reference", root: root?.text });
    } else if (ts.isTypeQueryNode(node)) {
      // `typeof x` — the type depends on the referenced value's type.
      const name = entityName(node.exprName);
      const root = entityRoot(node.exprName);
      record(name, { detail: "type-query", root: root?.text });
    } else if (ts.isExpressionWithTypeArguments(node)) {
      // Heritage clause name (`extends B`, `implements I`). The expression is
      // an Identifier or PropertyAccessExpression — record its name node.
      const e = node.expression;
      if (ts.isIdentifier(e)) {
        record(e, { detail: "heritage-clause" });
      } else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
        record(e.name, { detail: "heritage-clause", root: leftmost(e)?.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { ranges, importTypeAliases };
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs"))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
