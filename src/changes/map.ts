import type { RippleGraph } from "../graph/graph.js";
import type { GraphNode, SourceRange } from "../graph/types.js";
import type { GitDiff, LineRange } from "../git/types.js";
import type { GitDiffProvider } from "../git/provider.js";
import type {
  ChangedSymbol,
  ChangeKind,
  ChangeSet,
  NonSemanticChange,
  UnmappedFile,
} from "./types.js";
import { classifyHunk } from "./classify.js";
import { extractDefs, normalizeBody, typeOnlyModuleRanges, type SourceDef } from "./ast-defs.js";

const CODE_EXT = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;

const KIND_PRIORITY: Record<ChangeKind, number> = {
  "module-scope": 0,
  modified: 1,
  added: 2,
  renamed: 3,
  deleted: 4,
};

interface Tombstone {
  def: SourceDef;
  file: string;
  evidence: ChangedSymbol["evidence"];
  /** Name of the smallest enclosing def in the old file, if any. */
  parentName?: string;
}

/**
 * Maps a GitDiff onto Ripple-graph symbols.
 *
 * New-side hunks  → intersect enclosing extents in the CURRENT graph;
 *                   innermost containing symbol wins; nothing matched → the
 *                   file node is marked "module-scope" (never a sibling).
 * Old-side hunks  → AST-def extraction on the OLD file text (`git show`);
 *                   fully-removed defs become tombstones, partially-removed
 *                   defs mark the surviving same-named symbol "modified".
 * Deleted whole-file → every old def becomes a tombstone.
 * Renames/moves    → tombstone + added node with identical normalized body
 *                   (comments/whitespace stripped) → "renamed", evidence-backed.
 */
