import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSource } from "../api.js";
import type { AnalysisResult, SourcePreview } from "../types.js";
import { highlight } from "./lib/highlight.jsx";
import { en } from "./lib/motion.js";
import ClassMark from "./ClassMark.jsx";
import { whyTitle, type EvidenceGroup, type RootPath, type Specimen, type SpecimenModel } from "./model.js";

interface Props {
  specimen: Specimen;
  model: SpecimenModel;
  analysis: AnalysisResult;
  animating: boolean;
  plateKey: number;
  dir: "next" | "prev";
  analysisKey: number;
  whyOpen: boolean;
  onWhyToggle: () => void;
  failed: boolean;
  reduced: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (id: string) => void;
}

const META_CELLS: { key: string; value: (s: Specimen, m: SpecimenModel) => string; verm?: boolean }[] = [
  { key: "FILE", value: (s) => s.file },
  { key: "RANGE", value: (s) => s.range, verm: true },
  { key: "DEPTH", value: (s) => s.depth, verm: true },
  { key: "EVIDENCE", value: (s) => s.confidence },
  { key: "SUBSYSTEM", value: (s) => s.subsystem },
  { key: "ROOTS", value: (s) => s.roots },
  { key: "EDGES", value: (s) => String(s.edges).padStart(2, "0") },
  { key: "STATUS", value: (s) => s.status, verm: true },
];

const ext = (f: string) => {
  const e = f.split(".").pop()?.toUpperCase() ?? "";
  return e === "TS" || e === "TSX" ? "TYPESCRIPT" : e === "JS" || e === "JSX" || e === "MJS" ? "JAVASCRIPT" : e || "TEXT";
};

