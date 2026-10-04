import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { GRAPH_SCHEMA_VERSION } from "../graph/serialize.js";
import { classifyFile, type FileCallSites } from "../indexers/enrich/call-classifier.js";
import {
  typePositionsOfFile,
  type FileTypePositions,
  type ImportTypeAlias,
  type TypePositionHit,
} from "../indexers/enrich/type-positions.js";

const require = createRequire(import.meta.url);

/**
 * Content-addressed per-file cache for AST enrichment.
 *
 * `classifyFile` and `typePositionsOfFile` are pure functions of
 * (fileName, sourceText) — their output is identical whenever the file's
 * content is, so a repo-level fingerprint miss (one edited file) can still
 * reuse classification for the hundreds of files that did not change.
 * This is the working-tree reuse path; the whole-graph fingerprint cache
 * remains the correctness boundary.
 *
 * Key = sha256(schemaVersion, typescript version, path, content). A path
 * component is included because the AST script kind is filename-derived
 * (.tsx/.jsx parse differently).
 */

export interface FileEnrichment {
  callSites: FileCallSites;
  typePositions: FileTypePositions;
}

interface EnrichArtifact {
  calleeRanges: string[];
  typeRanges: [string, TypePositionHit][];
  importTypeAliases: [string, ImportTypeAlias][];
}

export function enrichFile(
  cacheDir: string | undefined,
  relPath: string,
  sourceText: string,
): FileEnrichment {
  if (!cacheDir) return compute(relPath, sourceText);
  const key = enrichKey(relPath, sourceText);
  const path = join(cacheDir, `${key}.json`);
  try {
    const a = JSON.parse(readFileSync(path, "utf8")) as EnrichArtifact;
    return {
      callSites: { calleeRanges: new Set(a.calleeRanges) },
      typePositions: {
        ranges: new Map(a.typeRanges),
        importTypeAliases: new Map(a.importTypeAliases),
      },
    };
  } catch {
    const fresh = compute(relPath, sourceText);
    try {
      mkdirSync(cacheDir, { recursive: true });
      const artifact: EnrichArtifact = {
        calleeRanges: [...fresh.callSites.calleeRanges],
        typeRanges: [...fresh.typePositions.ranges],
        importTypeAliases: [...fresh.typePositions.importTypeAliases],
      };
      const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      writeFileSync(tmp, JSON.stringify(artifact));
      renameSync(tmp, path);
    } catch {
      /* cache write failure must never fail indexing */
    }
    return fresh;
  }
}

function compute(relPath: string, sourceText: string): FileEnrichment {
  return {
    callSites: classifyFile(relPath, sourceText),
    typePositions: typePositionsOfFile(relPath, sourceText),
  };
}

function enrichKey(relPath: string, sourceText: string): string {
  let tsVersion = "unknown";
  try {
    tsVersion = require("typescript/package.json").version;
  } catch {
    /* leave unknown */
  }
  return createHash("sha256")
    .update(`enrich-schema:${GRAPH_SCHEMA_VERSION}`)
    .update(`\0typescript:${tsVersion}`)
    .update(`\0${relPath}\0`)
    .update(sourceText)
    .digest("hex");
}
