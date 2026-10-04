/**
 * Ripple CLI — Tranche 1 surface.
 *
 *   npm run ripple -- analyze [--root dir]             build/reuse the cached graph; report cache status
 *   npm run ripple -- impact [--root dir] [--base ref] [--json]
 *                                                    diff-driven impact (working tree or vs base)
 *   npm run ripple -- impact <symbol> [--root dir] [--in file] [--json]
 *                                                    reverse impact for one symbol
 *   npm run ripple -- changed [--root dir] [--base ref] [--json]
 *                                                    changed symbols + evidence
 *   npm run ripple -- inspect <symbol> [--root dir]    node, edges and evidence
 *   npm run ripple -- cache status [--root dir]        cache state + fingerprint validity
 *   npm run ripple -- cache clear  [--root dir]        delete Ripple-owned cache state only
 *   npm run ripple -- dump [--root dir]                graph statistics
 */
import { resolve } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { impactNodes } from "../impact/traverse.js";
import { formatEvidence, formatImpact, formatRange } from "../impact/explain.js";
import { diffImpact } from "../changes/pipeline.js";
import { analyzeRepository, analyzeSymbol } from "../api/analyze.js";
import { getGraphForRepo } from "../cache/graph.js";
import { GRAPH_SCHEMA_VERSION } from "../graph/serialize.js";
import { repoFingerprint } from "../cache/fingerprint.js";
import { RippleCache } from "../cache/store.js";
import type { AnalysisWarning, CacheReport } from "../changes/pipeline.js";
import type { ChangedSymbol } from "../changes/types.js";
import type { LineRange } from "../git/types.js";

const args = process.argv.slice(2);
const command = args[0];

const VALUE_FLAGS = new Set(["--root", "-r", "--base", "--in"]);

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function positional(): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

const root = resolve(flag("--root") ?? flag("-r") ?? ".");
const json = args.includes("--json");

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

function printWarnings(warnings: AnalysisWarning[]): void {
  if (warnings.length === 0) return;
  console.log("\nWarnings:");
  for (const w of warnings) {
    const loc = w.file ? `  [${w.file}]` : "";
    console.log(`  ${w.code}${loc} — ${w.message}`);
  }
}

function printCacheStatus(c: CacheReport): void {
  console.log("\nAnalysis cache:");
  console.log(`  SCIP index      ${c.index.toUpperCase()}`);
  console.log(`  Ripple graph    ${c.graph.toUpperCase()}`);
  console.log(`  Base graph      ${c.baseGraph.replace(/-/g, " ").toUpperCase()}`);
  console.log(`  AST enrichment  ${c.enrichedFiles} file(s) processed`);
  if (c.missReason) console.log(`  Miss reason     ${c.missReason}`);
}

