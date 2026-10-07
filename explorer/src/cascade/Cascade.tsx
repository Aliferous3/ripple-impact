import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisResult } from "../types";
import {
  REL_META,
  TIER_GLYPH,
  buildCascade,
  type CascadeModel,
  type CascadeRow,
} from "./model";
import { FileRef, Mono, WarnChip } from "./ui";
import { WhyBlock } from "./WhyBlock";

export interface CascadeProps {
  analysis: AnalysisResult;
  analyzing: boolean;
  /** Latest live error — previous valid result stays on screen. */
  liveError?: string;
  /** Bumped on each authoritative analysis — replays the unfold. */
  runId: number;
  reduced: boolean;
}

const DEPTH_STOPS = [1, 2, 3, 4] as const;

export function Cascade({ analysis, analyzing, liveError, runId, reduced }: CascadeProps) {
  const model = useMemo(() => buildCascade(analysis), [analysis]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [depth, setDepth] = useState<number>(Infinity);
  const [showRefs, setShowRefs] = useState(false);
  const [openClusters, setOpenClusters] = useState<Record<string, boolean>>({});
  const docRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Deep link: #n=<row id> opens that row's WHY and scrolls to it.
  useEffect(() => {
    const id = new URLSearchParams(location.hash.slice(1)).get("n");
    if (!id || !model.byId.has(id)) return;
    setOpen((o) => ({ ...o, [id]: true }));
    setSelected(id);
    requestAnimationFrame(() => {
      docRef.current
        ?.querySelector(`[data-row="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "center" });
    });
  }, [model]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === "Escape") {
        if (query) setQuery("");
        else {
          setOpen({});
          setSelected(undefined);
          history.replaceState(null, "", location.pathname);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query]);

  const needle = query.trim().toLowerCase();
  const matches = (r: CascadeRow) =>
    !needle || r.label.toLowerCase().includes(needle) || r.file.toLowerCase().includes(needle);
  const withinDepth = (r: CascadeRow) =>
    r.tier === "direct" || r.tier === "transitive" || r.tier === "type"
      ? r.depth <= depth
      : true;

  const hasTestScopeWarning = analysis.warnings.some(
    (w) => w.code === "TEST_FILES_OUTSIDE_INDEX_SCOPE",
  );
  const tiers = model.tiers
    .map((t) => ({ ...t, rows: t.rows.filter((r) => matches(r) && withinDepth(r)) }))
    .filter(
      (t) =>
        t.rows.length > 0 ||
        t.id === "references" ||
        (t.id === "tests" && hasTestScopeWarning),
    );
  const visibleRows = tiers.reduce((n, t) => n + t.rows.length, 0);

  const toggle = (id: string) => {
    const opening = !open[id];
    setOpen((o) => ({ ...o, [id]: !o[id] }));
    setSelected(id);
    history.replaceState(
      null,
      "",
      opening ? `#n=${encodeURIComponent(id)}` : location.pathname,
    );
  };

  const scrollToTier = (id: string) => {
    docRef.current?.querySelector(`#tier-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const selRow = selected ? model.byId.get(selected) : undefined;
  const empty = model.tiers.every((t) => t.rows.length === 0);
  const large = model.clusters !== null;

  return (
    <div className="cascade">
      {/* ── left: tier index ─────────────────────────────────── */}
      <nav className="rail" aria-label="cascade tiers">
        <p className="rail-brand mono">CASCADE</p>
        <p className="rail-repo mono">
          {model.meta.repoName}
          <br />
          {model.meta.oldRev.slice(0, 10)} → {model.meta.newRev}
        </p>

        <div className="rail-tiers">
          {model.tiers.map((t) => {
            const count = t.rows.filter((r) => matches(r) && withinDepth(r)).length;
            if (!count && t.id !== "references" && !(t.id === "tests" && hasTestScopeWarning))
              return null;
            return (
              <a
                key={t.id}
                href={`#tier-${t.id}`}
                className="rail-tier"
                data-testid={`rail-${t.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  scrollToTier(t.id);
                }}
              >
                <span className="rail-mark" style={{ background: t.color }} />
                <span className="rail-label">{t.label}</span>
                <span className="rail-count tabnum">{count}</span>
              </a>
            );
          })}
        </div>

        <div className="rail-sec">
          <p className="rail-sec-label mono">UNFOLD DEPTH</p>
          <div className="depth-row">
            {DEPTH_STOPS.map((d) => (
              <button
                key={d}
                data-testid={`depth-${d}`}
                className={`depth-btn mono ${depth === d ? "on" : ""}`}
                onClick={() => setDepth(d)}
              >
                {d}
              </button>
            ))}
            <button
              data-testid="depth-all"
              className={`depth-btn mono ${depth === Infinity ? "on" : ""}`}
              onClick={() => setDepth(Infinity)}
            >
              all
            </button>
          </div>
        </div>

        {analysis.warnings.length > 0 && (
          <div className="rail-sec">
            <p className="rail-sec-label mono">WARNINGS</p>
            <div className="rail-warns">
              {analysis.warnings.map((w, i) => (
                <WarnChip key={`${w.code}-${i}`} code={w.code} title={w.message} />
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* ── center: cascade document ─────────────────────────── */}
      <div className="doc-scroll" ref={docRef}>
        <div className="filterbar">
          <div className="filterbox">
            <span className="filter-glyph" aria-hidden>⌕</span>
            <input
              ref={filterRef}
              data-testid="filter-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter the cascade — symbol or path"
              className="mono"
            />
            {query && (
              <button className="filter-clear mono" onClick={() => setQuery("")}>clear</button>
            )}
          </div>
          <span className="filter-count mono tabnum" data-testid="filter-count">
            {visibleRows} rows · {tiers.filter((t) => t.rows.length).length} tiers
          </span>
          {analyzing && <span className="analyzing mono" data-testid="analyzing">analyzing…</span>}
          {liveError && (
            <span className="live-error mono" data-testid="live-error" title={liveError}>
              analysis failed — showing previous valid result
            </span>
          )}
          <button className="collapse-btn mono" data-testid="collapse-all" onClick={() => setOpen({})}>
            collapse all
          </button>
        </div>

        {empty ? (
          <div className="cascade-empty">
            <div className="empty-rings" aria-hidden>
              <span /><span /><span />
            </div>
            <p className="empty-title">Nothing to unfold</p>
            <p className="empty-body">
              The cascade begins at a changed symbol. There are none in the working tree.
            </p>
          </div>
        ) : large ? (
          <LargeCascade
            model={model}
            open={openClusters}
            setOpen={setOpenClusters}
            openWhy={open}
            onToggleRow={toggle}
            analysis={analysis}
            runId={runId}
            reduced={reduced}
          />
        ) : (
          <div className="doc" key={runId}>
            {tiers.map((t, ti) => (
              <section key={t.id} id={`tier-${t.id}`} className="tier" data-testid={`tier-${t.id}`}>
                <div className="tier-head">
                  <span className="tier-label mono" style={{ color: t.color }}>{t.label}</span>
                  <span className="tier-count mono tabnum">{t.rows.length}</span>
                  <span className="tier-note">{t.note}</span>
                  <span className="tier-rule" style={{ background: `${t.color}22` }} />
                </div>
                {ti > 0 && <div className="tier-connector" aria-hidden />}

                {t.id === "references" && !showRefs ? (
                  <button
                    className="refs-collapsed mono"
                    data-testid="refs-show"
                    onClick={() => setShowRefs(true)}
                  >
                    <span className="branch">└──</span> {t.rows.length} related symbol
                    {t.rows.length === 1 ? "" : "s"} — impact not proven
                    <span className="refs-show">show</span>
                  </button>
                ) : (
                  <ul className="rows">
                    {t.rows.map((r, i) => (
                      <Row
                        key={r.id}
                        row={r}
                        last={i === t.rows.length - 1}
                        index={i}
                        open={!!open[r.id]}
                        onToggle={toggle}
                        model={model}
                        analysis={analysis}
                        animate={!reduced && runId > 1}
                      />
                    ))}
                    {t.id === "references" && showRefs && (
                      <li>
                        <button className="refs-collapsed mono" onClick={() => setShowRefs(false)}>
                          <span className="branch">└──</span> hide references
                        </button>
                      </li>
                    )}
                  </ul>
                )}

                {t.id === "tests" &&
                  analysis.warnings.some((w) => w.code === "TEST_FILES_OUTSIDE_INDEX_SCOPE") && (
                    <p className="testscope-note" data-testid="testscope-note">
                      △ test files exist outside the indexed scope — relevant-test analysis may be
                      incomplete. Empty here does not mean no potentially relevant tests exist.
                    </p>
                  )}

                {ti < tiers.length - 1 && <div className="tier-arrow" aria-hidden>↓</div>}
              </section>
            ))}

            <footer className="doc-footer mono">
              Cascade produced by ripple in {model.meta.totalMs} ms · {model.meta.newRev} ·
              local only
            </footer>
          </div>
        )}
      </div>

      {/* ── right: current focus (ultrawide only) ────────────── */}
      {selRow && (
        <aside className="focus-panel" data-testid="focus-panel">
          <p className="rail-sec-label mono">CURRENT FOCUS</p>
          <Mono className="focus-name">{selRow.label}</Mono>
          <FileRef file={selRow.file} line={selRow.line} className="focus-file" />
          <div className="focus-path">
            {(selRow.paths[0]?.steps ?? [{ id: selRow.id, label: selRow.label, file: selRow.file }]).map(
              (s, i) => (
                <div key={`${s.id}-${i}`} className="focus-step">
                  <span className="focus-depth mono">{i === 0 ? "src" : `+${i}`}</span>
                  <span className="focus-glyph" style={{ color: model.tiers.find((t) => t.id === selRow.tier)?.color }}>
                    {TIER_GLYPH[selRow.tier]}
                  </span>
                  <Mono className="focus-label">{s.label}</Mono>
                </div>
              ),
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function Row({
  row,
  last,
  index,
  open,
  onToggle,
  model,
  analysis,
  animate,
}: {
  row: CascadeRow;
  last: boolean;
  index: number;
  open: boolean;
  onToggle: (id: string) => void;
  model: CascadeModel;
  analysis: AnalysisResult;
  animate: boolean;
}) {
  const branch = last ? "└──" : "├──";
  const meta = model.tiers.find((t) => t.id === row.tier)!;
  return (
    <li
      className={`row ${animate ? "rp-arrive" : ""}`}
      style={animate ? { animationDelay: `${Math.min(row.depth, 8) * 120 + index * 45}ms` } : undefined}
      data-testid={`row-${row.tier}`}
      data-row={row.id}
    >
      <button
        className={`row-btn ${open ? "open" : ""}`}
        data-testid="cascade-row"
        aria-expanded={open}
        onClick={() => onToggle(row.id)}
      >
        <span className="branch mono" aria-hidden>{branch}</span>
        <span className="glyph" style={{ borderColor: `${meta.color}80`, color: meta.color, background: `${meta.color}1f` }}>
          {TIER_GLYPH[row.tier]}
        </span>
        <span className="row-main">
          <span className="row-head">
            <Mono className="row-label">{row.label}</Mono>
            <FileRef file={row.file} line={row.line} className="row-file" />
            {row.changeKind === "deleted" && <span className="row-flag mono">removed</span>}
            {row.typeOnly && <span className="row-flag mono ty">type-only</span>}
            {row.warnings.map((w) => (
              <span key={w} className="row-warn mono">△ {w}</span>
            ))}
          </span>
          {row.parent && (
            <span className="row-parent mono">
              <span className="row-parent-name" style={{ color: meta.color }}>{row.parent.label}</span>
              <span className="row-parent-rel">
                {" "}{(REL_META[row.parent.rel]?.arrow ?? "→")} {row.parent.rel}
              </span>
              {row.parent.line !== undefined && (
                <span className="row-parent-at"> · L{row.parent.line}</span>
              )}
              {row.roots.length > 1 && (
                <span className="row-roots"> · {row.roots.length} causal roots</span>
              )}
            </span>
          )}
        </span>
        <span className="row-right">
          {row.confidence && row.confidence !== "certain" && (
            <span className={`conf conf-${row.confidence} mono`}>{row.confidence}</span>
          )}
          <span className="row-why mono">
            {row.depth !== Number.MAX_SAFE_INTEGER ? `depth ${row.depth} · ` : ""}
            {open ? "hide why" : "why ▸"}
          </span>
        </span>
      </button>
      {open && <WhyBlock row={row} model={model} analysis={analysis} onJump={onToggle} />}
    </li>
  );
}

/** Large-impact surface — deterministic rollup by path bucket. */
function LargeCascade({
  model,
  open,
  setOpen,
  openWhy,
  onToggleRow,
  analysis,
  runId,
  reduced,
}: {
  model: CascadeModel;
  open: Record<string, boolean>;
  setOpen: (f: (o: Record<string, boolean>) => Record<string, boolean>) => void;
  openWhy: Record<string, boolean>;
  onToggleRow: (id: string) => void;
  analysis: AnalysisResult;
  runId: number;
  reduced: boolean;
}) {
  const clusters = model.clusters!;
  return (
    <div className="doc">
      <p className="large-note mono" data-testid="large-note">
        {model.impactRows} AFFECTED SYMBOLS — CASCADE ROLLED UP BY SUBSYSTEM.
        EXPAND A GROUP TO UNFOLD ITS ROWS.
      </p>
      <ul className="rows">
        {clusters.map((c, i) => (
          <li key={c.path}>
            <button
              className="cluster-btn"
              data-testid="cluster"
              aria-expanded={!!open[c.path]}
              onClick={() => setOpen((o) => ({ ...o, [c.path]: !o[c.path] }))}
            >
              <span className="branch mono">{i === clusters.length - 1 ? "└──" : "├──"}</span>
              <Mono className="cluster-path">{c.path}</Mono>
              <span className="cluster-bar" aria-hidden>
                <span style={{ width: `${(c.runtime / c.total) * 100}%`, background: "#52b8e8" }} />
                <span style={{ width: `${(c.type / c.total) * 100}%`, background: "#a98bf0" }} />
                <span style={{ width: `${(c.tests / c.total) * 100}%`, background: "#4fc3a1" }} />
                <span style={{ width: `${(c.refs / c.total) * 100}%`, background: "#37414f" }} />
              </span>
              <span className="cluster-total mono tabnum">{c.total} symbols</span>
              <span className="cluster-depth mono">d≤{c.maxDepth}</span>
              {c.warn > 0 && <span className="row-warn mono">△{c.warn}</span>}
            </button>
            {open[c.path] && (
              <ul className="rows cluster-rows">
                {c.rowIds
                  .map((id) => model.byId.get(id)!)
                  .sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label))
                  .map((r, j) => (
                    <Row
                      key={r.id}
                      row={r}
                      last={j === c.rowIds.length - 1}
                      index={j}
                      open={!!openWhy[r.id]}
                      onToggle={onToggleRow}
                      model={model}
                      analysis={analysis}
                      animate={!reduced && runId > 1}
                    />
                  ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
