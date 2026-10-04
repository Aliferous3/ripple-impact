import { useEffect, useMemo, useState } from "react";
import type { AnalysisResult, ChangedSymbolJson, DiffHunk } from "./types";
import type { VMNode, ViewModel } from "./viewmodel";
import { fetchNode, fetchSource } from "./api";
import type { NodeDetail, SourcePreview } from "./types";

const STATUS_LABEL: Record<string, string> = {
  changed: "CHANGED",
  deleted: "DELETED",
  direct: "DIRECTLY AFFECTED",
  transitive: "TRANSITIVELY AFFECTED",
  test: "RELEVANT TEST",
  referencing: "REFERENCING ONLY",
};
const STATUS_COLOR: Record<string, string> = {
  changed: "var(--c-changed)",
  deleted: "var(--c-deleted)",
  direct: "var(--c-direct)",
  transitive: "var(--c-transitive)",
  test: "var(--c-test)",
  referencing: "var(--c-referencing)",
};

function fmtLines(start: number, end: number): string {
  return start === end - 1 || end <= start ? `L${start}` : `L${start}–${end - 1}`;
}

function range1(r?: { startLine: number; endLine: number }): string {
  if (!r) return "—";
  return `L${r.startLine + 1}–${r.endLine + 1}`;
}

/** Hunks whose old/new side intersects any of the symbol's evidence ranges. */
function relevantHunks(c: ChangedSymbolJson, a: AnalysisResult): DiffHunk[] {
  const file = a.diffFiles.find((f) => f.path === c.file || f.oldPath === c.file);
  if (!file) return [];
  const overlap = (hs: number, he: number, s?: number, e?: number) =>
    s === undefined || e === undefined || (hs < e && s < he);
  return file.hunks.filter((h) =>
    c.evidence.some(
      (ev) =>
        overlap(h.newRange.start, h.newRange.end, ev.newRange?.start, ev.newRange?.end) ||
        overlap(h.oldRange.start, h.oldRange.end, ev.oldRange?.start, ev.oldRange?.end),
    ),
  );
}

