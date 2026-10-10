import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { GRAPH_SCHEMA_VERSION } from "../graph/serialize.js";
import type { ProjectFileRules } from "../indexers/adapter.js";
import { TS_FILE_RULES } from "../indexers/typescript/adapter.js";

const require = createRequire(import.meta.url);

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
    /** Sorted "id@version" adapter identities in the key. */
    adapters: string[];
  };
}

export interface FingerprintOptions {
  /**
   * Which files the fingerprint hashes — adapter-supplied rules,
   * unioned across detected projects. Defaults to the TS/JS adapter's
   * rules so standalone callers keep working.
   */
  files?: ProjectFileRules;
  /**
   * Adapter identities (sorted "id"/"version" pairs) that produced the
   * graph — cache entries are per-adapter-set, so a future Python
   * adapter can never hit a TypeScript cache.
   */
  adapters?: { id: string; version: string }[];
}

function adapterKey(adapters?: { id: string; version: string }[]): string[] {
  return (adapters ?? [{ id: "typescript-javascript", version: "1" }])
    .map((a) => `${a.id}@${a.version}`)
    .sort();
}

/**
 * Deterministic repository-state fingerprint.
 *
 * Participates:
 *  - contents of every file the detected adapters' rules claim
 *    (TS/JS today: .ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs plus
 *    tsconfig/jsconfig/package.json + lockfiles)
 *  - adapter identities + versions (indexer behavior)
 *  - installed scip-typescript version
 *  - the persisted graph schema version
 *
 * Content hashing — not HEAD, not mtimes — so uncommitted edits, partial
 * staging and dirty worktrees all change the key, while checkouts of the
 * same content reuse the cache. Non-git directories work identically.
 */
export function repoFingerprint(root: string, opts: FingerprintOptions = {}): RepoFingerprint {
  const rules = opts.files ?? TS_FILE_RULES;
  const files: { path: string; hash: string }[] = [];
  for (const path of repoFilePaths(root, rules)) {
    try {
      const hash = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
      files.push({ path, hash });
    } catch {
      /* unreadable — skip */
    }
  }
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

  const adapters = adapterKey(opts.adapters);
  const contentHex = contentHash.digest("hex");
  const key = createHash("sha256")
    .update(`ripple-schema:${GRAPH_SCHEMA_VERSION}`)
    .update(`\0adapters:${adapters.join(",")}`)
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
      adapters,
    },
  };
}

/**
 * Repo-relative paths (forward slashes, sorted) of every file the given
 * rules claim — code + config, excluding vendored/build/cache dirs.
 * Used for cache fingerprinting and for test-scope inspection.
 */
export function repoFilePaths(root: string, rules: ProjectFileRules = TS_FILE_RULES): string[] {
  const out: string[] = [];
  walk(root, root, out, rules);
  return out.sort();
}

function walk(root: string, dir: string, out: string[], rules: ProjectFileRules): void {
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
      walk(root, join(dir, name), out, rules);
    } else if (e.isFile()) {
      if (!rules.sourceFile(name) && !rules.configFile(name)) continue;
      const abs = join(dir, name);
      try {
        statSync(abs);
        out.push(abs.slice(root.length + 1).replace(/\\/g, "/"));
      } catch {
        /* unreadable — skip */
      }
    }
  }
}

/** Cache key for a committed revision — commit SHAs are immutable. */
export function commitFingerprint(sha: string, opts: FingerprintOptions = {}): RepoFingerprint {
  let scipVersion = "unknown";
  try {
    scipVersion = require("@sourcegraph/scip-typescript/package.json").version;
  } catch {
    /* leave unknown */
  }
  const adapters = adapterKey(opts.adapters);
  const key = createHash("sha256")
    .update(`ripple-schema:${GRAPH_SCHEMA_VERSION}`)
    .update(`\0adapters:${adapters.join(",")}`)
    .update(`\0scip-typescript:${scipVersion}`)
    .update(`\0commit:${sha}`)
    .digest("hex");
  return {
    key,
    fileCount: 0,
    detail: {
      contentHash: sha,
      scipTypescript: scipVersion,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      adapters,
    },
  };
}