export function mapDiffToChangedSymbols(
  graph: RippleGraph,
  diff: GitDiff,
  provider: GitDiffProvider,
): ChangeSet {
  const marks = new Map<string, ChangedSymbol>();
  const tombstones: Tombstone[] = [];
  const nonSemantic: NonSemanticChange[] = [];
  const unmappedFiles: UnmappedFile[] = [];
  const renamedFiles: { from: string; to: string }[] = [];
  const newTextByFile = new Map<string, string>();
  const newDefNamesByFile = new Map<string, Set<string>>();
  const fileNodeByFile = new Map<string, GraphNode>();
  const deletionEvidenceByFile = new Map<string, ChangedSymbol["evidence"]>();
  const typeOnlyOldByFile = new Map<string, SourceRange[]>();

  const mark = (
    node: GraphNode | undefined,
    id: string,
    name: string,
    file: string,
    kind: ChangeKind,
    evidence: ChangedSymbol["evidence"][number],
    renamedFrom?: ChangedSymbol["renamedFrom"],
  ): void => {
    const cur = marks.get(id);
    if (!cur) {
      marks.set(id, {
        node,
        symbolId: id,
        name,
        file,
        changeKind: kind,
        renamedFrom,
        evidence: [evidence],
      });
      return;
    }
    if (KIND_PRIORITY[kind] > KIND_PRIORITY[cur.changeKind]) {
      cur.changeKind = kind;
    }
    if (renamedFrom && !cur.renamedFrom) cur.renamedFrom = renamedFrom;
    const key = `${evidence.file}:${evidence.oldRange?.start}-${evidence.oldRange?.end}:${evidence.newRange?.start}-${evidence.newRange?.end}`;
    if (!cur.evidence.some((e) => `${e.file}:${e.oldRange?.start}-${e.oldRange?.end}:${e.newRange?.start}-${e.newRange?.end}` === key)) {
      cur.evidence.push(evidence);
    }
  };

  for (const file of diff.files) {
    const path = file.path === "/dev/null" ? (file.oldPath ?? file.path) : file.path;
    // .ripple/ is Ripple-owned cache state, never user code — skip silently
    // so cache writes can't feed back into the analysis as "changes".
    if (path === ".ripple" || path.startsWith(".ripple/")) continue;
    if (file.binary) {
      unmappedFiles.push({ file: path, status: file.status, reason: "binary" });
      continue;
    }
    if (!CODE_EXT.test(path)) {
      unmappedFiles.push({ file: path, status: file.status, reason: "not-indexed" });
      continue;
    }

    const oldText = provider.showFile(diff.oldRev, file.oldPath ?? file.path);
    const newText = provider.readWorktreeFile(file.path);
    if (newText !== undefined) newTextByFile.set(file.path, newText);

    if (file.status === "renamed" && file.oldPath) {
      renamedFiles.push({ from: file.oldPath, to: file.path });
    }

    if (file.status === "deleted") {
      if (oldText === undefined) {
        unmappedFiles.push({ file: path, status: file.status, reason: "unreadable" });
        continue;
      }
      const oldFileDefs = extractDefs(path, oldText);
      for (const def of oldFileDefs) {
        tombstones.push({
          def,
          file: path,
          evidence: [],
          parentName: smallestContaining(oldFileDefs, def)?.name,
        });
      }
      continue;
    }

    const nodesInFile = graph.nodes.filter(
      (n) => n.file === file.path && n.range !== undefined,
    );
    const fileNode = graph.nodes.find(
      (n) => n.file === file.path && n.range === undefined,
    );
    if (fileNode) fileNodeByFile.set(file.path, fileNode);

    if (nodesInFile.length === 0 && !fileNode) {
      // e.g. a deleted-but-not-in-index file, or a tsconfig-excluded file.
      unmappedFiles.push({ file: file.path, status: file.status, reason: "not-indexed" });
      continue;
    }

    // Classify hunks: only "code" hunks may attribute symbols.
    const codeHunks: typeof file.hunks = [];
    for (const hunk of file.hunks) {
      const cls = classifyHunk(file.path, hunk, oldText, newText);
      if (cls === "code") {
        codeHunks.push(hunk);
      } else {
        nonSemantic.push({
          file: file.path,
          kind: cls,
          newRange: hunk.newRange,
          oldRange: hunk.oldRange,
        });
      }
    }
    if (codeHunks.length === 0) continue;

    const oldDefs = oldText !== undefined ? extractDefs(path, oldText) : [];
    const newDefs = newText !== undefined ? extractDefs(path, newText) : [];
    // Type-only import/export statements can't affect runtime — hunks fully
    // inside them get a typeOnly module-scope mark, not runtime propagation.
    const oldTypeOnly = oldText !== undefined ? typeOnlyModuleRanges(path, oldText) : [];
    const newTypeOnly = newText !== undefined ? typeOnlyModuleRanges(path, newText) : [];
    if (oldText !== undefined) typeOnlyOldByFile.set(file.path, oldTypeOnly);
    const hunkTypeOnly = (h: (typeof codeHunks)[number]): boolean =>
      (h.newRange.end <= h.newRange.start || rangeWithin(h.newRange, newTypeOnly)) &&
      (h.oldRange.end <= h.oldRange.start || rangeWithin(h.oldRange, oldTypeOnly));
    newDefNamesByFile.set(file.path, new Set(newDefs.map((d) => d.name)));
    const removedIntervals = mergeIntervals(
      codeHunks
        .filter((h) => h.oldRange.end > h.oldRange.start)
        .map((h) => [h.oldRange.start - 1, h.oldRange.end - 1] as [number, number]),
    );
    const addedLines = new Set<number>();
    for (const h of codeHunks) {
      for (let l = h.newRange.start; l < h.newRange.end; l++) addedLines.add(l);
    }

    let moduleEvidence: ChangedSymbol["evidence"] = [];
    let moduleTypeOnlyEvidence: ChangedSymbol["evidence"] = [];

    // --- new side: changed lines → innermost containing symbol extent ---
    // Block-scoped/destructured locals (`name:` descriptors) are excluded —
    // not graph-addressable — so attribution lands on the enclosing symbol
    // or module scope instead of a meaningless local node.
    const addressableInFile = nodesInFile.filter(
      (n) => !(n.kind === "variable" && n.name.endsWith(":")),
    );
    for (const hunk of codeHunks) {
      if (hunk.newRange.end > hunk.newRange.start) {
        const candidates = addressableInFile.filter((n) =>
          lineOverlap(n.extent ?? n.range!, hunk.newRange),
        );
        const innermost = candidates.filter(
          (c) =>
            !candidates.some(
              (o) =>
                o !== c &&
                strictlyContainsLines(c.extent ?? c.range!, o.extent ?? o.range!) &&
                lineOverlap(o.extent ?? o.range!, hunk.newRange),
            ),
        );
        if (innermost.length === 0) {
          const ev = { file: file.path, newRange: hunk.newRange, oldRange: hunk.oldRange };
          if (hunkTypeOnly(hunk)) {
            moduleTypeOnlyEvidence.push(ev);
          } else {
            moduleEvidence.push(ev);
          }
        }
        for (const node of innermost) {
          mark(node, node.id, node.name, file.path, "modified", {
            file: file.path,
            newRange: hunk.newRange,
            oldRange: hunk.oldRange,
          });
        }
      }

      // --- old side: fully-removed defs → tombstones; partial → survivors ---
      if (hunk.oldRange.end > hunk.oldRange.start && oldDefs.length > 0) {
        const list = deletionEvidenceByFile.get(file.path) ?? [];
        list.push({ file: file.path, oldRange: hunk.oldRange });
        deletionEvidenceByFile.set(file.path, list);
        const hit = oldDefs.filter((d) => lineOverlap(d.extent, hunk.oldRange));
        const innermostOld = hit.filter(
          (d) => !hit.some((o) => o !== d && strictlyContainsLines(d.extent, o.extent)),
        );
        for (const def of innermostOld) {
          const fullyRemoved = intervalsCover(removedIntervals, [
            def.extent.startLine,
            def.extent.endLine,
          ]);
          if (fullyRemoved) {
            const parent = smallestContaining(oldDefs, def);
            tombstones.push({
              def,
              file: file.path,
              evidence: [{ file: file.path, oldRange: hunk.oldRange }],
              parentName: parent?.name,
            });
            // The smallest surviving enclosing def also changed (it lost
            // lines). E.g. deleting a local const inside a function modifies
            // the function even though the removed name is not a graph node.
            if (parent) {
              const survivor = nodesInFile.find(
                (n) => n.file === file.path && sameName(n.name, parent.name),
              );
              if (survivor) {
                mark(survivor, survivor.id, survivor.name, file.path, "modified", {
                  file: file.path,
                  oldRange: hunk.oldRange,
                });
              }
            }
          } else {
            const survivor = nodesInFile.find(
              (n) => n.file === file.path && sameName(n.name, def.name),
            );
            if (survivor) {
              mark(survivor, survivor.id, survivor.name, file.path, "modified", {
                file: file.path,
                oldRange: hunk.oldRange,
                newRange: hunk.newRange.end > hunk.newRange.start ? hunk.newRange : undefined,
              });
            } else if (newDefs.some((d) => sameName(d.name, def.name))) {
              // The symbol still exists in the new file but is not a graph
              // node (e.g. a function-local variable). Its enclosing symbol
              // is already attributed via the new-side hunk — not a deletion.
            } else {
              tombstones.push({
                def,
                file: file.path,
                evidence: [{ file: file.path, oldRange: hunk.oldRange }],
                parentName: smallestContaining(oldDefs, def)?.name,
              });
            }
          }
        }
      }
    }

    // Upgrade "modified" → "added" when the def's name line is in added lines
    // and no same-named def existed in the old revision.
    if (file.status === "added") {
      for (const node of nodesInFile) {
        // scip-typescript encodes block-scoped/destructured locals as
        // `name:` descriptors — not graph-addressable, so adding a file must
        // not report every local const as an added symbol.
        if (node.kind === "variable" && node.name.endsWith(":")) continue;
        mark(node, node.id, node.name, file.path, "added", { file: file.path });
      }
      if (fileNode) {
        mark(fileNode, fileNode.id, `${file.path} (module scope)`, file.path, "added",
          { file: file.path });
      }
    } else {
      for (const m of marks.values()) {
        if (m.file !== file.path || !m.node?.range) continue;
        const nameLine = m.node.range.startLine + 1; // 1-based
        if (!addedLines.has(nameLine)) continue;
        const existed = oldDefs.some((d) => sameName(d.name, m.name));
        if (!existed) m.changeKind = "added";
      }
      if (moduleEvidence.length > 0 && fileNode) {
        mark(fileNode, fileNode.id, `${file.path} (module scope)`, file.path,
          "module-scope", moduleEvidence[0]);
        for (const e of moduleEvidence.slice(1)) marks.get(fileNode.id)!.evidence.push(e);
      } else if (moduleTypeOnlyEvidence.length > 0 && fileNode) {
        // Every unattributed change was inside provably type-only import/export
        // statements — the module changed, but runtime must not propagate.
        mark(fileNode, fileNode.id, `${file.path} (module scope)`, file.path,
          "module-scope", moduleTypeOnlyEvidence[0]);
        marks.get(fileNode.id)!.typeOnly = true;
        for (const e of moduleTypeOnlyEvidence.slice(1)) marks.get(fileNode.id)!.evidence.push(e);
      }
    }
  }

  // Rename / move detection: identical normalized body on both sides.
  const keptTombstones: Tombstone[] = [];
  for (const t of tombstones) {
    let matched: ChangedSymbol | undefined;
    const oldNorm = normalizeBody(t.file, t.def.bodyText);
    for (const m of marks.values()) {
      if (m.changeKind !== "added" || !m.node?.extent) continue;
      const newText = newTextByFile.get(m.file);
      if (newText === undefined) continue;
      const newBody = sliceRange(newText, m.node.extent);
      if (oldNorm.length > 0 && oldNorm === normalizeBody(m.file, newBody)) {
        matched = m;
        break;
      }
    }
    if (matched) {
      matched.changeKind = "renamed";
      matched.renamedFrom = { name: t.def.name, file: t.file };
      matched.evidence.push(...t.evidence);
    } else {
      keptTombstones.push(t);
    }
  }

  // Deleted-local attribution rule:
  //   - a def nested inside a function/method body (local) never becomes a
  //     tombstone — it is not graph-addressable; its enclosing def was
  //     already marked modified, or is itself deleted
  //   - a top-level def whose enclosing def is also deleted collapses into
  //     the parent's tombstone
  //   - remaining top-level tombstones are reported as `deleted`
  const tombKeys = new Set(
    keptTombstones.map((t) => `${t.file}\n${t.def.name}`),
  );
  const visibleTombstones = keptTombstones.filter((t) => {
    if (!t.def.topLevel) return false;
    if (t.parentName && tombKeys.has(`${t.file}\n${t.parentName}`)) return false;
    return true;
  });

  const attributedFiles = new Set<string>([
    ...[...marks.values()].map((m) => m.file),
    ...visibleTombstones.map((t) => t.file),
  ]);
  // Deleted lines that produced no symbol and no tombstone still mean the
  // file changed — attribute honestly at module scope.
  for (const [file, evidence] of deletionEvidenceByFile) {
    if (attributedFiles.has(file)) continue;
    const fileNode = fileNodeByFile.get(file);
    if (fileNode) {
      mark(fileNode, fileNode.id, `${file} (module scope)`, file, "module-scope",
        evidence[0]);
      const typeOnlyRanges = typeOnlyOldByFile.get(file);
      const allTypeOnly =
        typeOnlyRanges !== undefined &&
        evidence.every(
          (e) =>
            e.oldRange !== undefined &&
            rangeWithin(e.oldRange, typeOnlyRanges),
        );
      if (allTypeOnly) marks.get(fileNode.id)!.typeOnly = true;
      for (const e of evidence.slice(1)) marks.get(fileNode.id)!.evidence.push(e);
      attributedFiles.add(file);
    }
  }

  for (const t of dedupeTombstones(visibleTombstones)) {
    mark(undefined, `deleted:${t.file}:${t.def.name}`, t.def.name, t.file, "deleted",
      t.evidence[0] ?? { file: t.file });
    if (t.evidence.length > 1) {
      marks.get(`deleted:${t.file}:${t.def.name}`)!.evidence.push(...t.evidence.slice(1));
    }
  }

  return {
    changed: [...marks.values()].sort(
      (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
    ),
    nonSemantic,
    unmappedFiles,
    renamedFiles,
  };
}

function sameName(nodeName: string, defName: string): boolean {
  return nodeName.replace(/\(\)$/, "") === defName;
}

/** Every line of a 1-based half-open diff range lies inside `spans`. */
function rangeWithin(r: LineRange, spans: SourceRange[]): boolean {
  for (let l = r.start - 1; l < r.end - 1; l++) {
    if (!spans.some((s) => l >= s.startLine && l <= s.endLine)) return false;
  }
  return true;
}

/** Half-open 1-based diff range vs inclusive line span of a SourceRange. */
function lineOverlap(span: SourceRange, hunk: LineRange): boolean {
  const s = hunk.start - 1;
  const e = hunk.end - 1; // exclusive
  return span.startLine < e && s <= span.endLine;
}

function strictlyContainsLines(outer: SourceRange, inner: SourceRange): boolean {
  return (
    outer.startLine <= inner.startLine &&
    outer.endLine >= inner.endLine &&
    (outer.startLine < inner.startLine || outer.endLine > inner.endLine)
  );
}

function mergeIntervals(ivs: [number, number][]): [number, number][] {
  const sorted = [...ivs].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([...iv]);
  }
  return out;
}

