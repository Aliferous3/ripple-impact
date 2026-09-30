/**
 * Ripple Tranche-0 spike CLI.
 *
 *   npm run ripple -- index <dir>                  (re)build index.scip + graph stats
 *   npm run ripple -- impact <name> [--root dir]   reverse impact for a symbol
 *   npm run ripple -- inspect <name> [--root dir]  node, edges and evidence
 *   npm run ripple -- dump [--root dir]            graph statistics
 */
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { ScipIndexer } from "../indexers/scip/scip-indexer.js";
import { impact } from "../impact/traverse.js";
import { formatEvidence, formatImpact, formatRange } from "../impact/explain.js";
import type { RippleGraph } from "../graph/graph.js";

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
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
      const name = args[1];
      if (!name) throw new Error("usage: impact <symbol> [--root <dir>]");
      const graph = await graphFor(root);
      const result = impact(graph, [name], flag("--in"));
      console.log(formatImpact(result, graph));
      return;
    }
    case "inspect": {
      const name = args[1];
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
        "usage: ripple <index|impact|inspect|dump> [args]\n" +
          "  index <dir>                  index a project\n" +
          "  impact <symbol> [--root d]   reverse impact analysis\n" +
          "  inspect <symbol> [--root d]  show node, edges, evidence\n" +
          "  dump [--root d]              graph stats",
      );
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
