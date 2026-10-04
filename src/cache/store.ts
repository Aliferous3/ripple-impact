import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RippleGraph, graphFromData, graphToData } from "../graph/graph.js";
import { InvalidGraphArtifact, validateGraphArtifact } from "../graph/serialize.js";
import type { RepoFingerprint } from "./fingerprint.js";

/**
 * Repository-local, content-addressed cache:
 *
 *   <repo>/.ripple/cache/<fingerprint>/
 *     index.scip      raw SCIP index artifact
 *     graph.json      normalized Ripple graph (schema-versioned)
 *     metadata.json   what the key was derived from + when
 *
 * All artifacts are written to a temp name and atomically renamed, so a
 * killed or concurrent writer never leaves a torn cache entry. Reads
 * validate schemaVersion + JSON integrity; anything invalid is treated as
 * a cache miss and rebuilt — bad data is never trusted.
 */

export interface CacheMetadata {
  fingerprint: string;
  schemaVersion: number;
  scipTypescript: string;
  root: string;
  fileCount: number;
  createdAt: string;
  /** Optional provenance, e.g. "commit 9358371..." or "worktree". */
  revision?: string;
}

export interface CacheEntry {
  dir: string;
  metadata: CacheMetadata;
  graph: RippleGraph;
}

export type CacheStatus = "hit" | "miss";

export class RippleCache {
  readonly dir: string;

  constructor(private readonly repoRoot: string) {
    this.dir = join(repoRoot, ".ripple", "cache");
  }

  /** Load a graph only when the stored fingerprint matches exactly. */
  load(fp: RepoFingerprint): { status: CacheStatus; graph?: RippleGraph; reason?: string } {
    const dir = join(this.dir, fp.key);
    try {
      const metaRaw = readFileSync(join(dir, "metadata.json"), "utf8");
      const meta = JSON.parse(metaRaw) as CacheMetadata;
      if (meta.fingerprint !== fp.key) {
        return { status: "miss", reason: "fingerprint-mismatch" };
      }
      if (meta.schemaVersion !== fp.detail.schemaVersion) {
        return { status: "miss", reason: "schema-mismatch" };
      }
      if (!existsSync(join(dir, "index.scip"))) {
        return { status: "miss", reason: "missing index.scip" };
      }
      const graphRaw = readFileSync(join(dir, "graph.json"), "utf8");
      const data = validateGraphArtifact(JSON.parse(graphRaw));
      return { status: "hit", graph: graphFromData(data) };
    } catch (err) {
      const reason =
        err instanceof InvalidGraphArtifact
          ? err.message
          : err instanceof SyntaxError
            ? "invalid JSON"
            : (err as NodeJS.ErrnoException).code === "ENOENT"
              ? "missing entry"
              : String(err);
      return { status: "miss", reason };
    }
  }

  /**
   * Store index + graph + metadata atomically (temp write → rename).
   * indexBytes is optional (base-graph flows may not produce one); the
   * entry is still valid as long as the stored file exists — pass a
   * zero-length buffer when none was generated.
   */
  store(
    fp: RepoFingerprint,
    opts: { indexBytes?: Uint8Array; graph: RippleGraph; revision?: string },
  ): void {
    const dir = join(this.dir, fp.key);
    mkdirSync(dir, { recursive: true });
    const meta: CacheMetadata = {
      fingerprint: fp.key,
      schemaVersion: fp.detail.schemaVersion,
      scipTypescript: fp.detail.scipTypescript,
      root: this.repoRoot,
      fileCount: fp.fileCount,
      createdAt: new Date().toISOString(),
      revision: opts.revision,
    };
    this.atomicWrite(join(dir, "index.scip"), opts.indexBytes ?? new Uint8Array(0));
    this.atomicWrite(join(dir, "graph.json"), JSON.stringify(graphToData(opts.graph)));
    this.atomicWrite(join(dir, "metadata.json"), JSON.stringify(meta, null, 2));
  }

  /** Entries present in the cache (for `ripple cache status`). */
  list(): CacheMetadata[] {
    const out: CacheMetadata[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSafe(this.dir);
    } catch {
      return out;
    }
    for (const key of entries) {
      try {
        const meta = JSON.parse(
          readFileSync(join(this.dir, key, "metadata.json"), "utf8"),
        ) as CacheMetadata;
        out.push(meta);
      } catch {
        /* corrupt entry — reported via load() misses, omitted here */
      }
    }
    return out;
  }

  /** Remove only Ripple-owned state. */
  clear(): number {
    const n = existsSync(this.dir) ? readdirSafe(this.dir).length : 0;
    rmSync(this.dir, { recursive: true, force: true });
    return n;
  }

  private atomicWrite(path: string, data: string | Uint8Array): void {
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).map((d) => d.toString());
  } catch {
    return [];
  }
}
