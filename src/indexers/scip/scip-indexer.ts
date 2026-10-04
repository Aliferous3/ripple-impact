import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { RippleGraph, isTestFile } from "../../graph/graph.js";
import type { Indexer, IndexOptions } from "../indexer.js";
import type { SourceRange } from "../../graph/types.js";
import { displayNameFor, nodeKindFor, parseScipSymbol } from "./symbol.js";
import { classifyFile, rangeKey, type FileCallSites } from "../enrich/call-classifier.js";

const require = createRequire(import.meta.url);
// SCIP protobuf bindings vendored inside scip-typescript (protoc-gen-ts output).
const { scip } = require("@sourcegraph/scip-typescript/dist/src/scip.js");

const DEFINITION = 1; // scip.SymbolRole.Definition

interface DefSite {
  symbol: string;
  range: SourceRange;
  /** Full extent of the declaration (body included) — SCIP `enclosing_range`. */
  extent: SourceRange;
}

/**
 * Converts a SCIP index (produced by scip-typescript) into a RippleGraph.
 *
 * What SCIP provides natively:
 *   - definition occurrences (+ `enclosing_range` = full declaration extent)
 *   - reference occurrences resolved to canonical, alias-dealiased symbols
 *   - module symbols (file-level, `.../\`file.ts\`/`) referenced by import strings
 *   - SymbolInformation.relationships with is_implementation
 *   - SymbolInformation.documentation = TS hover text (used for kind detection)
 *
 * What it does NOT provide, and we add deterministically:
 *   - call sites vs plain references (a syntactic AST pass classifies them)
 *   - SymbolInformation.kind / display_name (parsed from the symbol string)
 */
export function buildGraphFromScipIndex(
  indexBytes: Uint8Array,
  root: string,
): RippleGraph {
  const index = scip.Index.deserialize(indexBytes);
  const graph = new RippleGraph(root);

  interface DocData {
    relativePath: string;
    moduleSymbol: string | undefined;
    defs: DefSite[];
    occurrences: any[];
    symbolInfo: Map<string, any>;
  }

  const docs: DocData[] = [];
  // Pass 1: collect definitions and create all nodes so cross-file references
  // can target them regardless of document order.
  for (const doc of index.documents) {
    const relativePath = (doc.relative_path as string).replace(/\\/g, "/");
    const symbolInfo = new Map<string, any>();
    for (const sym of doc.symbols) symbolInfo.set(sym.symbol, sym);

    const defs: DefSite[] = [];
    let moduleSymbol: string | undefined;
    for (const occ of doc.occurrences) {
      if ((occ.symbol_roles & DEFINITION) === 0) continue;
      const parsed = parseScipSymbol(occ.symbol);
      if (!parsed) continue;
      const range = toRange(occ.range);
      const extent = occ.enclosing_range.length ? toRange(occ.enclosing_range) : range;
      if (parsed.descriptorKind === "module") {
        moduleSymbol = occ.symbol;
      } else {
        defs.push({ symbol: occ.symbol, range, extent });
      }
    }
    docs.push({ relativePath, moduleSymbol, defs, occurrences: doc.occurrences, symbolInfo });
  }

  const nodeIds = new Set<string>();
  for (const d of docs) {
    if (d.moduleSymbol) {
      const isTest = isTestFile(d.relativePath);
      graph.addNode({
        id: d.moduleSymbol,
        kind: isTest ? "test" : "file",
        name: d.relativePath.split("/").pop() ?? d.relativePath,
        file: d.relativePath,
      });
      nodeIds.add(d.moduleSymbol);
    }
    for (const def of d.defs) {
      const parsed = parseScipSymbol(def.symbol);
      if (!parsed) continue;
      const docText = hoverText(d.symbolInfo.get(def.symbol));
      let kind = nodeKindFor(parsed, docText);
      if (!kind) continue; // parameters, type params
      if (isTestFile(d.relativePath) && kind === "function") kind = "test";
      graph.addNode({
        id: def.symbol,
        kind,
        name: displayNameFor(parsed),
        file: d.relativePath,
        range: def.range,
        extent: def.extent,
      });
      nodeIds.add(def.symbol);
    }
  }

  // Pass 2: contains edges + occurrence-derived edges.
  let classifiedFiles = 0;
  for (const d of docs) {
    if (!d.moduleSymbol) continue;
    const fileNodeId = d.moduleSymbol;

    // contains: parent = smallest definition extent containing the child's name
    // range; file node when nothing else does.
    for (const child of d.defs) {
      if (!nodeIds.has(child.symbol)) continue;
      let parent: string | undefined;
      let parentSize = Infinity;
      for (const cand of d.defs) {
        if (cand.symbol === child.symbol) continue;
        if (!nodeIds.has(cand.symbol)) continue;
        if (!contains(cand.extent, child.range)) continue;
        const size = extentSize(cand.extent);
        if (size < parentSize) {
          parentSize = size;
          parent = cand.symbol;
        }
      }
      graph.addEdge(parent ?? fileNodeId, child.symbol, "contains", {
        file: d.relativePath,
        range: child.range,
        source: "scip",
        detail: "definition",
      });
    }

    // Syntactic enrichment: which ranges are call-expression callees.
    let callSites: FileCallSites = { calleeRanges: new Set() };
    try {
      const sourceText = readFileSync(join(root, d.relativePath), "utf8");
      callSites = classifyFile(d.relativePath, sourceText);
      classifiedFiles++;
    } catch {
      // File unreadable — all occurrences stay "references".
    }

    // Innermost-def attribution for occurrences.
    const extentOf = (r: SourceRange): string => {
      let best: DefSite | undefined;
      let bestSize = Infinity;
      for (const def of d.defs) {
        if (!nodeIds.has(def.symbol)) continue;
        if (!contains(def.extent, r)) continue;
        const size = extentSize(def.extent);
        if (size < bestSize) {
          bestSize = size;
          best = def;
        }
      }
      return best?.symbol ?? fileNodeId;
    };

    for (const occ of d.occurrences) {
      if ((occ.symbol_roles & DEFINITION) !== 0) continue;
      const parsed = parseScipSymbol(occ.symbol);
      if (!parsed) continue;
      if (parsed.descriptorKind === "local") continue;
      if (parsed.descriptorKind === "parameter" || parsed.descriptorKind === "typeParameter") continue;
      if (!nodeIds.has(occ.symbol)) continue; // external symbols (lib.d.ts, deps)

      const range = toRange(occ.range);
      const from = extentOf(range);

      if (parsed.descriptorKind === "module") {
        // Occurrence of a module symbol = an import/require path literal.
        if (occ.symbol !== fileNodeId) {
          graph.addEdge(from, occ.symbol, "imports", {
            file: d.relativePath,
            range,
            source: "scip",
            detail: "module-specifier",
          });
        }
        continue;
      }

      const isCall = callSites.calleeRanges.has(rangeKey(range));
      graph.addEdge(from, occ.symbol, isCall ? "calls" : "references", {
        file: d.relativePath,
        range,
        source: isCall ? "typescript-ast" : "scip",
        detail: isCall ? "call-site" : "identifier",
      }, "certain");
    }

    // Implements relationships from SymbolInformation.
    for (const def of d.defs) {
      if (!nodeIds.has(def.symbol)) continue;
      const info = d.symbolInfo.get(def.symbol);
      for (const rel of info?.relationships ?? []) {
        if (!rel.is_implementation || !nodeIds.has(rel.symbol)) continue;
        graph.addEdge(def.symbol, rel.symbol, "implements", {
          file: d.relativePath,
          range: def.range,
          source: "scip",
          detail: "implements-relationship",
        });
      }
    }
  }
  void classifiedFiles;
  return graph;
}

