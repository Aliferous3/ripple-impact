import { en } from "./lib/motion.js";

export type AnalysisState = "idle" | "analyzing" | "complete" | "failed";

interface Props {
  animating: boolean;
  plateNum: string;
  total: number;
  /** Category labels actually present, in model order. */
  tabs: string[];
  activeTab: string;
  onTab: (t: string) => void;
  analysis: AnalysisState;
  /** Refreshes the view from the server's latest authoritative result. */
  onRefresh: () => void;
  watching: boolean;
  /** Opens the specimen drawer — rendered only below the 768px breakpoint. */
  onOpenRail: () => void;
}

function SignalIcon({ spin }: { spin: boolean }) {
  return (
    <span className="signal-icon">
      {!spin ? (
        <svg viewBox="0 0 14 14" className="signal-svg" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="5.2" stroke="#f75001" strokeWidth="1.1" strokeDasharray="22 12" strokeLinecap="butt" />
          <circle cx="7" cy="7" r="1.5" fill="#f75001" />
        </svg>
      ) : (
        <span className="signal-spin">
          <span className="signal-ring" />
          <span className="signal-ring" />
          <span className="signal-ring" />
          <span className="signal-core signal-dot" />
        </span>
      )}
    </span>
  );
}

export default function TopBar({
  animating,
  plateNum,
  total,
  tabs,
  activeTab,
  onTab,
  analysis,
  onRefresh,
  watching,
  onOpenRail,
}: Props) {
  const actionLabel =
    analysis === "analyzing"
      ? "ANALYZING…"
      : analysis === "complete"
        ? "ANALYSIS COMPLETE"
        : analysis === "failed"
          ? "REFRESH · LAST FAILED"
          : "LIVE ANALYSIS";

  return (
    <header {...en(animating, 80, 520)} className="topbar">
      {/* the vermilion sweep resolves into this hairline */}
      <span {...en(animating, 470, 700, "a-wipe")} className="topbar-sweep" aria-hidden />

      <button
        type="button"
        onClick={onOpenRail}
        aria-label="Open specimen list"
        className="link-shift topbar-menu"
        data-testid="rail-open"
      >
        <span className="topbar-menu-bars" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        <span className="label">SPECIMEN</span>
        <span className="mono tnum topbar-menu-count">
          {plateNum}/{String(total).padStart(2, "0")}
        </span>
      </button>

      <div className="topbar-brand">
        <span className="display topbar-logo">RIPPLE</span>
        <span className="topbar-sep" />
        <p className="topbar-tagline">See what your code change touches before you ship it.</p>
      </div>

      <span className="topbar-sep topbar-sep-xl" />
      <div className="topbar-platecount">
        <span className="label topbar-plate-label">PLATE</span>
        <span className="mono tnum topbar-plate-num">{plateNum}</span>
        <span className="mono tnum topbar-plate-total">/ {String(total).padStart(2, "0")}</span>
      </div>

      <div className="topbar-right">
        <div className="scroll-thin topbar-tabs" role="tablist" aria-label="Plate category filter">
          {tabs.map((t) => {
            const active = t === activeTab;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onTab(t)}
                className={`link-shift label chip-wash topbar-tab ${active ? "active" : ""}`}
              >
                {active && <span className="topbar-tab-corner" aria-hidden />}
                {t}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onRefresh}
          aria-live="polite"
          title="Refetch the latest analysis — the watcher re-analyzes on save automatically"
          className={`link-shift chip-wash topbar-action ${
            analysis === "complete" ? "complete" : analysis === "failed" ? "failed" : ""
          }`}
        >
          <SignalIcon spin={analysis === "analyzing"} />
          <span className="label topbar-action-label">{actionLabel}</span>
          {analysis === "analyzing" && (
            <span className="topbar-action-shimmer" aria-hidden>
              <span className="strip-shimmer topbar-action-shimmer-in" />
            </span>
          )}
        </button>

        <div
          className={`topbar-watch ${watching ? "" : "off"}`}
          title={watching ? "Live analysis is watching the working tree" : "Watcher is not running"}
        >
          <span className={`block-dot ${watching ? "watching-dot" : ""}`} />
          <span className="label topbar-watch-label">{watching ? "WATCHING" : "NOT WATCHING"}</span>
        </div>
      </div>
    </header>
  );
}