/** True when merged `intervals` fully cover [start, end] (inclusive). */
function intervalsCover(intervals: [number, number][], span: [number, number]): boolean {
  let cursor = span[0];
  for (const [s, e] of intervals) {
    if (s > cursor) return false;
    cursor = Math.max(cursor, e + 1);
    if (cursor > span[1]) return true;
  }
  return cursor > span[1];
}

function sliceRange(text: string, range: SourceRange): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const start = starts[range.startLine] + range.startChar;
  const endLine = Math.min(range.endLine, starts.length - 1);
  const next = endLine + 1 < starts.length ? starts[endLine + 1] : text.length;
  return text.slice(start, Math.min(starts[endLine] + range.endChar, next));
}

/** Smallest def in `defs` that strictly contains `inner`'s extent. */
function smallestContaining(defs: SourceDef[], inner: SourceDef): SourceDef | undefined {
  let best: SourceDef | undefined;
  for (const d of defs) {
    if (d === inner) continue;
    if (!strictlyContainsLines(d.extent, inner.extent)) continue;
    if (!best || strictlyContainsLines(best.extent, d.extent)) best = d;
  }
  return best;
}

function dedupeTombstones(ts: Tombstone[]): Tombstone[] {
  const seen = new Map<string, Tombstone>();
  for (const t of ts) {
    const key = `${t.file}\n${t.def.name}`;
    const cur = seen.get(key);
    if (cur) cur.evidence.push(...t.evidence);
    else seen.set(key, { ...t, evidence: [...t.evidence] });
  }
  return [...seen.values()];
}
