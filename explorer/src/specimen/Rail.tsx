import { useEffect, useRef, useState } from "react";
import type { AnalysisResult } from "../types.js";
import type { Specimen } from "./model.js";
import { DEPTH_ORDER, en } from "./lib/motion.js";

interface Props {
  animating: boolean;
  list: Specimen[];
  all: Specimen[];
  selectedId: string | undefined;
  prevSelectedId: string | null;
  onSelect: (s: Specimen) => void;
  query: string;
  onQuery: (q: string) => void;
  warnings: AnalysisResult["warnings"];
  clusters: { path: string; total: number; plateIds: string[] }[] | null;
  resolveTick: number;
  propTick: number;
  reduced: boolean;
  /** Mobile drawer state — rail is off-canvas below 768px unless open. */
  open: boolean;
  onClose: () => void;
}

/** Deterministic one-line explanation for each warning code the engine emits. */
export function warningBlurb(code: string): string {
  switch (code) {
    case "TEST_FILES_OUTSIDE_INDEX_SCOPE":
      return "test files exist outside the indexed scope — relevant-test analysis may be incomplete";
    case "CALLBACK_FLOW_UNKNOWN":
      return "a callback could not be followed — impact may be under-reported";
    case "NOT_INDEXED":
      return "a file could not be indexed — its symbols are absent from the graph";
    case "BINARY_SKIPPED":
      return "a binary file in the diff was skipped";
    case "BASE_GRAPH_UNAVAILABLE":
      return "the base-revision graph could not be built — deletion evidence may be missing";
    case "DELETED_SYMBOL_APPROXIMATED":
      return "a deleted symbol was approximated — former callers may be incomplete";
    case "AMBIGUOUS_SYMBOL":
      return "a selector matched multiple symbols — none was silently chosen";
    default:
      return "see warning detail";
  }
}

