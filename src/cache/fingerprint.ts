import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { GRAPH_SCHEMA_VERSION } from "../graph/serialize.js";

const require = createRequire(import.meta.url);

/** Anything scip-typescript could index or resolve through. */
const CODE_EXT = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;
/** Config whose content changes what the index/graph means. */
const CONFIG_RE =
  /^(tsconfig[^/\\]*\.json|jsconfig[^/\\]*\.json|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".ripple",
  "dist",
  "out",
  "coverage",
  "build",
  ".next",
  ".turbo",
  ".cache",
]);

export interface RepoFingerprint {
  /** The cache key. */
  key: string;
  /** Number of hashed files — observability/debugging. */
  fileCount: number;
  /** Component digests for debugging/inspection. */
  detail: {
    contentHash: string;
    scipTypescript: string;
    schemaVersion: number;
  };
}

/**
 * Deterministic repository-state fingerprint.
 *
 * Participates:
 *  - contents of every code file scip-typescript could index
 *    (.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs, excluding vendored/build dirs)
 *  - contents of tsconfig / jsconfig / package.json + npm/pnpm/yarn/bun
 *    lockfiles at any depth (dependency resolution affects symbol binding)
 *  - installed scip-typescript version
 *  - the persisted graph schema version
 *
 * Content hashing — not HEAD, not mtimes — so uncommitted edits, partial
 * staging and dirty worktrees all change the key, while checkouts of the
 * same content reuse the cache. Non-git directories work identically.
 */
export function repoFingerprint(root: string): RepoFingerprint {
  const files: { path: string; hash: string }[] = [];
  walk(root, root, files);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const contentHash = createHash("sha256");
  for (const f of files) {
    contentHash.update(f.path);
    contentHash.update("\0");
    contentHash.update(f.hash);
    contentHash.update("\0");
  }

  let scipVersion = "unknown";
  try {
    scipVersion = require("@sourcegraph/scip-typescript/package.json").version;
  } catch {
    /* leave unknown */
  }

  const contentHex = contentHash.digest("hex");
  const key = createHash("sha256")
    .update(`ripple-schema:${GRAPH_SCHEMA_VERSION}`)
    .update(`\0scip-typescript:${scipVersion}`)
    .update(`\0content:${contentHex}`)
    .digest("hex");

  return {
    key,
    fileCount: files.length,
    detail: {
      contentHash: contentHex,
      scipTypescript: scipVersion,
      schemaVersion: GRAPH_SCHEMA_VERSION,
    },
  };
}

function walk(root: string, dir: string, out: { path: string; hash: string }[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = String(e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(root, join(dir, name), out);
    } else if (e.isFile()) {
      if (!CODE_EXT.test(name) && !CONFIG_RE.test(name)) continue;
      const abs = join(dir, name);
      try {
        const hash = createHash("sha256").update(readFileSync(abs)).digest("hex");
        out.push({ path: abs.slice(root.length + 1).replace(/\\/g, "/"), hash });
      } catch {
        /* unreadable — skip */
      }
    }
  }
}

/** Cache key for a committed revision — commit SHAs are immutable. */
export function commitFingerprint(sha: string): RepoFingerprint {
  let scipVersion = "unknown";
  try {
    scipVersion = require("@sourcegraph/scip-typescript/package.json").version;
  } catch {
    /* leave unknown */
  }
  const key = createHash("sha256")
    .update(`ripple-schema:${GRAPH_SCHEMA_VERSION}`)
    .update(`\0scip-typescript:${scipVersion}`)
    .update(`\0commit:${sha}`)
    .digest("hex");
  return {
    key,
    fileCount: 0,
    detail: { contentHash: sha, scipTypescript: scipVersion, schemaVersion: GRAPH_SCHEMA_VERSION },
  };
}
