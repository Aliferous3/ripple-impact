import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { RippleGraph } from "../../graph/graph.js";
import type { SourceRange } from "../../graph/types.js";
import { contains, extentSize, toRange } from "../scip/ranges.js";
import { rangeKey } from "../enrich/call-classifier.js";
import {
  moduleTail,
  parsePythonSymbol,
  pyDisplayName,
  pyNodeKind,
} from "./symbol.js";
import { enrichPythonFiles } from "./enrich.js";
import type { PythonEnv } from "./interpreter.js";

const require = createRequire(import.meta.url);
// Same vendored protobuf bindings scip-typescript ships — the SCIP format
// is language-generic; scip-python emits the identical Index message.
const { scip } = require("@sourcegraph/scip-typescript/dist/src/scip.js");

const DEFINITION = 1; // scip.SymbolRole.Definition

interface DefSite {
  symbol: string;
  range: SourceRange;
  /** Full declaration extent — SCIP `enclosing_range`. */
  extent: SourceRange;
}

export interface PythonGraphOptions {
  python: PythonEnv;
  enrichCacheDir?: string;
  statsOut?: { enrichedFiles?: number };
  /** Conventional test-file rule from the adapter's ProjectFileRules. */
  isTestFile: (relPath: string) => boolean;
}

/**
 * Converts a scip-python index into a RippleGraph.
 *
 * What scip-python provides:
 *   - definition occurrences (+ enclosing_range = full declaration extent)
 *   - references resolved to canonical, alias-dealiased symbols
 *   - module symbols (`.../__init__:`) — canonical for absolute imports,
 *     tail-only (e.g. "models/__init__:") for relative imports
 *   - SymbolInformation.relationships with is_implementation (class bases)
 *   - external symbols kept OUT of documents (stdlib/site-packages are
 *     never repository nodes)
 *
 * What it does NOT provide — added by deterministic Python AST
 * classification (python/enrich.py), never name-matching:
 *   - call-position vs plain reference  → "calls"
 *   - annotation/base-class positions   → "type_depends"
 *   - decorator heads stay "references" (conservative contract)
 */