export default function Rail({
  animating,
  list,
  all,
  selectedId,
  prevSelectedId,
  onSelect,
  query,
  onQuery,
  warnings,
  clusters,
  resolveTick,
  propTick,
  reduced,
  open,
  onClose,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  const [openWarning, setOpenWarning] = useState<string | null>(null);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(selectedId ?? "")}"]`);
    if (el && el.parentElement) {
      const parent = el.parentElement;
      const target = el.offsetTop - parent.clientHeight / 2 + el.clientHeight / 2;
      parent.scrollTo({ top: Math.max(0, target), behavior: reduced ? "auto" : "smooth" });
    }
  }, [selectedId, reduced]);

  /* Cluster headers for the large-surface rail: map plate id → cluster path. */
  const clusterOf = new Map<string, string>();
  if (clusters)
    for (const c of clusters) for (const id of c.plateIds) clusterOf.set(id, c.path);

  let lastCluster: string | undefined;
  const items: ({ kind: "cluster"; path: string; total: number } | { kind: "plate"; s: Specimen; i: number })[] = [];
  list.forEach((s, i) => {
    const cp = clusterOf.get(s.id);
    if (cp && cp !== lastCluster) {
      items.push({ kind: "cluster", path: cp, total: clusters!.find((c) => c.path === cp)!.total });
      lastCluster = cp;
    }
    if (!cp) lastCluster = undefined;
    items.push({ kind: "plate", s, i });
  });

  return (
    <aside className={`rail ${open ? "open" : ""}`} aria-label="Specimen navigation">
      <div {...en(animating, 140, 460)} className="rail-head">
        <div className="rail-head-row">
          <span className="label rail-label">SPECIMEN</span>
          <span className="mono tnum rail-count">{`${all.length} plates`}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close specimen list"
            className="link-shift rail-close"
            data-testid="rail-close"
          >
            ×
          </button>
        </div>

        <div className="rail-search">
          <span className="rail-search-icon" aria-hidden>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <circle cx="5.4" cy="5.4" r="3.9" stroke="#f75001" strokeWidth="1.1" />
              <path d="M8.4 8.4L11.4 11.4" stroke="#f75001" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </span>
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="find a specimen"
            aria-label="Find a specimen"
            className="link-shift rail-search-input"
            data-testid="rail-search"
          />
          <span className="rail-search-esc" aria-hidden>
            <span className="mono rail-search-esc-in">ESC</span>
          </span>
        </div>
      </div>

      <div ref={listRef} className="scroll-thin rail-list" key={resolveTick}>
        {list.length === 0 ? (
          all.length === 0 ? null : (
            <div className="rail-nomatch">
              <p className="label">NO MATCH</p>
              <p className="mono rail-nomatch-sub">
                nothing in this index answers to “{query}”
              </p>
            </div>
          )
        ) : (
          items.map((it) => {
            if (it.kind === "cluster")
              return (
                <div key={`cl-${it.path}`} className="rail-cluster mono">
                  {it.path} <span className="rail-cluster-n">{it.total}</span>
                </div>
              );
            const { s, i } = it;
            const selected = s.id === selectedId;
            const wasSelected = s.id === prevSelectedId;
            const order = DEPTH_ORDER[s.impactKey] ?? 3;
            const rd = 60 + order * 165 + i * 24;
            return (
              <div
                key={s.id}
                data-id={s.id}
                className={`rail-pop rail-item ${selected ? "selected" : ""}`}
                style={{ ["--rd" as string]: `${reduced ? 0 : rd}ms` }}
              >
                {selected && <span key={`bar-${s.id}`} className="rail-bar" aria-hidden />}
                {wasSelected && !selected && (
                  <span className="rail-bar rail-bar-out" aria-hidden />
                )}
                {selected && <span className="rail-item-wash" aria-hidden />}

                <button
                  type="button"
                  onClick={() => onSelect(s)}
                  aria-current={selected ? "true" : undefined}
                  className="link-shift rail-btn"
                  data-testid="rail-plate"
                >
                  <span className={`mono tnum rail-num ${selected ? "selected" : ""}`}>{s.num}</span>

                  <span className="rail-name-wrap">
                    <span className={`rail-name ${selected ? "selected" : ""}`}>{s.name}</span>
                    <span
                      className={`label rail-cat ${selected ? "selected" : ""}`}
                      style={{ ["--fd" as string]: `${reduced ? 0 : 120 + order * 165 + i * 24}ms` }}
                    >
                      {s.impact}
                    </span>
                  </span>

                  {s.warning && (
                    <span className="rail-warn" title="Unproven edge in this specimen" aria-label="Warning">
                      <svg width="11" height="10" viewBox="0 0 11 10" fill="none">
                        <path d="M5.5 0.7L10.4 9.3H0.6L5.5 0.7Z" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" />
                        <path d="M5.5 3.6V6" stroke="currentColor" strokeWidth="0.9" />
                        <circle cx="5.5" cy="7.3" r="0.55" fill="currentColor" />
                      </svg>
                    </span>
                  )}

                  {propTick > 0 && !reduced && (
                    <span
                      className="rail-prop-sweep"
                      style={{ animationDelay: `${120 + order * 200 + i * 24}ms` }}
                      aria-hidden
                    />
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* warnings shelf — real structured warnings with real messages */}
      {warnings.length > 0 && (
        <div {...en(animating, 560, 520)} className="rail-warnings">
          <span className="rail-warnings-rule" aria-hidden />
          <div className="rail-warnings-head">
            <span className="label">WARNINGS</span>
            <span className="mono tnum rail-warnings-n">{warnings.length}</span>
          </div>
          <div className="rail-warnings-chips">
            {warnings.map((w, i) => (
              <button
                key={`${w.code}-${i}`}
                type="button"
                title={w.message}
                onClick={() => setOpenWarning(openWarning === `${w.code}-${i}` ? null : `${w.code}-${i}`)}
                aria-expanded={openWarning === `${w.code}-${i}`}
                className={`link-shift chip-wash rail-warnc ${openWarning === `${w.code}-${i}` ? "open" : ""}`}
                style={{ animationDelay: `${640 + i * 90}ms` }}
                data-testid="warning-chip"
              >
                <svg width="9" height="8" viewBox="0 0 11 10" fill="none" aria-hidden>
                  <path d="M5.5 0.7L10.4 9.3H0.6L5.5 0.7Z" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" />
                  <path d="M5.5 3.6V6" stroke="currentColor" strokeWidth="0.9" />
                </svg>
                <span className="mono rail-warnc-code">{w.code}</span>
              </button>
            ))}
          </div>
          {warnings.map((w, i) =>
            openWarning === `${w.code}-${i}` ? (
              <div key={`wd-${i}`} className="rail-warnd" data-testid="warning-detail">
                <p className="mono rail-warnd-msg">{w.message}</p>
                <p className="mono rail-warnd-blurb">{warningBlurb(w.code)}</p>
                {w.files && w.files.length > 0 && (
                  <ul className="mono rail-warnd-files">
                    {w.files.slice(0, 5).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                    {w.files.length > 5 && <li>…+{w.files.length - 5} more</li>}
                  </ul>
                )}
              </div>
            ) : null,
          )}
          <div className="rail-warnings-foot">
            <span className="mono rail-warnings-hint">click a chip for what could not be proven</span>
            <span className="mono rail-warnings-sig">SIGNAL RED</span>
          </div>
        </div>
      )}
    </aside>
  );
}