function toRange(r: number[]): SourceRange {
  if (r.length === 3) {
    return { startLine: r[0], startChar: r[1], endLine: r[0], endChar: r[2] };
  }
  return { startLine: r[0], startChar: r[1], endLine: r[2], endChar: r[3] };
}

function contains(outer: SourceRange, inner: SourceRange): boolean {
  const starts = outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startChar <= inner.startChar);
  const ends = outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endChar >= inner.endChar);
  return starts && ends;
}

function extentSize(r: SourceRange): number {
  return (r.endLine - r.startLine) * 1_000_000 + (r.endChar - r.startChar);
}

function hoverText(info: any): string | undefined {
  const doc = info?.documentation?.[0] as string | undefined;
  if (!doc) return undefined;
  // Strip the ```ts fence scip-typescript wraps hover text in.
  return doc.replace(/^```ts\n?/, "").replace(/\n?```$/, "");
}

export class ScipIndexer implements Indexer {
  async index(options: IndexOptions): Promise<RippleGraph> {
    const root = resolve(options.root);
    let indexPath = options.indexPath;
    if (!indexPath) {
      indexPath = options.outputPath ?? join(root, "index.scip");
      const bin = resolve(
        "node_modules/@sourcegraph/scip-typescript/dist/src/main.js",
      );
      execFileSync(
        process.execPath,
        [bin, "index", "--cwd", root, "--output", indexPath, "--no-progress-bar"],
        { stdio: "pipe" },
      );
    }
    if (!existsSync(indexPath)) {
      throw new Error(`SCIP index not found: ${indexPath}`);
    }
    return buildGraphFromScipIndex(readFileSync(indexPath), root);
  }
}