export default function Plate({
  specimen: s,
  model,
  analysis,
  animating,
  plateKey,
  dir,
  analysisKey,
  whyOpen,
  onWhyToggle,
  failed,
  reduced,
  onPrev,
  onNext,
  onJump,
}: Props) {
  const codeRef = useRef<HTMLDivElement>(null);
  const titleChars = useMemo(() => s.name.split(""), [s.name]);
  const [src, setSrc] = useState<SourcePreview | undefined>();
  const [copied, setCopied] = useState(false);

  // real source through the safe-path endpoint only
  useEffect(() => {
    setSrc(undefined);
    if (!s.sourceRange) return;
    let live = true;
    void fetchSource(s.sourceFile, s.sourceRange.start, s.sourceRange.end)
      .then((r) => live && setSrc(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [s.sourceFile, s.sourceRange?.start, s.sourceRange?.end]);

  const codeText = useMemo(
    () => (src ? src.lines.map((l, i) => `${String(src.start + i).padStart(4, " ")}  ${l}`).join("\n") : ""),
    [src],
  );

  // source scrolls to the marked range on plate change / re-analysis
  useEffect(() => {
    const el = codeRef.current;
    if (!el || !src) return;
    el.scrollTop = 0;
    const idx = src.lines.findIndex((_, i) => s.markLines.includes(src.start + i));
    const target = idx < 0 ? 0 : Math.max(0, idx * 27 - 78);
    const id = window.setTimeout(
      () => el.scrollTo({ top: target, behavior: reduced ? "auto" : "smooth" }),
      reduced ? 0 : animating ? 900 : 320,
    );
    return () => window.clearTimeout(id);
  }, [plateKey, analysisKey, src, s.markLines, animating, reduced]);

  useEffect(() => setCopied(false), [s.id]);

  const handleCopy = () => {
    try {
      if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(codeText);
    } catch {
      /* clipboard unavailable — the confirmation still resolves */
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const lineBase = animating ? 640 : 130;
  const hopBase = animating ? 520 : 190;
  const metaLabelBase = animating ? 420 : 90;
  const metaValueBase = animating ? 484 : 150;

  const marked = (ln: number) => s.markLines.includes(ln);
  const minMark = s.markLines.length ? Math.min(...s.markLines) : undefined;
  const maxMark = s.markLines.length ? Math.max(...s.markLines) : undefined;

  return (
    <div className={`plate ${dir === "next" ? "plate-next" : "plate-prev"}`} key={`plate-${plateKey}`}>
      {/* impact-class label + title + mark */}
      <div className="plate-head">
        <div className="plate-head-flex">
          <div className="plate-head-main">
            <div {...en(animating, 210, 420)} className="plate-kicker">
              <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden className="plate-diamond">
                <path d="M5 0L10 5L5 10L0 5Z" fill="#f75001" />
              </svg>
              <span className="label plate-kicker-label" data-testid="plate-category">
                {s.impact}
              </span>
              <span className="plate-kicker-rule" />
            </div>

            {/* large symbol title — masked per-character reveal, then perfectly still */}
            <div className="plate-title-wrap">
              <span {...en(animating, 250, 420, "a-rule")} className="plate-title-rule" aria-hidden />
              <h1
                className="display title-veil plate-title"
                style={{ ["--cd" as string]: `${reduced ? 0 : 300}ms` }}
                data-testid="plate-title"
              >
                {titleChars.map((c, i) => (
                  <span
                    key={`${plateKey}-${i}`}
                    className="char"
                    style={{ ["--cd" as string]: `${reduced ? 0 : 306 + i * 19}ms` }}
                  >
                    {c}
                  </span>
                ))}
              </h1>
            </div>

            <div {...en(animating, 330, 420)} className="plate-loc">
              <span className="mono tnum plate-loc-range">{s.range}</span>
              <span className="plate-loc-dot">·</span>
              <span className="mono plate-loc-file">{s.file}</span>
              <span className="plate-loc-dot">·</span>
              <span className="mono tnum plate-loc-range">{s.depth}</span>
            </div>

            <p {...en(animating, 348, 480)} className="plate-desc">
              {s.description}
            </p>

            {/* OPEN WHY */}
            <div {...en(animating, 410, 460)} className="plate-why-ctrl">
              <button
                type="button"
                onClick={onWhyToggle}
                aria-expanded={whyOpen}
                className={`link-shift why-btn ${whyOpen ? "open" : ""}`}
                data-testid="why-toggle"
              >
                <span className="label">{whyOpen ? "CLOSE WHY" : "OPEN WHY"}</span>
                <span className="why-btn-arrow" aria-hidden>
                  {whyOpen ? "↓" : "→"}
                </span>
                <span
                  className="why-btn-underline"
                  style={{ transform: `scaleX(${whyOpen ? 1 : 0})` }}
                  aria-hidden
                />
              </button>
              <span className="mono plate-note">{s.note}</span>
            </div>

            {/* WHY body */}
            <div className={`why-body ${whyOpen ? "open" : ""} plate-why`} data-testid="why-body">
              <div className="why-inner">
                <WhyContent s={s} model={model} analysis={analysis} onJump={onJump} reduced={reduced} />
              </div>
            </div>
          </div>

          {/* class mark */}
          <div {...en(animating, 440, 520)} className="plate-mark">
            <ClassMark specimen={s} replayKey={`${s.id}-${plateKey}-${analysisKey}`} reduced={reduced} />
          </div>
        </div>

        {/* right-edge technical readout — real values only */}
        <div {...en(animating, 620, 520)} className="plate-readout" aria-hidden>
          {[
            `REV ${model.meta.oldRev.slice(0, 7).toUpperCase()}`,
            `${model.meta.totalMs} MS`,
            "LOCAL 127.0.0.1",
            s.confidence.toUpperCase(),
            `DEPTH ${s.depth}`,
          ].map((r) => (
            <div key={r} className="mono plate-readout-line">
              {r}
            </div>
          ))}
        </div>
      </div>

      {/* metadata grid — real cells only, no fabricated metrics */}
      <div {...en(animating, 424, 480)} className="plate-meta" key={`meta-${plateKey}-${analysisKey}`} data-testid="plate-meta">
        {META_CELLS.map((m, i) => (
          <div key={m.key} className="plate-meta-cell">
            <div
              className="anim a-fade-up"
              style={{
                animationName: "fade-up",
                animationDuration: "340ms",
                animationDelay: `${metaLabelBase + i * 16}ms`,
                animationTimingFunction: "cubic-bezier(.22,.7,.24,1)",
                animationFillMode: "both",
              }}
            >
              <span className="label-sm plate-meta-key">{m.key}</span>
            </div>
            <div
              className="anim a-fade-up plate-meta-valwrap"
              style={{
                animationName: "fade-up",
                animationDuration: "380ms",
                animationDelay: `${metaValueBase + i * 26}ms`,
                animationTimingFunction: "cubic-bezier(.22,.7,.24,1)",
                animationFillMode: "both",
              }}
            >
              <span className={`mono plate-meta-val ${m.verm ? "verm" : ""}`} title={m.value(s, model)}>
                {m.value(s, model)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* evidence path + source */}
      <div className="plate-cols">
        {/* EVIDENCE PATH */}
        <section key={`ev-${plateKey}-${analysisKey}`} className="plate-evidence">
          <div {...en(animating, 500, 420)} className="plate-sec-head">
            <span className="label plate-sec-label">EVIDENCE PATH</span>
            <span className="mono tnum plate-sec-n">{s.evidence.length} hops</span>
          </div>

          <div className="plate-hops">
            {s.evidence.map((hop, i) => {
              const last = i === s.evidence.length - 1;
              const rd = Math.min(hopBase + i * 100, hopBase + 620);
              return (
                <div key={`${hop.n}-${hop.name}`}>
                  <div className="rail-pop plate-hop" style={{ ["--rd" as string]: `${reduced ? 0 : rd}ms` }}>
                    <span className="mono tnum plate-hop-n">{hop.n}</span>
                    <span className={`plate-hop-name ${hop.root ? "root" : ""}`}>{hop.name}</span>
                    {hop.root && <span className="label plate-hop-root">ROOT</span>}
                  </div>

                  {!last && (
                    <div className="plate-hop-link">
                      <span
                        className="anim a-rule plate-hop-rule"
                        style={{
                          ["--delay" as string]: `${reduced ? 0 : rd + 60}ms`,
                          ["--d" as string]: "280ms",
                        }}
                        aria-hidden
                      />
                      <span className="rail-pop plate-hop-relwrap" style={{ ["--rd" as string]: `${reduced ? 0 : rd + 90}ms` }}>
                        <span className="plate-hop-arrow">↓</span>
                        <span className="label plate-hop-rel">{hop.rel}</span>
                        {hop.note && <span className="mono plate-hop-note">· {hop.note}</span>}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {s.extraPaths.length > 0 && (
            <p className="mono plate-roots-note">
              reached from {s.paths.length} causal roots — open WHY to inspect each
            </p>
          )}

          <p {...en(animating, hopBase + 620, 420)} className="mono plate-evidence-foot">
            {s.evidenceFoot}
          </p>
        </section>

        {/* SOURCE — real code via the safe-path API */}
        <section className="plate-source">
          <div {...en(animating, 500, 420)} className="plate-sec-head">
            <span className="label plate-sec-label">SOURCE</span>
            <span className="mono tnum plate-sec-n">
              {s.markLines.length ? `${s.markLines.length} marked` : "context"}
            </span>
          </div>

          <div key={`src-${plateKey}-${analysisKey}`} className="srcbox" data-testid="source-preview">
            <div className="srcbox-head">
              <span className="srcbox-dots" aria-hidden>
                <span className="srcbox-dot verm" />
                <span className="srcbox-dot" />
                <span className="srcbox-dot" />
              </span>
              <span className="mono srcbox-file">{s.sourceFile}</span>
              <button
                type="button"
                onClick={handleCopy}
                disabled={!src}
                className={`link-shift chip-wash srcbox-copy ${copied ? "copied" : ""}`}
              >
                <span className="label">{copied ? "COPIED" : "COPY"}</span>
              </button>
            </div>

            <div ref={codeRef} className="scroll-thin srcbox-body">
              <div className="srcbox-wash" aria-hidden />
              {src === undefined ? (
                <div className="mono srcbox-empty">
                  {s.sourceRange ? "loading…" : "no source range indexed for this symbol"}
                </div>
              ) : (
                src.lines.map((l, i) => {
                  const n = src.start + i;
                  const hot = marked(n);
                  return (
                    <div
                      key={n}
                      className={`code-line srcbox-line ${hot ? "hot" : ""}`}
                      style={{ ["--ld" as string]: `${reduced ? 0 : Math.min(lineBase + i * 24, lineBase + 380)}ms` }}
                    >
                      {hot && (
                        <>
                          <span
                            className="rail-bar srcbox-hotbar"
                            style={{
                              ["--d" as string]: "300ms",
                              ["--delay" as string]: `${reduced ? 0 : Math.min(lineBase + i * 24 + 220, lineBase + 620)}ms`,
                            }}
                            aria-hidden
                          />
                          <span
                            className="anim a-fade srcbox-hotwash"
                            style={{
                              ["--delay" as string]: `${reduced ? 0 : Math.min(lineBase + i * 24 + 320, lineBase + 700)}ms`,
                              ["--d" as string]: "520ms",
                            }}
                            aria-hidden
                          />
                        </>
                      )}
                      <span className={`mono tnum srcbox-no ${hot ? "hot" : ""}`}>{n}</span>
                      <span className={`mono srcbox-code ${hot ? "hot" : ""}`}>{highlight(l)}</span>
                    </div>
                  );
                })
              )}
            </div>

            <div className="srcbox-foot">
              <span className="mono tnum srcbox-foot-range">{s.range.replace("–", "-")}</span>
              <span className="mono srcbox-foot-meta">UTF-8 · LF · {ext(s.sourceFile)}</span>
              <span className={`mono srcbox-foot-status ${failed ? "failed" : ""}`}>
                <span className={`block-dot ${failed ? "" : "signal-core"}`} />
                {failed
                  ? "STALE — PREVIOUS RESULT"
                  : minMark !== undefined && maxMark !== undefined
                    ? `${s.markLines.length} MARKED · L${minMark}-L${maxMark}`
                    : "CONTEXT ONLY"}
              </span>
            </div>
          </div>
        </section>
      </div>

      {/* plate navigation */}
      <div {...en(animating, 572, 460)} className="plate-nav">
        <button type="button" onClick={onPrev} className="link-shift chip-wash plate-nav-btn" data-testid="prev-plate">
          <span className="plate-nav-arrow" aria-hidden>←</span>
          <span className="label">PREVIOUS PLATE</span>
        </button>
        <button type="button" onClick={onNext} className="link-shift chip-wash plate-nav-btn next" data-testid="next-plate">
          <span className="label">NEXT PLATE</span>
          <span className="plate-nav-arrow" aria-hidden>→</span>
        </button>
        <span className="mono plate-nav-hint">←→ to page · ENTER WHY · / FIND</span>
        <span className="mono plate-nav-status">{s.impact.toLowerCase()} · {s.subsystem} · {s.confidence}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* WHY body — per-category forensic expansion                           */
/* ------------------------------------------------------------------ */

function WhyContent({
  s,
  model,
  analysis,
  onJump,
  reduced,
}: {
  s: Specimen;
  model: SpecimenModel;
  analysis: AnalysisResult;
  onJump: (id: string) => void;
  reduced: boolean;
}) {
  const warns = analysis.warnings.filter((w) => s.warningCodes.includes(w.code));
  return (
    <>
      <div className="why-sec">
        <div className="why-head">
          <span className="label why-title" data-testid="why-title">{whyTitle(s)}</span>
          <span className="mono why-meta">
            {s.paths.length > 0
              ? `${s.paths.reduce((n, p) => n + p.edges.length, 0)} edges · ${s.confidence} · ${s.depth}`
              : `${s.confidence}`}
          </span>
        </div>
        <p className="why-summary">{s.description}</p>
      </div>

      {/* causal path — every root gets its own chain */}
      {s.paths.length > 0 && (
        <div className="why-sec">
          <div className="why-subhead">
            <span className="label why-sec-label">WHY · CAUSAL CHAIN</span>
            {s.paths.length > 1 && (
              <span className="mono why-sec-sub">{s.paths.length} causal roots</span>
            )}
          </div>
          {s.paths.map((p) => (
            <div key={p.rootId} className="why-pathwrap">
              {s.paths.length > 1 && <p className="mono why-via">via {p.rootLabel}</p>}
              <PathChain path={p} model={model} onJump={onJump} />
            </div>
          ))}
        </div>
      )}

      {/* incoming edge evidence — presentation-grouped, expandable */}
      {s.incoming.length > 0 && (
        <div className="why-sec">
          <span className="label why-sec-label">
            {s.incoming[0].rel.toUpperCase()} EVIDENCE
          </span>
          {s.incoming.map((inc, i) => (
            <div key={i} className="why-inc">
              <div className="mono why-inc-head">
                <span className="why-inc-from">{inc.label}</span>
                <span className="why-inc-rel">{inc.rel}</span>
              </div>
              {inc.evidence.map((g, j) => (
                <EvidenceLine key={j} g={g} />
              ))}
            </div>
          ))}
        </div>
      )}

      {/* deleted — former callers from the base graph */}
      {s.deletedInfo && s.deletedInfo.formerCallers.length > 0 && (
        <div className="why-sec">
          <span className="label why-sec-label">FORMER CALLERS (base revision)</span>
          <ul className="why-list mono">
            {s.deletedInfo.formerCallers.map((c) => (
              <li key={c.id}>
                <span className="why-del-glyph">⇥</span> {c.name}
                <span className="why-dim"> · {c.file}</span>
              </li>
            ))}
          </ul>
          <p className="why-note">
            Reconstructed from the base revision — these call sites will not resolve.
          </p>
        </div>
      )}

      {/* tests — deterministic link, not coverage */}
      {s.testVia && s.testVia.length > 0 && (
        <div className="why-sec">
          <span className="label why-sec-label">CONNECTED SYMBOLS</span>
          <ul className="why-list mono">
            {s.testVia.map((v, i) => (
              <li key={i}>
                <span className="why-del-glyph">⬚</span> {v.symbol}
                <span className="why-dim"> · {v.edgeKind}</span>
              </li>
            ))}
          </ul>
          <p className="why-note">
            Deterministically linked only — Ripple does not claim coverage completeness.
          </p>
        </div>
      )}

      {/* reference-only explanation */}
      {s.category === "reference" && (
        <p className="why-note">
          Related by <span className="mono">{s.refRel}</span> to an affected symbol — no call,
          type-position, or JSX usage proves impact reaches it.
        </p>
      )}

      {/* diffs — real hunks, removed red / added bright */}
      {s.diffs.length > 0 && (
        <div className="why-sec">
          {s.diffs.map((d, i) => (
            <div key={i} className="diffbox" data-testid="diff-preview">
              <div className="diffbox-head">
                <span className="label diffbox-label">SOURCE DIFF</span>
                <span className="mono tnum diffbox-add">+{d.added.length}</span>
                <span className="mono tnum diffbox-del">−{d.removed.length}</span>
                <span className="mono diffbox-file">{d.oldRange} → {d.newRange} · {d.file}</span>
              </div>
              <div className="scroll-thin diffbox-body mono">
                <div className="diffbox-hunk">@@ −{d.oldRange} +{d.newRange} @@</div>
                {d.removed.map((l, j) => (
                  <div key={`d${j}`} className="diffbox-line del">
                    <span className="diffbox-sign">−</span>
                    <code>{l}</code>
                  </div>
                ))}
                {d.added.map((l, j) => (
                  <div key={`a${j}`} className="diffbox-line add">
                    <span className="diffbox-sign">+</span>
                    <code>{l}</code>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* uncertainty — real warnings only */}
      {warns.length > 0 && (
        <div className="why-sec">
          <span className="label why-sec-label">WHY RIPPLE IS UNCERTAIN</span>
          {warns.map((w) => (
            <div key={w.code} className="warncard">
              <span className="mono warncard-code">△ {w.code}</span>
              {w.file && <span className="mono warncard-file">{w.file}</span>}
              <p className="warncard-msg">{w.message}</p>
            </div>
          ))}
        </div>
      )}

      <span style={{ display: reduced ? "none" : "none" }} aria-hidden />
    </>
  );
}

function EvidenceLine({ g }: { g: EvidenceGroup }) {
  return (
    <div className="why-ev">
      <div className="mono why-ev-head">
        <span className="why-inc-rel">{g.rel.toUpperCase()}</span>
        <span className="why-dim">
          {g.file}:{g.line}
        </span>
        {g.sites.length > 1 && <span className="why-ev-sites">{g.sites.length} sites</span>}
      </div>
      {g.sites.length > 1 && (
        <ul className="mono why-ev-sub">
          {g.sites.map((site, i) => (
            <li key={i}>
              {site.file}:{site.line} · {site.source}
              {site.detail ? ` · ${site.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PathChain({
  path,
  model,
  onJump,
}: {
  path: RootPath;
  model: SpecimenModel;
  onJump: (id: string) => void;
}) {
  return (
    <ol className="pathchain">
      {path.steps.map((step, i) => {
        const edge = i > 0 ? path.edges[i - 1] : undefined;
        const site = edge?.evidence[0];
        const plate = model.byId.get(step.id);
        return (
          <li key={`${step.id}-${i}`}>
            {edge && (
              <div className="pathchain-link mono">
                ↓ {edge.rel}
                {site && <span className="why-dim"> · {site.file.split("/").pop()}:{site.line}</span>}
                {edge.confidence && edge.confidence !== "certain" && (
                  <span className="pathchain-conf">· {edge.confidence.toUpperCase()}</span>
                )}
              </div>
            )}
            <button
              type="button"
              className={`pathchain-node mono ${plate ? "" : "off"}`}
              onClick={() => plate && onJump(step.id)}
              title={plate ? "open this plate" : "not a plate"}
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