function DiffPreview({ c, a }: { c: ChangedSymbolJson; a: AnalysisResult }) {
  const hunks = relevantHunks(c, a);
  if (hunks.length === 0) return null;
  return (
    <div className="diff-preview" data-testid="diff-preview">
      {hunks.slice(0, 3).map((h, i) => (
        <div key={i}>
          <div className="hunk-head">
            @@ {c.file} −{fmtLines(h.oldRange.start, h.oldRange.end)} +
            {fmtLines(h.newRange.start, h.newRange.end)}
          </div>
          {h.removedLines.slice(0, 8).map((l, j) => (
            <div key={`d${j}`} className="dl del">− {l}</div>
          ))}
          {h.addedLines.slice(0, 8).map((l, j) => (
            <div key={`a${j}`} className="dl add">+ {l}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SourcePreviewBox({ file, range }: { file: string; range?: { startLine: number; endLine: number } }) {
  const [src, setSrc] = useState<SourcePreview | undefined>();
  useEffect(() => {
    setSrc(undefined);
    if (!range) return;
    void fetchSource(file, Math.max(1, range.startLine - 1), range.endLine + 3).then(setSrc);
  }, [file, range?.startLine, range?.endLine]);
  if (!src) return null;
  const hl = (ln: number) =>
    range && ln >= range.startLine + 1 && ln <= range.endLine + 1;
  return (
    <div className="code-preview" data-testid="source-preview">
      {src.lines.map((l, i) => {
        const ln = src.start + i;
        return (
          <div key={ln} className={`ln ${hl(ln) ? "hl" : ""}`}>
            <span className="no">{ln}</span>
            <span>{l}</span>
          </div>
        );
      })}
    </div>
  );
}

export function DetailsPanel({
  node,
  vm,
  analysis,
  onFocus,
  onSelect,
}: {
  node: VMNode | undefined;
  vm: ViewModel;
  analysis: AnalysisResult;
  onFocus: (rootId: string | undefined) => void;
  onSelect: (id: string | undefined) => void;
}) {
  const [detail, setDetail] = useState<NodeDetail | undefined>();
  const isRealNode = node !== undefined && !node.id.startsWith("deleted:");

  useEffect(() => {
    setDetail(undefined);
    if (node && isRealNode) void fetchNode(node.id).then(setDetail).catch(() => {});
  }, [node?.id]);

  const nodeWarnings = useMemo(
    () =>
      analysis.warnings.filter(
        (w) => (node && w.symbol === node.label) || (node && w.file === node.file),
      ),
    [analysis, node],
  );

  if (!node) {
    return (
      <div className="details" data-testid="details-panel">
        <div className="empty-hint">
          Select a node to see why Ripple believes it changed or is affected.
        </div>
      </div>
    );
  }

  const status = STATUS_LABEL[node.category] ?? node.category;
  const color = STATUS_COLOR[node.category];
  const isRoot = node.category === "changed" || node.category === "deleted";

  return (
    <div className="details" data-testid="details-panel">
      <div className="sym">{node.label}</div>
      <div style={{ margin: "6px 0 10px" }}>
        <span className="status-chip" style={{ background: color, color: "#101216" }}>
          {node.changeKind ? `${status} · ${node.changeKind.toUpperCase()}` : status}
        </span>
      </div>

      <div className="kv"><span className="k">Kind</span><span className="v">{node.kind}</span></div>
      <div className="kv"><span className="k">File</span><span className="v">{node.file}</span></div>
      {detail?.node.extent && (
        <div className="kv"><span className="k">Lines</span><span className="v">{range1(detail.node.extent)}</span></div>
      )}
      {detail && (
        <>
          <div className="kv"><span className="k">Downstream reach</span><span className="v">{detail.reach.symbols} symbols · {detail.reach.files} files</span></div>
          <div className="kv"><span className="k">Direct callers</span><span className="v">{detail.reach.directCallers}</span></div>
          <div className="kv"><span className="k">Relevant tests</span><span className="v">{detail.reach.tests}</span></div>
        </>
      )}
      {nodeWarnings.length > 0 && (
        <div className="kv"><span className="k">Warnings</span><span className="v" style={{ color: "var(--c-changed)" }}>{nodeWarnings.length}</span></div>
      )}

      {isRoot && (
        <div style={{ margin: "10px 0" }}>
          <button className="btn" data-testid="focus-btn" onClick={() => onFocus(node.id)}>
            Focus this change
          </button>
        </div>
      )}

      {node.changedInfo && (
        <>
          <h3>Why Ripple thinks this changed</h3>
          {node.changedInfo.renamedFrom && (
            <div className="path-block">
              Moved from <span className="mono">{node.changedInfo.renamedFrom.file}::{node.changedInfo.renamedFrom.name}</span>
            </div>
          )}
          {node.changedInfo.changeKind === "deleted" && (
            <div className="path-block">This symbol no longer exists in the working tree.</div>
          )}
          {node.changedInfo.evidence.map((ev, i) => (
            <div key={i} className="evidence-line">
              {ev.file}
              {ev.oldRange && ` · old ${fmtLines(ev.oldRange.start, ev.oldRange.end)}`}
              {ev.newRange && ` · new ${fmtLines(ev.newRange.start, ev.newRange.end)}`}
            </div>
          ))}
          <DiffPreview c={node.changedInfo} a={analysis} />
        </>
      )}

      {node.deletedInfo && node.deletedInfo.formerCallers.length > 0 && (
        <>
          <h3>Former callers (base revision)</h3>
          {node.deletedInfo.formerCallers.map((c) => (
            <div key={c.id} className="list-item" onClick={() => onSelect(c.id)}>
              <span className="mono">{c.name}</span>
              <span className="sub">{c.file}</span>
            </div>
          ))}
        </>
      )}

      {node.paths.length > 0 && (
        <>
          <h3>Why is {node.label} affected?</h3>
          {node.paths.map((p, pi) => {
            const rootNode = vm.byId.get(p.root);
            return (
              <div key={pi} className="path-block" data-testid="why-path">
                <div className="root-tag">via {rootNode?.label ?? p.root}</div>
                {p.nodes.map((n, i) => (
                  <div key={i}>
                    <div className="path-step">
                      {i > 0 && <span className="arrow">↑ </span>}
                      {n.name}
                      <span className="sub" style={{ color: "var(--faint)" }}> {n.file}</span>
                    </div>
                    {p.edges[i - 1]?.evidence.map((ev, j) => (
                      <div key={j} className="evidence-line">
                        {p.edges[i - 1].kind} · {ev.file}:{ev.range.startLine + 1} · {ev.source}
                        {p.edges[i - 1].confidence && p.edges[i - 1].confidence !== "certain"
                          ? ` · ${p.edges[i - 1].confidence}`
                          : ""}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}

      {detail && detail.out.length + detail.in.length > 0 && (
        <>
          <h3>Edges</h3>
          {detail.in.slice(0, 12).map((e, i) => (
            <div key={`i${i}`} className="path-step">
              <span className="arrow">← </span>{e.fromName}
              <span className="sub" style={{ color: "var(--faint)" }}> {e.kind}</span>
            </div>
          ))}
          {detail.out.slice(0, 12).map((e, i) => (
            <div key={`o${i}`} className="path-step">
              <span className="arrow">→ </span>{e.toName}
              <span className="sub" style={{ color: "var(--faint)" }}> {e.kind}</span>
            </div>
          ))}
        </>
      )}

      <h3>Source</h3>
      <SourcePreviewBox
        file={node.file}
        range={detail?.node.extent ?? detail?.node.range ?? node.range}
      />
    </div>
  );
}
