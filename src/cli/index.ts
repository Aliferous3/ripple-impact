/**
 * Ripple spike CLI.
 *
 *   npm run ripple -- index <dir>                  (re)build index.scip + graph stats
 *   npm run ripple -- impact <name> [--root dir]   reverse impact for a symbol
 *   npm run ripple -- impact [--root dir] [--base ref] [--base-graph]
 *                                                 diff-driven impact analysis
 *   npm run ripple -- changed [--root dir] [--base ref]
 *                                                 list changed symbols + evidence
 *   npm run ripple -- inspect <name> [--root dir]  node, edges and evidence
 *   npm run ripple -- dump [--root dir]            graph statistics
 */
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { ScipIndexer } from "../indexers/scip/scip-indexer.js";
import { impact } from "../impact/traverse.js";
import { formatEvidence, formatImpact, formatRange } from "../impact/explain.js";
import { diffImpact } from "../changes/pipeline.js";
import type { RippleGraph } from "../graph/graph.js";
import type { ChangedSymbol } from "../changes/types.js";
import type { LineRange } from "../git/types.js";

const args = process.argv.slice(2);
const command = args[0];

const VALUE_FLAGS = new Set(["--root", "-r", "--base", "--in"]);

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function positional(): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i++; // skip the flag's value
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

const root = resolve(flag("--root") ?? flag("-r") ?? "fixtures/basic");

async function graphFor(dir: string): Promise<RippleGraph> {
  const indexer = new ScipIndexer();
  const indexPath = join(dir, "index.scip");
  const graph = existsSync(indexPath)
    ? await indexer.index({ root: dir, indexPath })
    : await indexer.index({ root: dir });
  return graph;
}

function fmtLineRange(r?: LineRange): string {
  if (!r) return "-";
  const end = r.end - 1;
  return r.start === end || r.end <= r.start ? `L${r.start}` : `L${r.start}-${end}`;
}

function formatChangedSymbol(c: ChangedSymbol): string {
  const kind =
    c.changeKind === "renamed" && c.renamedFrom && c.renamedFrom.file !== c.file
      ? `moved from ${c.renamedFrom.file}:${c.renamedFrom.name}`
      : c.changeKind === "renamed" && c.renamedFrom
        ? `renamed from ${c.renamedFrom.name}`
        : c.changeKind;
  return `  ${c.name}  (${kind}, ${c.file})`;
}

