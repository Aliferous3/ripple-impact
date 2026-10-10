import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceSemantics } from "../../changes/semantics.js";
import type { SourceRange } from "../../graph/types.js";
import type { SourceDef } from "../../changes/ast-defs.js";
import type { PythonEnv } from "./interpreter.js";

/**
 * TypeScript-side glue for the deterministic Python source facts emitted
 * by `python/enrich.py` in "sourcemap" mode. The stdlib `ast`/`tokenize`
 * implementation is authoritative — this module only transports ranges.
 */

const ENRICH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../python/enrich.py",
);

interface PyDef {
  name: string;
  kind: SourceDef["kind"];
  nameRange: [number, number, number, number];
  extent: [number, number, number, number];
  start: number;
  end: number;
  topLevel: boolean;
}

interface SourcemapOut {
  defs?: PyDef[];
  comments?: [number, number][];
  literals?: [number, number][];
  typeOnly?: [number, number, number, number][];
}

const toRange = (r: [number, number, number, number]): SourceRange => ({
  startLine: r[0],
  startChar: r[1],
  endLine: r[2],
  endChar: r[3],
});

function runSourcemap(env: PythonEnv, file: string, text: string): SourcemapOut | undefined {
  try {
    const out = execFileSync(
      env.exe,
      [...env.args, ENRICH],
      {
        input: JSON.stringify({ mode: "sourcemap", files: [{ id: file, text }] }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const parsed = JSON.parse(out) as { files?: Record<string, SourcemapOut> };
    return parsed.files?.[file];
  } catch {
    return undefined;
  }
}

/**
 * SourceSemantics backed by Python's own ast/tokenize. Facts are memoized
 * per source text so hunk classification, def extraction, and body
 * normalization share one helper invocation per file revision.
 *
 * Failure handling is conservative: a missing interpreter or crashed
 * helper yields no defs/type-only ranges (under-claims, never invents)
 * and treats the whole file as literal text (whitespace is significant,
 * so hunks classify "code" rather than being silently dropped).
 */
export function pySourceSemantics(
  pythonEnv: () => PythonEnv | undefined,
): SourceSemantics {
  const cache = new Map<string, SourcemapOut | null>();
  const facts = (file: string, text: string): SourcemapOut | undefined => {
    let entry = cache.get(text);
    if (entry === undefined) {
      const env = pythonEnv();
      entry = env === undefined ? null : (runSourcemap(env, file, text) ?? null);
      cache.set(text, entry);
    }
    return entry === null ? undefined : entry;
  };
  return {
    extractDefs: (file, text) =>
      (facts(file, text)?.defs ?? []).map((d) => ({
        name: d.name,
        kind: d.kind,
        nameRange: toRange(d.nameRange),
        extent: toRange(d.extent),
        bodyText: text.slice(d.start, d.end),
        topLevel: d.topLevel,
      })),
    commentRanges: (file, text) => facts(file, text)?.comments ?? [],
    literalRanges: (file, text) => {
      const lit = facts(file, text)?.literals;
      return lit ?? [[0, text.length]];
    },
    typeOnlyModuleRanges: (file, text) =>
      (facts(file, text)?.typeOnly ?? []).map(toRange),
  };
}
