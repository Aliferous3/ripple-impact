#!/usr/bin/env node
/**
 * Ripple CLI — deterministic change-impact analysis.
 *
 * Exit codes: 0 success · 1 operational failure · 2 invalid usage.
 * Result data goes to stdout; progress/status goes to stderr so
 * `--json` output is always machine-clean.
 */
import { resolve } from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { impactNodes } from "../impact/traverse.js";
import { formatEvidence, formatImpact, formatRange } from "../impact/explain.js";
import { diffImpact } from "../changes/pipeline.js";
import { analyzeRepository, analyzeSymbol, type AnalysisResult } from "../api/analyze.js";
import { getGraphForRepo, type PhaseFn } from "../cache/graph.js";
import { GRAPH_SCHEMA_VERSION } from "../graph/serialize.js";
import { repoFingerprint } from "../cache/fingerprint.js";
import { RippleCache } from "../cache/store.js";
import { preflight } from "./preflight.js";
import { createDemoRepo } from "./demo.js";
import { error, kv, phase, setQuiet, status } from "./ui.js";
import type { AnalysisWarning, CacheReport } from "../changes/pipeline.js";
import type { ChangedSymbol } from "../changes/types.js";
import type { LineRange } from "../git/types.js";

const args = process.argv.slice(2);
const command = args[0];

const VALUE_FLAGS = new Set(["--root", "-r", "--base", "--in", "--port"]);
const KNOWN_FLAGS = new Set([
  ...VALUE_FLAGS,
  "--json",
  "--verbose",
  "--quiet",
  "--no-watch",
  "--no-open",
  "--help",
  "-h",
  "--version",
  "-V",
]);

function hasFlag(name: string): boolean {
  return args.includes(name);
}

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
const json = hasFlag("--json");
const verbose = hasFlag("--verbose");