async function main(): Promise<void> {
  switch (command) {
    case "index": {
      const dir = resolve(args[1] ?? ".");
      const graph = await new ScipIndexer().index({ root: dir });
      const s = graph.stats();
      console.log(`Indexed ${dir}`);
      console.log(`nodes=${s.nodes} edges=${s.edges}`);
      for (const [k, n] of Object.entries(s.byKind)) console.log(`  ${k}: ${n}`);
      return;
    }
    case "impact": {
      const name = positional();
      if (name) {
        const graph = await graphFor(root);
        const result = impact(graph, [name], flag("--in"));
        console.log(formatImpact(result, graph));
        return;
      }
      // Diff mode: working tree (or --base) → changed symbols → impact.
      const base = flag("--base");
      const result = await diffImpact({
        repo: root,
        base,
        baseGraph: hasFlag("--base-graph"),
      });
      console.log(`Comparing ${result.diff.oldRev} → ${result.diff.newRev}\n`);

      const cs = result.changeSet;
      console.log("Changed symbols:");
      for (const c of cs.changed) console.log(formatChangedSymbol(c));
      if (cs.changed.length === 0) console.log("  (none)");

      if (cs.nonSemantic.length > 0) {
        console.log("\nNon-semantic changes (not attributed to symbols):");
        for (const n of cs.nonSemantic) {
          console.log(`  ${n.file}:${fmtLineRange(n.newRange ?? n.oldRange)}  (${n.kind})`);
        }
      }
      if (cs.unmappedFiles.length > 0) {
        console.log("\nChanged files outside the indexed graph:");
        for (const u of cs.unmappedFiles) {
          console.log(`  ${u.file}  (${u.status}, ${u.reason})`);
        }
      }
      if (cs.renamedFiles.length > 0) {
        console.log("\nRenamed files (contents unchanged → symbols unchanged):");
        for (const r of cs.renamedFiles) console.log(`  ${r.from} -> ${r.to}`);
      }

      const deleted = cs.changed.filter((c) => c.changeKind === "deleted");
      if (deleted.length > 0) {
        console.log("\nDeleted symbols:");
        for (const d of deleted) {
          const info = result.deletedImpact.find((x) => x.name === d.name && x.file === d.file);
          const callers = info?.callers ?? [];
          const suffix = callers.length
            ? `  former callers (base graph): ${callers.map((c) => c.name).join(", ")}`
            : "  former callers: unknown without --base-graph";
          console.log(`  ${d.name}  (${d.file})${suffix}`);
        }
      }

      console.log("\n" + formatImpact(result.impact, result.graph));

      const t = result.timings;
      console.log(
        `\n[diff ${t.gitDiffMs.toFixed(0)}ms · index ${t.indexMs.toFixed(0)}ms` +
          ` · map ${t.mapMs.toFixed(0)}ms · traverse ${t.traverseMs.toFixed(0)}ms` +
          (t.baseIndexMs ? ` · base-index ${t.baseIndexMs.toFixed(0)}ms` : "") + "]",
      );
      return;
    }
    case "changed": {
      const base = flag("--base");
      const result = await diffImpact({ repo: root, base });
      console.log(`Comparing ${result.diff.oldRev} → ${result.diff.newRev}\n`);
      for (const c of result.changeSet.changed) {
        console.log(formatChangedSymbol(c));
        console.log("  why:");
        for (const e of c.evidence) {
          const parts: string[] = [];
          if (e.oldRange) parts.push(`old ${fmtLineRange(e.oldRange)}`);
          if (e.newRange) parts.push(`new ${fmtLineRange(e.newRange)}`);
          console.log(`    ${e.file}: ${parts.join(" → ") || "whole-file change"}`);
        }
        if (c.node?.extent) {
          console.log(`    symbol extent: ${formatRange(c.node.extent)}`);
        }
      }
      if (result.changeSet.nonSemantic.length > 0) {
        console.log("\nNon-semantic changes (filtered out):");
        for (const n of result.changeSet.nonSemantic) {
          console.log(`  ${n.file}:${fmtLineRange(n.newRange ?? n.oldRange)}  (${n.kind})`);
        }
      }
      return;
    }
    case "inspect": {
      const name = positional();
      if (!name) throw new Error("usage: inspect <symbol> [--root <dir>]");
      const graph = await graphFor(root);
      const matches = graph.findByName(name);
      if (matches.length === 0) {
        console.log(`No symbol found matching "${name}"`);
        return;
      }
      for (const node of matches) {
        console.log(`NODE\n  ${node.name}\n  kind=${node.kind} file=${node.file}` +
          (node.range ? ` range=${formatRange(node.range)}` : "") +
          (node.extent ? ` extent=${formatRange(node.extent)}` : "") +
          `\n  id=${node.id}`);
        for (const edge of graph.outEdges(node.id)) {
          const target = graph.node(edge.to);
          console.log(
            `\nEDGE\n  ${node.name} --${edge.kind.toUpperCase()}--> ${target?.name ?? edge.to}` +
              `\n  confidence=${edge.confidence}` +
              `\nEVIDENCE\n  ${formatEvidence(edge)}`,
          );
        }
        for (const edge of graph.inEdges(node.id)) {
          const source = graph.node(edge.from);
          console.log(
            `\nEDGE\n  ${source?.name ?? edge.from} --${edge.kind.toUpperCase()}--> ${node.name}` +
              `\n  confidence=${edge.confidence}` +
              `\nEVIDENCE\n  ${formatEvidence(edge)}`,
          );
        }
      }
      return;
    }
    case "dump": {
      const graph = await graphFor(root);
      const s = graph.stats();
      console.log(`root=${graph.root}`);
      console.log(`nodes=${s.nodes} edges=${s.edges}`);
      for (const [k, n] of Object.entries(s.byKind)) console.log(`  ${k}: ${n}`);
      return;
    }
    default:
      console.log(
        "usage: ripple <index|impact|changed|inspect|dump> [args]\n" +
          "  index <dir>                  index a project\n" +
          "  impact <symbol> [--root d]   reverse impact for a symbol\n" +
          "  impact [--root d] [--base r] [--base-graph]\n" +
          "                               diff-driven impact analysis\n" +
          "  changed [--root d] [--base r]  changed symbols + evidence\n" +
          "  inspect <symbol> [--root d]  show node, edges, evidence\n" +
          "  dump [--root d]              graph stats",
      );
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
