/**
 * Dumps the contents of a SCIP index (index.scip protobuf) in a readable form.
 * Usage: npx tsx scripts/dump-scip.ts <path-to-index.scip>
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { scip } = require("@sourcegraph/scip-typescript/dist/src/scip.js");

const ROLE_NAMES: [number, string][] = [
  [scip.SymbolRole.Definition, "Definition"],
  [scip.SymbolRole.Import, "Import"],
  [scip.SymbolRole.WriteAccess, "WriteAccess"],
  [scip.SymbolRole.ReadAccess, "ReadAccess"],
  [scip.SymbolRole.Generated, "Generated"],
  [scip.SymbolRole.Test, "Test"],
  [scip.SymbolRole.ForwardDefinition, "ForwardDefinition"],
];

function rolesToString(roles: number): string {
  if (roles === 0) return "(none)";
  return ROLE_NAMES.filter(([bit]) => (roles & bit) !== 0)
    .map(([, name]) => name)
    .join("|");
}

function rangeToString(range: number[]): string {
  if (range.length === 3) return `${range[0]}:${range[1]}-${range[2]}`;
  if (range.length === 4)
    return `${range[0]}:${range[1]}-${range[2]}:${range[3]}`;
  return `[${range.join(",")}]`;
}

const kindNames: Record<number, string> = {};
for (const [name, value] of Object.entries(scip.SymbolInformation.Kind)) {
  if (typeof value === "number") kindNames[value] = name;
}

const file = process.argv[2];
if (!file) {
  console.error("usage: dump-scip <index.scip>");
  process.exit(1);
}

const index = scip.Index.deserialize(readFileSync(file));
console.log(`metadata: ${JSON.stringify(index.metadata?.toObject?.() ?? {})}`);
console.log(`documents: ${index.documents.length}`);
console.log(`external symbols: ${index.external_symbols.length}`);

const mode = process.argv[3] ?? "all";

for (const doc of index.documents) {
  console.log(`\n=== DOCUMENT ${doc.relative_path} (language=${doc.language}) ===`);
  if (mode === "all" || mode === "symbols") {
    for (const sym of doc.symbols) {
      const kind = kindNames[sym.kind] ?? `kind=${sym.kind}`;
      console.log(`  SYMBOL ${sym.symbol}`);
      console.log(`    kind=${kind} display=${JSON.stringify(sym.display_name)} enclosing=${sym.enclosing_symbol || "(none)"}`);
      if (sym.documentation?.length)
        console.log(`    doc=${JSON.stringify(sym.documentation)}`);
      if (sym.signature_documentation?.text)
        console.log(`    sig=${JSON.stringify(sym.signature_documentation.text)}`);
      for (const rel of sym.relationships) {
        console.log(
          `    REL -> ${rel.symbol} impl=${rel.is_implementation} ref=${rel.is_reference} typedef=${rel.is_type_definition} def=${rel.is_definition}`,
        );
      }
    }
  }
  if (mode === "all" || mode === "occurrences") {
    for (const occ of doc.occurrences) {
      console.log(
        `  OCC ${rangeToString(occ.range)} roles=${rolesToString(occ.symbol_roles)} sym=${occ.symbol}` +
          (occ.enclosing_range.length ? ` enclosing=${rangeToString(occ.enclosing_range)}` : ""),
      );
    }
  }
}