export function buildPythonGraphFromScipIndex(
  indexBytes: Uint8Array,
  root: string,
  opts: PythonGraphOptions,
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
  for (const doc of index.documents) {
    const relativePath = (doc.relative_path as string).replace(/\\/g, "/");
    const symbolInfo = new Map<string, any>();
    for (const sym of doc.symbols) symbolInfo.set(sym.symbol, sym);
    const defs: DefSite[] = [];
    let moduleSymbol: string | undefined;
    for (const occ of doc.occurrences) {
      if ((occ.symbol_roles & DEFINITION) === 0) continue;
      const parsed = parsePythonSymbol(occ.symbol);
      if (!parsed) continue;
      const range = toRange(occ.range);
      const extent = occ.enclosing_range.length ? toRange(occ.enclosing_range) : range;
      if (parsed.kind === "module") {
        moduleSymbol = occ.symbol;
      } else {
        defs.push({ symbol: occ.symbol, range, extent });
      }
    }
    docs.push({ relativePath, moduleSymbol, defs, occurrences: doc.occurrences, symbolInfo });
  }

  const nodeIds = new Set<string>();
  const moduleTailIndex = new Map<string, string[]>(); // tail → canonical ids
  for (const d of docs) {
    if (d.moduleSymbol) {
      const parsed = parsePythonSymbol(d.moduleSymbol);
      const isTest = opts.isTestFile(d.relativePath);
      graph.addNode({
        id: d.moduleSymbol,
        kind: isTest ? "test" : "file",
        name: d.relativePath.split("/").pop() ?? d.relativePath,
        file: d.relativePath,
      });
      nodeIds.add(d.moduleSymbol);
      const tail = parsed ? moduleTail(parsed) : undefined;
      if (tail) {
        const arr = moduleTailIndex.get(tail) ?? [];
        arr.push(d.moduleSymbol);
        moduleTailIndex.set(tail, arr);
      }
    }
    for (const def of d.defs) {
      const parsed = parsePythonSymbol(def.symbol);
      if (!parsed) continue;
      let kind = pyNodeKind(parsed);
      if (!kind) continue; // parameters, type params, locals
      if (opts.isTestFile(d.relativePath) && kind === "function") kind = "test";
      graph.addNode({
        id: def.symbol,
        kind,
        name: pyDisplayName(parsed),
        file: d.relativePath,
        range: def.range,
        extent: def.extent,
      });
      nodeIds.add(def.symbol);
    }
  }

  // Resolve a module-reference occurrence to a canonical module node.
  // Absolute imports already carry the canonical id; relative imports
  // arrive unqualified ("models/__init__:") — match by unique tail only.
  const resolveModule = (raw: string): string | undefined => {
    if (nodeIds.has(raw)) return raw;
    const parsed = parsePythonSymbol(raw);
    const tail = parsed ? moduleTail(parsed) : undefined;
    if (!tail) return undefined;
    const exact = moduleTailIndex.get(tail);
    if (exact && exact.length === 1) return exact[0];
    const suffix: string[] = [];
    for (const [t, ids] of moduleTailIndex) {
      if (t.endsWith(`/${tail}`)) suffix.push(...ids);
    }
    return suffix.length === 1 ? suffix[0] : undefined;
  };

  // Batch enrichment: one interpreter invocation for the whole index.
  let enriched: Map<string, { callRanges: Set<string>; typeRanges: Map<string, string> }>;
  let enrichedFiles = 0;
  try {
    const files = docs
      .map((d) => {
        try {
          return { relPath: d.relativePath, text: readFileSync(join(root, d.relativePath), "utf8") };
        } catch {
          return undefined;
        }
      })
      .filter((f): f is { relPath: string; text: string } => f !== undefined);
    enriched = enrichPythonFiles(opts.python, opts.enrichCacheDir, files);
    enrichedFiles = enriched.size;
  } catch {
    enriched = new Map();
  }
  if (opts.statsOut) opts.statsOut.enrichedFiles = enrichedFiles;

  for (const d of docs) {
    if (!d.moduleSymbol) continue;
    const fileNodeId = d.moduleSymbol;

    // contains: smallest enclosing definition extent, else the file node.
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

    const e = enriched.get(d.relativePath);
    const callRanges = e?.callRanges ?? new Set<string>();
    const typeRanges = e?.typeRanges ?? new Map<string, string>();

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
      const parsed = parsePythonSymbol(occ.symbol);
      if (!parsed) continue;
      if (
        parsed.kind === "local" ||
        parsed.kind === "parameter" ||
        parsed.kind === "typeParameter"
      ) {
        continue;
      }
      const range = toRange(occ.range);
      const from = extentOf(range);

      if (parsed.kind === "module") {
        const to = resolveModule(occ.symbol);
        if (to && to !== fileNodeId) {
          graph.addEdge(from, to, "imports", {
            file: d.relativePath,
            range,
            source: "scip",
            detail: "module-specifier",
          });
        }
        continue;
      }

      if (!nodeIds.has(occ.symbol)) continue; // stdlib/site-packages/external

      if (from === occ.symbol) continue; // self-reference
      const key = rangeKey(range);
      const typeDetail = typeRanges.get(key);
      if (typeDetail !== undefined) {
        graph.addEdge(from, occ.symbol, "type_depends", {
          file: d.relativePath,
          range,
          source: "python-ast",
          detail: typeDetail,
        }, "certain");
        continue;
      }
      const isCall = callRanges.has(key);
      graph.addEdge(from, occ.symbol, isCall ? "calls" : "references", {
        file: d.relativePath,
        range,
        source: isCall ? "python-ast" : "scip",
        detail: isCall ? "call-site" : "identifier",
      }, "certain");
    }

    // Proven relationships (class bases → implements), same normalization
    // as the TypeScript converter.
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
  return graph;
}
