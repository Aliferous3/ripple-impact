import type { AnalysisResult } from "../types";
import {
  REL_META,
  TIER_GLYPH,
  whyTitle,
  type CascadeModel,
  type CascadeRow,
  type EvidenceGroup,
  type RootPath,
} from "./model";
import { CodePreview, DiffBlock, FileRef, Mono, UncertaintyCard } from "./ui";

const fmtLines = (s?: { startLine: number; endLine: number }) =>
  s ? (s.endLine <= s.startLine + 1 ? `L${s.startLine + 1}` : `L${s.startLine + 1}–${s.endLine + 1}`) : undefined;

const WEAK: Record<string, string> = { high: "HIGH", inferred: "INFERRED" };

/** One evidence group — may expand to show multiple sites on the same line. */
function EvidenceLine({ g }: { g: EvidenceGroup }) {
  const rel = REL_META[g.rel] ?? { arrow: "→", label: g.rel };
  return (
    <div className="ev-line">
      <div className="ev-head mono">
        <span className="ev-rel">{rel.label.toUpperCase()}</span>
        <FileRef file={g.file} line={g.line} />
        {g.sites.length > 1 && <span className="ev-sites">{g.sites.length} sites</span>}
      </div>
      {g.sites.length > 1 && (
        <ul className="ev-sub mono">
          {g.sites.map((s, i) => (
            <li key={i}>
              {s.file}:{s.line} · {s.source}
              {s.detail ? ` · ${s.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Root → … → node evidence path, concept-style vertical chain. */
function PathChain({ path, model, onJump }: { path: RootPath; model: CascadeModel; onJump: (id: string) => void }) {
  return (
    <ol className="pathchain">
      {path.steps.map((step, i) => {
        const edge = i > 0 ? path.edges[i - 1] : undefined;
        const rel = edge ? REL_META[edge.rel] ?? { arrow: "→", label: edge.rel } : undefined;
        const site = edge?.evidence[0];
        const row = model.byId.get(step.id);
        const color = row ? undefined : "#5b6676";
        return (
          <li key={`${step.id}-${i}`}>
            {edge && rel && (
              <div className="pathchain-link mono">
                ↓ {rel.label}
                {site && (
                  <span className="pathchain-at">
                    {" "}· {site.file.split("/").pop()}:{site.line}
                  </span>
                )}
                {edge.confidence && WEAK[edge.confidence] && (
                  <span className="pathchain-conf">· {WEAK[edge.confidence]}</span>
                )}
              </div>
            )}
            <button
              className="pathchain-node mono"
              onClick={() => onJump(step.id)}
              style={color ? { color } : undefined}
            >
              {i === 0 ? "◆ " : "  "}
              {step.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Inline WHY expansion — opens directly under the claim. Two columns on
 * wide screens: evidence path + per-edge evidence | diff + source +
 * uncertainty.
 */
export function WhyBlock({
  row,
  model,
  analysis,
  onJump,
}: {
  row: CascadeRow;
  model: CascadeModel;
  analysis: AnalysisResult;
  onJump: (id: string) => void;
}) {
  const accent = model.tiers.find((t) => t.id === row.tier)?.color;
  const warns = analysis.warnings.filter((w) => row.warnings.includes(w.code));
  const srcRange =
    row.changedInfo?.evidence.find((e) => e.newRange)?.newRange
      ? {
          startLine: row.changedInfo.evidence.find((e) => e.newRange)!.newRange!.start - 1,
          endLine: row.changedInfo.evidence.find((e) => e.newRange)!.newRange!.end - 1,
        }
      : row.line !== undefined
        ? { startLine: row.line - 1, endLine: row.line }
        : undefined;

  const summary = summaryFor(row);

  return (
    <div className="why" style={{ borderColor: accent }}>
      <div className="why-grid">
        <div className="why-col">
          <p className="why-title mono" style={{ color: accent }} data-testid="why-title">
            {whyTitle(row)}
          </p>
          <p className="why-summary">{summary}</p>

          {row.typeOnly && (
            <p className="why-note">Provably type-only — erased at runtime. No runtime propagation.</p>
          )}
          {row.changeKind === "renamed" && row.changedInfo?.renamedFrom && (
            <p className="why-note">
              Renamed from <Mono>{row.changedInfo.renamedFrom.file}::{row.changedInfo.renamedFrom.name}</Mono>
            </p>
          )}

          {row.paths.length > 0 && (
            <div>
              <p className="sec-label mono">
                EVIDENCE PATH
                {row.paths.length > 1 && (
                  <span className="sec-sub"> · {row.paths.length} causal roots</span>
                )}
              </p>
              {row.paths.map((p, i) => (
                <div key={p.rootId} className="pathwrap">
                  {row.paths.length > 1 && (
                    <p className="sec-sub mono">
                      via {p.rootLabel}
                    </p>
                  )}
                  <PathChain path={p} model={model} onJump={onJump} />
                </div>
              ))}
            </div>
          )}

          {row.incoming.length > 0 && (
            <div>
              <p className="sec-label mono">{row.incoming[0].rel.toUpperCase()} EVIDENCE</p>
              {row.incoming.map((inc, i) => (
                <div key={i} className="ev-card">
                  <div className="ev-card-head mono">
                    <Mono className="ev-from">{inc.label}</Mono>
                    <span className="ev-rel">{(REL_META[inc.rel]?.label ?? inc.rel)}</span>
                  </div>
                  {inc.evidence.map((g, j) => (
                    <EvidenceLine key={j} g={g} />
                  ))}
                </div>
              ))}
            </div>
          )}

          {row.tier === "references" && row.parent && (
            <p className="why-note">
              Connected by <Mono>{row.parent.rel}</Mono> to <Mono>{row.parent.label}</Mono> — no call,
              type-position, or JSX usage proves impact reaches this symbol.
            </p>
          )}

          {row.tier === "tests" && row.testVia && (
            <div>
              <p className="sec-label mono">CONNECTED SYMBOLS</p>
              <ul className="testvia">
                {row.testVia.map((v, i) => (
                  <li key={i} className="mono">
                    <span className="tst-glyph">⬚</span> {v.symbol}
                    <span className="sec-sub"> · {v.edgeKind}</span>
                  </li>
                ))}
              </ul>
              <p className="why-note">
                Deterministically linked only — Ripple does not claim coverage completeness.
              </p>
            </div>
          )}

          {row.deletedInfo && row.deletedInfo.formerCallers.length > 0 && (
            <div>
              <p className="sec-label mono">FORMER CALLERS (base revision)</p>
              <ul className="testvia">
                {row.deletedInfo.formerCallers.map((c) => (
                  <li key={c.id} className="mono">
                    <span className="del-glyph">⇥</span> {c.name}
                    <span className="sec-sub"> · {c.file}</span>
                  </li>
                ))}
              </ul>
              <p className="why-note">
                Reconstructed from the base revision — these call sites will not resolve.
              </p>
            </div>
          )}
        </div>

        <div className="why-col">
          {row.changedInfo && <DiffBlock c={row.changedInfo} a={analysis} />}
          {srcRange && <CodePreview file={row.file} range={srcRange} accent={accent} />}
          {warns.map((w) => (
            <UncertaintyCard key={w.code} w={w} />
          ))}
        </div>
      </div>
    </div>
  );
}

function summaryFor(r: CascadeRow): string {
  switch (r.tier) {
    case "changed":
      return r.changeKind === "added"
        ? `New symbol ${r.label} — introduced in the working tree at ${r.file}${fmtLines(r.changedInfo?.evidence.find((e) => e.newRange)?.newRange && { startLine: r.changedInfo.evidence.find((e) => e.newRange)!.newRange!.start - 1, endLine: r.changedInfo.evidence.find((e) => e.newRange)!.newRange!.end - 1 })}.`
        : `Modified in the working tree at ${r.file}. Downstream entries below are reached through evidence-backed edges.`;
    case "deleted":
      return `Present at base revision, absent in the working tree. ${r.deletedInfo?.formerCallers.length ?? 0} former caller(s) reconstructed from the base graph.`;
    case "type":
      return `Consumes a changed type contract — compile-time impact only, via type_depends evidence.`;
    case "tests":
      return `Deterministically connected to changed/affected symbols.`;
    case "references":
      return `Related to an affected symbol, but no evidence proves impact reaches it.`;
    default:
      return `Reached from a changed root through ${r.paths[0]?.edges.map((e) => e.rel).join(" → ") ?? "impact"} evidence.`;
  }
}
