import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisResult } from "../types.js";
import Backdrop from "./Backdrop.jsx";
import Plate from "./Plate.jsx";
import Preloader from "./Preloader.jsx";
import Rail from "./Rail.jsx";
import TopBar, { type AnalysisState } from "./TopBar.jsx";
import { usePrefersReducedMotion } from "./lib/hooks.js";
import { en } from "./lib/motion.js";
import { buildSpecimen, type Specimen, type SpecimenModel } from "./model.js";

type Stage = "preload" | "entering" | "live";
type Strip = "none" | "in" | "out";

interface Props {
  analysis: AnalysisResult;
  analyzing: boolean;
  liveError?: string;
  watching: boolean;
  /** Bumped per authoritative result — replays plate/entrance motion. */
  runId: number;
  /** Refetch the server's latest result (the watcher drives real re-analysis). */
  onRefresh: () => void;
}

export default function SpecimenApp({
  analysis,
  analyzing,
  liveError,
  watching,
  runId,
  onRefresh,
}: Props) {
  const reduced = usePrefersReducedMotion();
  const [stage, setStage] = useState<Stage>("preload");
  const [showPre, setShowPre] = useState(true);
  const [preExiting, setPreExiting] = useState(false);

  const model: SpecimenModel = useMemo(() => buildSpecimen(analysis), [analysis]);
  const empty = model.plates.length === 0;

  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [prevSelectedId, setPrevSelectedId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("ALL");
  const [plateKey, setPlateKey] = useState(0);
  const [dir, setDir] = useState<"next" | "prev">("next");
  const [analysisKey, setAnalysisKey] = useState(0);
  const [whyOpen, setWhyOpen] = useState(false);
  const [state, setState] = useState<AnalysisState>("idle");
  const [strip, setStrip] = useState<Strip>("none");
  const [propTick, setPropTick] = useState(0);
  const [resolveTick, setResolveTick] = useState(0);
  const [fieldKey, setFieldKey] = useState(0);
  const [enterKey, setEnterKey] = useState(0);

  /* Two independent timer lanes: boot choreography must survive live-state
     effects (a `hello.error` during boot would otherwise cancel the exit). */
  const bootTimersRef = useRef<number[]>([]);
  const fxTimersRef = useRef<number[]>([]);
  const clearFxTimers = useCallback(() => {
    fxTimersRef.current.forEach((t) => window.clearTimeout(t));
    fxTimersRef.current = [];
  }, []);
  const pushTimer = useCallback((fn: () => void, ms: number) => {
    fxTimersRef.current.push(window.setTimeout(fn, ms));
  }, []);
  useEffect(
    () => () => {
      bootTimersRef.current.forEach((t) => window.clearTimeout(t));
      clearFxTimers();
    },
    [clearFxTimers],
  );

  /* ---------------- boot / preloader ----------------
     The preloader is entrance choreography — it exits only once the first
     real analysis has mounted (SpecimenApp renders only after data). */
  useEffect(() => {
    if (reduced) {
      const t1 = window.setTimeout(() => setStage("entering"), 90);
      const t2 = window.setTimeout(() => {
        setStage("live");
        setPreExiting(true);
      }, 260);
      const t3 = window.setTimeout(() => setShowPre(false), 560);
      bootTimersRef.current.push(t1, t2, t3);
      return;
    }
    const t1 = window.setTimeout(() => {
      setStage("entering");
      setPreExiting(true);
    }, 1250);
    const t2 = window.setTimeout(() => setStage("live"), 2020);
    const t3 = window.setTimeout(() => setShowPre(false), 1840);
    bootTimersRef.current.push(t1, t2, t3);
  }, [reduced]);

  /* ---------------- live analysis state ----------------
     Real SSE drives this: analyzing on started, complete→idle on result,
     failed+strip on error — previous plate stays mounted throughout. */
  const lastRunId = useRef(runId);
  useEffect(() => {
    if (runId === lastRunId.current) return;
    lastRunId.current = runId;
    // Authoritative result landed.
    setStrip((st) => (st === "in" ? "out" : "none"));
    setState("complete");
    setAnalysisKey((k) => k + 1);
    setPropTick((t) => t + 1);
    setResolveTick((t) => t + 1);
    setFieldKey((k) => k + 1);
    pushTimer(() => setStrip("none"), reduced ? 240 : 400);
    pushTimer(() => setState((st) => (st === "failed" ? st : "idle")), reduced ? 500 : 1600);
  }, [runId, reduced, pushTimer]);

  useEffect(() => {
    if (analyzing) setState("analyzing");
  }, [analyzing]);

  useEffect(() => {
    if (liveError === undefined) return;
    clearFxTimers();
    setState("failed");
    setStrip("in");
  }, [liveError, clearFxTimers]);

  /* ---------------- filtering ---------------- */
  const tabs = useMemo(() => {
    const seen = new Set<string>();
    for (const p of model.plates) seen.add(p.impact);
    return ["ALL", ...seen];
  }, [model.plates]);

  useEffect(() => {
    if (!tabs.includes(tab)) setTab("ALL");
  }, [tabs, tab]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return model.plates.filter(
      (s) =>
        (tab === "ALL" || s.impact === tab) &&
        (!q ||
          s.name.toLowerCase().includes(q) ||
          s.file.toLowerCase().includes(q) ||
          s.impact.toLowerCase().includes(q) ||
          s.subsystem.toLowerCase().includes(q)),
    );
  }, [model.plates, query, tab]);

  /* Selection — deterministic: keep the same plate across re-analysis when
     it still exists; otherwise fall back to the first plate. Never picks an
     arbitrary ambiguous symbol — ids are stable symbol ids. */
  const specimen = useMemo(() => {
    const cur = selectedId ? model.byId.get(selectedId) : undefined;
    return cur ?? model.plates[0];
  }, [selectedId, model]);
  const selectedIndex = model.plates.findIndex((p) => p.id === specimen?.id);

  /* Sanitized one-line error summary — first line of the engine message,
     clamped, so stack traces never reach the UI. */
  const errorLine = useMemo(() => {
    if (!liveError) return undefined;
    const line = liveError.split("\n")[0]?.trim() ?? "";
    return line ? line.slice(0, 180) : undefined;
  }, [liveError]);

  const goPlate = useCallback(
    (id: string | undefined, newDir: "next" | "prev") => {
      if (!id || id === specimen?.id) return;
      setPrevSelectedId(specimen?.id ?? null);
      setDir(newDir);
      setSelectedId(id);
      setPlateKey((k) => k + 1);
      setWhyOpen(false);
      history.replaceState(null, "", `#n=${encodeURIComponent(id)}`);
    },
    [specimen],
  );

  const step = useCallback(
    (d: 1 | -1) => {
      const nav = list.length ? list : model.plates;
      if (!nav.length) return;
      const i = nav.findIndex((p) => p.id === specimen?.id);
      const next = nav[(i + d + nav.length) % nav.length];
      goPlate(next.id, d === 1 ? "next" : "prev");
    },
    [list, model.plates, specimen, goPlate],
  );

  const goNext = useCallback(() => step(1), [step]);
  const goPrev = useCallback(() => step(-1), [step]);

  /* Deep link on mount — restore a shared plate selection. */
  useEffect(() => {
    const m = location.hash.match(/^#n=(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (model.byId.has(id)) {
        setSelectedId(id);
        setWhyOpen(true);
      }
    }
    // run once per fresh model (first mount or resync)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis]);

  /* ---------------- keyboard ---------------- */
  const searchRef = useRef<string>("/");
  void searchRef;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (typing && e.key !== "Escape") return;
      if (e.key === "ArrowRight" && !typing) {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft" && !typing) {
        e.preventDefault();
        goPrev();
      } else if (e.key === "Enter" && !typing) {
        e.preventDefault();
        setWhyOpen((w) => !w);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[data-testid="rail-search"]')?.focus();
      } else if (e.key === "Escape") {
        if (typing) {
          setQuery("");
          (target as HTMLInputElement).blur();
        } else if (railOpen) setRailOpen(false);
        else setWhyOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev, railOpen]);

  const animating = stage === "entering";

  return (
    <div className="spec-root">
      <Backdrop reduced={reduced} fieldKey={fieldKey} />

      {showPre && <Preloader exiting={preExiting} reduced={reduced} repoName={model.meta.repoName} />}

      <div key={`frame-${enterKey}`} className="spec-frame">
        <TopBar
          animating={animating}
          plateNum={specimen?.num ?? "—"}
          total={model.plates.length}
          tabs={tabs}
          activeTab={tab}
          onTab={(t) => {
            setTab(t);
            setResolveTick((r) => r + 1);
          }}
          analysis={analyzing ? "analyzing" : state}
          onRefresh={onRefresh}
          watching={watching}
          onOpenRail={() => setRailOpen(true)}
        />

        <div className="spec-body">
          {railOpen && (
            <div
              className="rail-scrim"
              onClick={() => setRailOpen(false)}
              aria-hidden
            />
          )}
          <Rail
            animating={animating}
            list={list}
            all={model.plates}
            selectedId={specimen?.id}
            prevSelectedId={prevSelectedId}
            onSelect={(s: Specimen) => {
              goPlate(s.id, "next");
              setRailOpen(false);
            }}
            query={query}
            onQuery={setQuery}
            warnings={model.warnings}
            clusters={model.clusters}
            resolveTick={resolveTick}
            propTick={propTick}
            reduced={reduced}
            open={railOpen}
            onClose={() => setRailOpen(false)}
          />

          <main className="spec-main">
            {/* faint provenance marks, lower corners */}
            <div {...en(animating, 700, 560)} className="spec-srcpos" aria-hidden>
              <span className="mono">
                {specimen ? `${specimen.file} : ${specimen.range.replace("L", "")}` : ""}
              </span>
            </div>
            <div {...en(animating, 740, 560)} className="spec-mark">
              <span className="mono">
                RIPPLE · {model.meta.repoName.toUpperCase()} · LOCAL 127.0.0.1
              </span>
              <span className="mono spec-mark-sig">SIGNAL RED</span>
            </div>

            <div className="spec-plate-wrap">
              {/* failure / recovery strip — canonical liveError state.
                  Rendered above the plate AND the empty state so a failed
                  live analysis is always visible, even when the last valid
                  result legitimately had zero plates. */}
              {strip !== "none" && (
                <div
                  className={`failstrip ${strip === "in" ? "strip-in" : "strip-out"}`}
                  role="alert"
                  data-testid="fail-strip"
                >
                  <span className="failstrip-bar" aria-hidden />
                  {!reduced && <span className="strip-shimmer failstrip-shimmer" aria-hidden />}
                  <div className="failstrip-row">
                    <span className="label failstrip-title">ANALYSIS INTERRUPTED</span>
                    <span className="mono failstrip-sub">
                      Latest analysis failed. Showing the previous valid result.
                    </span>
                    <span className="mono failstrip-hint">EDIT THE SOURCE TO RETRY</span>
                  </div>
                  {errorLine && (
                    <div className="mono failstrip-err" data-testid="fail-error">
                      {errorLine}
                    </div>
                  )}
                </div>
              )}
              {empty ? (
                <section className="spec-empty" aria-live="polite">
                  <div {...en(animating, 120, 520)} className="spec-empty-inner">
                    <div className="spec-empty-letters" aria-label="RIPPLE">
                      {"RIPPLE".split("").map((c, i) => (
                        <span
                          key={i}
                          className="char display spec-empty-char"
                          style={{ ["--cd" as string]: `${reduced ? 0 : 160 + i * 46}ms` }}
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                    <div className="spec-empty-rule" />
                    <h2 className="display spec-empty-title">No change surface detected.</h2>
                    <p className="mono spec-empty-sub">Save a change to trace its impact.</p>
                  </div>

                  <div {...en(animating, 520, 620)} className="mono spec-empty-stats" aria-hidden>
                    {[
                      ["INDEX", `${String(model.warnings.length).padStart(2, "0")} WARN`],
                      ["GRAPH", `${model.meta.repoName.toUpperCase()}`],
                      ["DIFF", `${model.meta.oldRev.slice(0, 7)}`],
                      ["EVIDENCE", `${model.meta.totalMs} MS`],
                    ].map(([k, v]) => (
                      <div key={k} className="spec-empty-stat">
                        <div className="label-sm spec-empty-stat-k">{k}</div>
                        <div className="mono spec-empty-stat-v">{v}</div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : specimen ? (
                <Plate
                  specimen={specimen}
                  model={model}
                  analysis={analysis}
                  animating={animating}
                  plateKey={plateKey}
                  dir={dir}
                  analysisKey={analysisKey}
                  whyOpen={whyOpen}
                  onWhyToggle={() => setWhyOpen((w) => !w)}
                  failed={!!liveError}
                  reduced={reduced}
                  onPrev={goPrev}
                  onNext={goNext}
                  onJump={(id) => goPlate(id, model.plates.findIndex((p) => p.id === id) > selectedIndex ? "next" : "prev")}
                />
              ) : null}
            </div>
          </main>

          {/* sticky bottom paging — mobile only (hidden ≥768px) */}
          {!empty && specimen && (
            <nav className="spec-mobilenav" aria-label="Specimen paging">
              <button
                type="button"
                onClick={goPrev}
                className="link-shift plate-nav-btn spec-mobilenav-btn"
                data-testid="mnav-prev"
              >
                <span className="plate-nav-arrow" aria-hidden>←</span>
                <span className="label">PREV</span>
              </button>
              <span className="mono tnum spec-mobilenav-count">
                <span className="verm">{specimen.num}</span>
                {" / "}
                {String(model.plates.length).padStart(2, "0")}
              </span>
              <button
                type="button"
                onClick={goNext}
                className="link-shift plate-nav-btn next spec-mobilenav-btn"
                data-testid="mnav-next"
              >
                <span className="label">NEXT</span>
                <span className="plate-nav-arrow" aria-hidden>→</span>
              </button>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