function gitignoreHint(rootDir: string): void {
  const gi = resolve(rootDir, ".gitignore");
  const rippleDir = resolve(rootDir, ".ripple");
  if (!existsSync(rippleDir)) return;
  const contents = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!/^\.ripple\/?$/m.test(contents)) {
    console.log("\nnote: .ripple/ is not gitignored — consider adding `.ripple/` to .gitignore");
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "analyze": {
      const load = await getGraphForRepo(root);
      const s = load.graph.stats();
      console.log(`Analyzed ${root}`);
      console.log(`nodes=${s.nodes} edges=${s.edges}`);
      for (const [k, n] of Object.entries(s.byKind)) console.log(`  ${k}: ${n}`);
      printCacheStatus({
        index: load.status,
        graph: load.status,
        baseGraph: "not-required",
        enrichedFiles: load.enrichedFiles,
        missReason: load.reason,
      });
      gitignoreHint(root);
      return;
    }

    case "impact": {
      const name = positional();
      if (name) {
        const inFile = flag("--in");
        const selector = inFile && !name.includes("::") ? `${inFile}::${name}` : name;
        const res = await analyzeSymbol({ repo: root, symbol: selector });
        if (!res.ok) {
          if (res.candidates.length > 0) {
            console.log(`${res.error} — disambiguate with a file-qualified selector:`);
            res.candidates.forEach((c, i) => console.log(`  ${i + 1}. ${c.selector}`));
            process.exitCode = 2;
            return;
          }
          console.log(res.error);
          process.exitCode = 1;
          return;
        }
        if (json) {
          console.log(JSON.stringify(res.result, null, 2));
          return;
        }
        const graph = (await getGraphForRepo(root)).graph;
        const n = res.result.changed[0];
        const impactRes = impactNodes(graph, n?.id ? [graph.node(n.id)!] : []);
        console.log(formatImpact(impactRes, graph));
        return;
      }
      // Diff mode: working tree (or --base) → changed symbols → impact.
      const base = flag("--base");
      if (json) {
        const result = await analyzeRepository({ repo: root, base });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const result = await diffImpact({ repo: root, base });
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
            : info?.resolved
              ? "  former callers: none in base graph"
              : "  former callers: unknown (base analysis unavailable)";
          console.log(`  ${d.name}  (${d.file})${suffix}`);
        }
      }

      console.log("\n" + formatImpact(result.impact, result.graph));
      printWarnings(result.warnings);
      printCacheStatus(result.cache);
      gitignoreHint(root);

      const t = result.timings;
      console.log(
        `\n[diff ${t.gitDiffMs.toFixed(0)}ms · index ${t.indexMs.toFixed(0)}ms` +
          ` · map ${t.mapMs.toFixed(0)}ms · traverse ${t.traverseMs.toFixed(0)}ms` +
          (t.fingerprintMs ? ` · fingerprint ${t.fingerprintMs.toFixed(0)}ms` : "") +
          (t.baseIndexMs ? ` · base-index ${t.baseIndexMs.toFixed(0)}ms` : "") + "]",
      );
      return;
    }

    case "changed": {
      const base = flag("--base");
      if (json) {
        const result = await analyzeRepository({ repo: root, base });
        console.log(JSON.stringify({ schemaVersion: result.schemaVersion, comparison: result.comparison, changed: result.changed, nonSemantic: result.nonSemantic, unmappedFiles: result.unmappedFiles, renamedFiles: result.renamedFiles, warnings: result.warnings, cache: result.cache }, null, 2));
        return;
      }
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
      printWarnings(result.warnings);
      printCacheStatus(result.cache);
      return;
    }

    case "inspect": {
      const name = positional();
      if (!name) throw new Error("usage: inspect <symbol> [--root <dir>]");
      const { graph } = await getGraphForRepo(root);
      let file: string | undefined;
      let sym = name;
      if (name.includes("::")) [file, sym] = name.split("::");
      let matches = graph.findByName(sym);
      if (file) matches = matches.filter((m) => m.file === file);
      if (matches.length === 0) {
        console.log(`No symbol found matching "${name}"`);
        return;
      }
      for (const node of matches) {
        console.log(`NODE\n  ${node.name}\n  kind=${node.kind} file=${node.file}` +
          (node.range ? ` range=${formatRange(node.range)}` : "") +
          (node.extent ? ` extent=${formatRange(node.extent)}` : "") +
          `\n  selector=${node.file}::${node.name}` +
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

    case "cache": {
      const sub = args[1];
      if (sub === "status") {
        const fp = repoFingerprint(root);
        const cache = new RippleCache(root);
        console.log(`Repository fingerprint: ${fp.key.slice(0, 16)}…`);
        console.log(`  files hashed: ${fp.fileCount}`);
        console.log(`  scip-typescript: ${fp.detail.scipTypescript}  graph schema: ${fp.detail.schemaVersion} (current ${GRAPH_SCHEMA_VERSION})`);
        const entries = cache.list();
        if (entries.length === 0) {
          console.log("  cache: empty");
        }
        for (const m of entries) {
          const probe = cache.load({ ...fp, key: m.fingerprint });
          console.log(
            `  entry ${m.fingerprint.slice(0, 16)}…  ` +
              `${m.revision ?? "worktree"}  ${m.createdAt}  ` +
              `${probe.status === "hit" ? "VALID" : `INVALID (${probe.reason})`}  ` +
              `${m.fingerprint === fp.key ? "← matches current tree" : "stale"}`,
          );
        }
        return;
      }
      if (sub === "clear") {
        const n = new RippleCache(root).clear();
        const dir = resolve(root, ".ripple");
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        console.log(`Cleared ${n} cache entr${n === 1 ? "y" : "ies"} under ${dir}`);
        return;
      }
      console.log("usage: ripple cache <status|clear> [--root <dir>]");
      return;
    }

    case "dump": {
      const { graph } = await getGraphForRepo(root);
      const s = graph.stats();
      console.log(`root=${graph.root}`);
      console.log(`nodes=${s.nodes} edges=${s.edges}`);
      for (const [k, n] of Object.entries(s.byKind)) console.log(`  ${k}: ${n}`);
      return;
    }

    // Back-compat alias.
    case "index": {
      const dir = resolve(positional() ?? args[1] ?? ".");
      const load = await getGraphForRepo(dir);
      const s = load.graph.stats();
      console.log(`Indexed ${dir} (${load.status})`);
      console.log(`nodes=${s.nodes} edges=${s.edges}`);
      return;
    }

    default:
      console.log(
        "usage: ripple <analyze|impact|changed|inspect|cache|dump> [args]\n" +
          "  analyze [--root d]             build/reuse cached graph\n" +
          "  impact [--root d] [--base r] [--json]\n" +
          "                                 diff-driven impact analysis\n" +
          "  impact <symbol> [--root d] [--in f] [--json]\n" +
          "                                 reverse impact for a symbol\n" +
          "  changed [--root d] [--base r] [--json]\n" +
          "                                 changed symbols + evidence\n" +
          "  inspect <symbol|file::symbol> [--root d]\n" +
          "                                 node, edges, evidence\n" +
          "  cache status|clear [--root d]  cache state / clear\n" +
          "  dump [--root d]                graph stats",
      );
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