const VERSION = (() => {
  try {
    return (
      JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
      ) as { version?: string }
    ).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Live phase → progress line on stderr. */
function makeOnPhase(): PhaseFn {
  let current: ((extra?: string) => void) | undefined;
  const labels: Record<string, string> = {
    fingerprint: "Scanning repository",
    index: "Indexing TypeScript",
    diff: "Reading git diff",
    map: "Mapping changes to symbols",
    traverse: "Computing impact",
    "base-graph": "Indexing base revision",
  };
  return (name, done) => {
    if (!done) {
      // fingerprint is sub-second on every repo — don't spam it
      if (name !== "fingerprint") current = phase(labels[name] ?? name);
      return;
    }
    const cold =
      name === "index" && !done.cached
        ? "— first run indexes every source file; the cache makes repeat runs faster"
        : "";
    current?.(done.cached ? "(cached)" : cold);
    current = undefined;
  };
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
    status("\nnote: Ripple's cache directory is not gitignored. Add this to .gitignore:\n\n  .ripple/\n");
  }
}

function failPreflight(root: string, needsGit: boolean): void {
  const { errors, warnings } = preflight(root, needsGit);
  for (const w of warnings) status(`note: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) error(e);
    process.exit(1);
  }
}

const HELP: Record<string, string> = {
  analyze: `ripple analyze [--root <dir>] [--json]

Build (or reuse) the cached dependency graph for a repository and report
cache status. Works on any directory containing TypeScript/JavaScript
sources — no git required.`,
  impact: `ripple impact [--root <dir>] [--base <ref>] [--json]
ripple impact <symbol> [--root <dir>] [--in <file>] [--json]

Diff-driven impact analysis. Without --base, compares HEAD against the
working tree. With a symbol, answers "what breaks if this changes?".

Options:
  --base <ref>     compare a revision/merge-base against the working tree
  --in <file>      disambiguate a symbol name by file
  --json           machine-readable AnalysisResult on stdout
  --verbose        include cache status and per-phase timings
  --quiet          suppress progress output`,
  changed: `ripple changed [--root <dir>] [--base <ref>] [--json]

List the symbols a diff changed, with per-hunk evidence (WHY CHANGED).`,
  inspect: `ripple inspect <symbol|file::symbol> [--root <dir>]

Show a graph node: kind, file, range, and every edge with its evidence.`,
  explore: `ripple explore [--root <dir>] [--base <ref>] [--port <n>] [--no-open] [--no-watch] [<symbol>]

Local visual impact explorer. Serves a prebuilt bundle on 127.0.0.1 and
streams live re-analysis over SSE while you edit. Ctrl+C stops cleanly.

Options:
  --base <ref>     compare a revision/merge-base against the working tree
  --port <n>       fixed port (default: OS-assigned)
  --no-open        don't launch a browser
  --no-watch       disable live re-analysis`,
  cache: `ripple cache status [--root <dir>]   cache entries + validity
ripple cache clear  [--root <dir>]   delete Ripple-owned cache only`,
  dump: `ripple dump [--root <dir>]

Print graph statistics (node/edge counts by kind).`,
  demo: `ripple demo

Materializes a small scratch repository (with git history and a
ready-made change) under your temp directory, then prints the commands
to try. Safe: never touches your real repositories.`,
};

function printGlobalHelp(): void {
  console.log(`ripple — see what your code change touches before you ship it

usage: ripple <command> [options]

Commands:
  impact       what a diff (or one symbol) affects — runtime, type, tests
  explore      local visual impact explorer with live re-analysis
  changed      which symbols the diff changed, with evidence
  analyze      build/reuse the cached dependency graph
  inspect      a node's edges and evidence
  cache        cache status / clear
  dump         graph statistics
  demo         create a scratch repo to try Ripple on

Options:
  --root <dir>   repository to analyze (default: current directory)
  --json         machine-readable output on stdout
  --verbose      extra detail: cache status, per-phase timings
  --quiet        suppress progress output
  --version      print version
  --help         this help, or: ripple <command> --help

Local-first: analysis never leaves your machine; the explorer binds to
127.0.0.1 only.`);
}

async function main(): Promise<void> {
  if (hasFlag("--version") || hasFlag("-V") || command === "--version") {
    console.log(VERSION);
    return;
  }
  if (command === undefined || hasFlag("--help") || hasFlag("-h") || command === "help") {
    const topic = command === "help" ? args[1] : command;
    if (topic && HELP[topic]) console.log(HELP[topic]);
    else if (topic && topic !== "help" && !(topic.startsWith("-"))) {
      error(`unknown command "${topic}"`);
      printGlobalHelp();
      process.exit(2);
    } else printGlobalHelp();
    return;
  }

  const unknown = args.slice(1).filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    error(`unknown option${unknown.length > 1 ? "s" : ""}: ${unknown.join(" ")}`);
    process.exit(2);
  }

  setQuiet(hasFlag("--quiet") || json);
  const onPhase = makeOnPhase();

  switch (command) {
    case "analyze": {
      failPreflight(root, false);
      const load = await getGraphForRepo(root, onPhase);
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
        const res = await analyzeSymbol({ repo: root, symbol: selector, onPhase });
        if (!res.ok) {
          if (res.candidates.length > 0) {
            console.log(`${res.error} — disambiguate with a file-qualified selector:`);
            res.candidates.forEach((c, i) => console.log(`  ${i + 1}. ${c.selector}`));
            process.exitCode = 2;
            return;
          }
          error(res.error);
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
      failPreflight(root, true);
      const base = flag("--base");
      if (json) {
        const result = await analyzeRepository({ repo: root, base, onPhase });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const detail = await diffImpact({ repo: root, base, onPhase });
      const typeCount =
        detail.impact.typeDirect.length + detail.impact.typeTransitive.length;
      console.log(`\n  Comparing ${detail.diff.oldRev.slice(0, 12)} → ${detail.diff.newRev}\n`);
      kv("Changed", detail.changeSet.changed.length);
      kv("Runtime affected", detail.impact.direct.length + detail.impact.transitive.length);
      kv("Type affected", typeCount);
      kv("Relevant tests", detail.impact.relevantTests.length);
      kv("Warnings", detail.warnings.length);
      const cs = detail.changeSet;
      if (cs.changed.length > 0) {
        console.log("\nChanged symbols:");
        for (const c of cs.changed) console.log(formatChangedSymbol(c));
      }

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
          const info = detail.deletedImpact.find((x) => x.name === d.name && x.file === d.file);
          const callers = info?.callers ?? [];
          const suffix = callers.length
            ? `  former callers (base graph): ${callers.map((c) => c.name).join(", ")}`
            : info?.resolved
              ? "  former callers: none in base graph"
              : "  former callers: unknown (base analysis unavailable)";
          console.log(`  ${d.name}  (${d.file})${suffix}`);
        }
      }

      console.log("\n" + formatImpact(detail.impact, detail.graph));
      printWarnings(detail.warnings);
      if (verbose) {
        printCacheStatus(detail.cache);
        const t = detail.timings;
        status(
          `\n[diff ${t.gitDiffMs.toFixed(0)}ms · index ${t.indexMs.toFixed(0)}ms` +
            ` · map ${t.mapMs.toFixed(0)}ms · traverse ${t.traverseMs.toFixed(0)}ms` +
            (t.fingerprintMs ? ` · fingerprint ${t.fingerprintMs.toFixed(0)}ms` : "") +
            (t.baseIndexMs ? ` · base-index ${t.baseIndexMs.toFixed(0)}ms` : "") + "]",
        );
      }
      gitignoreHint(root);
      return;
    }

    case "changed": {
      failPreflight(root, true);
      const base = flag("--base");
      if (json) {
        const result = await analyzeRepository({ repo: root, base, onPhase });
        console.log(JSON.stringify({ schemaVersion: result.schemaVersion, comparison: result.comparison, changed: result.changed, nonSemantic: result.nonSemantic, unmappedFiles: result.unmappedFiles, renamedFiles: result.renamedFiles, warnings: result.warnings, cache: result.cache }, null, 2));
        return;
      }
      const result = await diffImpact({ repo: root, base, onPhase });
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
      if (verbose) printCacheStatus(result.cache);
      return;
    }

    case "inspect": {
      failPreflight(root, false);
      const name = positional();
      if (!name) {
        error("usage: ripple inspect <symbol|file::symbol> [--root <dir>]");
        process.exit(2);
      }
      const { graph } = await getGraphForRepo(root, onPhase);
      let file: string | undefined;
      let sym = name;
      if (name.includes("::")) [file, sym] = name.split("::");
      let matches = graph.findByName(sym);
      if (file) matches = matches.filter((m) => m.file === file);
      if (matches.length === 0) {
        error(`no symbol found matching "${name}"`);
        process.exitCode = 1;
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

    case "explore": {
      failPreflight(root, true);
      const { startExplorer } = await import("../server/explorer.js");
      const portFlag = flag("--port");
      const symbol = positional();
      const running = await startExplorer({
        repo: root,
        base: flag("--base"),
        symbol,
        port: portFlag ? Number(portFlag) : undefined,
        watch: !hasFlag("--no-watch"),
      });
      const analysis = running.analysis;
      const typeCount = analysis.typeImpact.direct.length + analysis.typeImpact.transitive.length;
      console.log(`\nRipple — ${analysis.comparison.oldRev.slice(0, 12)} → ${analysis.comparison.newRev}\n`);
      kv("Changed", analysis.changed.length);
      kv("Runtime affected", analysis.direct.length + analysis.transitive.length);
      kv("Type affected", typeCount);
      kv("Relevant tests", analysis.tests.length);
      kv("Warnings", analysis.warnings.length);
      console.log(`\nOpen: ${running.url}`);
      if (running.live.watching)
        status("Live analysis on — edits re-analyze automatically (--no-watch to disable)");
      if (!hasFlag("--no-open")) {
        try {
          const { spawn } = await import("node:child_process");
          const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
          const openArgs = process.platform === "win32" ? ["/c", "start", "", running.url] : [running.url];
          spawn(cmd, openArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref();
        } catch {
          /* browser launch is best-effort */
        }
      }
      // Ctrl+C / SIGTERM: close watcher + SSE + server before exiting so
      // no local servers or watch handles linger.
      const shutdown = () => void running.close().then(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise(() => {});
      return;
    }

    case "demo": {
      const dir = createDemoRepo();
      console.log(`Created a demo repository at:\n\n  ${dir}\n\nIt has one commit plus two working-tree changes:\n  a runtime body edit in renderUser() and a new field on interface User.\n\nTry:\n\n  ripple impact  --root "${dir}"\n  ripple explore --root "${dir}"\n  ripple impact  --root "${dir}" --json\n`);
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
      error("usage: ripple cache <status|clear> [--root <dir>]");
      process.exit(2);
    }

    case "dump": {
      failPreflight(root, false);
      const { graph } = await getGraphForRepo(root, onPhase);
      const s = graph.stats();
      console.log(`root=${graph.root}`);
      console.log(`nodes=${s.nodes} edges=${s.edges}`);
      for (const [k, n] of Object.entries(s.byKind)) console.log(`  ${k}: ${n}`);
      return;
    }

    // Back-compat alias.
    case "index": {
      failPreflight(root, false);
      const dir = resolve(positional() ?? args[1] ?? ".");
      const load = await getGraphForRepo(dir, onPhase);
      const s = load.graph.stats();
      console.log(`Indexed ${dir} (${load.status})`);
      console.log(`nodes=${s.nodes} edges=${s.edges}`);
      return;
    }

    default:
      error(`unknown command "${command}"`);
      printGlobalHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  error(msg);
  if (verbose && err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
