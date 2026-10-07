import { useEffect, useState } from "react";
import { fetchSource } from "../api";
import type { AnalysisResult, ChangedSymbolJson, SourcePreview } from "../types";
import { relevantHunks } from "./model";

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={`mono ${className ?? ""}`}>{children}</span>;
}

export function FileRef({ file, line, className }: { file: string; line?: number; className?: string }) {
  const parts = file.split("/");
  const name = parts.pop();
  return (
    <span className={`fileref mono ${className ?? ""}`} title={line !== undefined ? `${file}:${line}` : file}>
      <span className="fileref-dir">{parts.join("/")}{parts.length ? "/" : ""}</span>
      <span className="fileref-name">{name}</span>
      {line !== undefined && <span className="fileref-dir">:{line}</span>}
    </span>
  );
}

export function WarnChip({ code, title, onClick }: { code: string; title?: string; onClick?: () => void }) {
  return (
    <button className="warnchip mono" title={title ?? code} onClick={onClick}>
      <span aria-hidden>△</span>
      {code}
    </button>
  );
}

/** Source preview with gutter + changed-line accent, fetched via /api/source. */
export function CodePreview({
  file,
  range,
  accent,
  compact = true,
}: {
  file: string;
  range?: { startLine: number; endLine: number };
  accent?: string;
  compact?: boolean;
}) {
  const [src, setSrc] = useState<SourcePreview | undefined>();
  useEffect(() => {
    setSrc(undefined);
    if (!range) return;
    let live = true;
    void fetchSource(file, Math.max(1, range.startLine - 1), range.endLine + 3)
      .then((r) => live && setSrc(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [file, range?.startLine, range?.endLine]);
  if (!range || !src) return null;
  const hl = (ln: number) => ln >= range.startLine + 1 && ln <= range.endLine + 1;
  return (
    <div className="codebox" data-testid="source-preview">
      <div className="codebox-head">
        <FileRef file={file} line={src.start} />
        <span className="codebox-tag">SOURCE</span>
      </div>
      <pre className={compact ? "codebox-pre compact" : "codebox-pre"}>
        {src.lines.map((l, i) => {
          const n = src.start + i;
          const changed = hl(n);
          return (
            <div
              key={n}
              className={`codebox-line ${changed ? "changed" : ""}`}
              style={changed && accent ? { boxShadow: `inset 2px 0 0 ${accent}` } : undefined}
            >
              <span className="codebox-no tabnum">{n}</span>
              <code className={changed ? "hot" : undefined}>{l}</code>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function fmtLines(start: number, end: number): string {
  return end <= start + 1 ? `L${start}` : `L${start}–${end - 1}`;
}

/** Git diff block for changed/deleted rows — real hunks only. */
export function DiffBlock({ c, a }: { c: ChangedSymbolJson; a: AnalysisResult }) {
  const hunks = relevantHunks(c, a);
  if (!hunks.length) return null;
  return (
    <div className="diffbox" data-testid="diff-preview">
      {hunks.slice(0, 3).map(({ file, hunk }, i) => (
        <div key={i}>
          <div className="codebox-head">
            <FileRef file={file} />
            <span className="codebox-tag chg">GIT DIFF</span>
          </div>
          <div className="diffbox-hunk mono">
            @@ −{fmtLines(hunk.oldRange.start, hunk.oldRange.end)} +
            {fmtLines(hunk.newRange.start, hunk.newRange.end)}
          </div>
          <pre className="codebox-pre">
            {hunk.removedLines.slice(0, 8).map((l, j) => (
              <div key={`d${j}`} className="codebox-line del">
                <span className="codebox-no" />
                <span className="diff-sign">−</span>
                <code>{l}</code>
              </div>
            ))}
            {hunk.addedLines.slice(0, 8).map((l, j) => (
              <div key={`a${j}`} className="codebox-line add">
                <span className="codebox-no" />
                <span className="diff-sign">+</span>
                <code>{l}</code>
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

/** Why-uncertain explainer — driven by a real AnalysisWarning. */
export function UncertaintyCard({ w }: { w: AnalysisResult["warnings"][number] }) {
  return (
    <div className="uncertain">
      <div className="uncertain-head">
        <span className="warn-text mono">△ {w.code}</span>
      </div>
      {w.file && <FileRef file={w.file} className="uncertain-where" />}
      <p className="uncertain-msg">{w.message}</p>
      {w.files && w.files.length > 0 && (
        <ul className="uncertain-files mono">
          {w.files.slice(0, 6).map((f) => (
            <li key={f}>{f}</li>
          ))}
          {w.files.length > 6 && <li>…+{w.files.length - 6} more</li>}
        </ul>
      )}
    </div>
  );
}
