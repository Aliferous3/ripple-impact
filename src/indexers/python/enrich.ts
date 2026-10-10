import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPH_SCHEMA_VERSION } from "../../graph/serialize.js";
import type { PythonEnv } from "./interpreter.js";

/**
 * Python syntax enrichment — intersects SCIP references with AST-classified
 * positions (call callees, annotation positions, class bases). The heavy
 * lifting is `python/enrich.py` (stdlib ast only); this module batches one
 * interpreter invocation per index run and caches per file, content-
 * addressed, exactly like the TypeScript enrichment cache.
 */

export interface PyEnrichment {
  /** rangeKey() strings of call-callee name ranges. */
  callRanges: Set<string>;
  /** rangeKey → detail ("annotation" | "base-class"). */
  typeRanges: Map<string, string>;
}

interface PyArtifact {
  calls: string[];
  types: [string, string][];
}

interface BatchResult {
  files: Record<string, { calls: number[][]; types: { r: number[]; k: string }[] }>;
  errors: Record<string, string>;
}

const ENRICH_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../python/enrich.py",
);

function rangeKey4(r: number[]): string {
  return `${r[0]}:${r[1]}:${r[2]}:${r[3]}`;
}

function enrichKey(env: PythonEnv, relPath: string, sourceText: string): string {
  return createHash("sha256")
    .update(`enrich-schema:${GRAPH_SCHEMA_VERSION}`)
    .update(`\0python:${env.version}`)
    .update(`\0${relPath}\0`)
    .update(sourceText)
    .digest("hex");
}

function toEnrichment(calls: number[][], types: { r: number[]; k: string }[]): PyEnrichment {
  return {
    callRanges: new Set(calls.map(rangeKey4)),
    typeRanges: new Map(types.map((t) => [rangeKey4(t.r), t.k])),
  };
}

function fromArtifact(a: PyArtifact): PyEnrichment {
  return {
    callRanges: new Set(a.calls),
    typeRanges: new Map(a.types),
  };
}

/**
 * Classify every file in ONE interpreter spawn (one parse pass per file
 * inside the helper). Files with a cache hit skip recomputation.
 * Failures degrade per file to "no enrichment" (all occurrences stay
 * references) — never a fabricated edge.
 */
export function enrichPythonFiles(
  env: PythonEnv,
  cacheDir: string | undefined,
  files: { relPath: string; text: string }[],
): Map<string, PyEnrichment> {
  const out = new Map<string, PyEnrichment>();
  const misses: { relPath: string; text: string; key: string }[] = [];

  for (const f of files) {
    const key = cacheDir ? enrichKey(env, f.relPath, f.text) : "";
    if (cacheDir) {
      try {
        const a = JSON.parse(readFileSync(join(cacheDir, `${key}.json`), "utf8")) as PyArtifact;
        out.set(f.relPath, fromArtifact(a));
        continue;
      } catch {
        /* miss — compute below */
      }
    }
    misses.push({ relPath: f.relPath, text: f.text, key });
  }

  if (misses.length === 0) return out;

  let batch: BatchResult | undefined;
  try {
    const stdout = execFileSync(
      env.exe,
      [...env.args, ENRICH_SCRIPT],
      {
        input: JSON.stringify({ files: misses.map((m) => ({ id: m.relPath, text: m.text })) }),
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        timeout: 120_000,
      },
    );
    batch = JSON.parse(stdout) as BatchResult;
  } catch {
    batch = undefined; // interpreter/script failure → all misses stay unenriched
  }

  for (const m of misses) {
    const r = batch?.files?.[m.relPath];
    const fresh = r ? toEnrichment(r.calls, r.types) : { callRanges: new Set<string>(), typeRanges: new Map<string, string>() };
    out.set(m.relPath, fresh);
    if (cacheDir) {
      try {
        mkdirSync(cacheDir, { recursive: true });
        const artifact: PyArtifact = {
          calls: [...fresh.callRanges],
          types: [...fresh.typeRanges],
        };
        const path = join(cacheDir, `${m.key}.json`);
        const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
        writeFileSync(tmp, JSON.stringify(artifact));
        renameSync(tmp, path);
      } catch {
        /* cache write failure must never fail indexing */
      }
    }
  }
  return out;
}
