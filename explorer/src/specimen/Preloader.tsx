import { useEffect, useState } from "react";

/* Entrance choreography only — stage ticks mark the boot animation's own
   clock, not engine progress. The parent holds exit until the first real
   analysis result has arrived, so the reveal never precedes real data. */
const STAGES = ["INDEX", "GRAPH", "DIFF", "IMPACT", "EVIDENCE"];

interface Props {
  exiting: boolean;
  reduced: boolean;
  repoName?: string;
}

export default function Preloader({ exiting, reduced, repoName }: Props) {
  const [stage, setStage] = useState(0);
  const [pct, setPct] = useState(0);

  useEffect(() => {
    const timers: number[] = [];
    STAGES.forEach((_, i) => {
      timers.push(window.setTimeout(() => setStage(i + 1), 560 + i * 135));
    });
    if (reduced) {
      setStage(STAGES.length);
      setPct(100);
      return;
    }
    const start = performance.now();
    const dur = 1180;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      setPct(Math.round((1 - Math.pow(1 - k, 2.2)) * 100));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
    };
  }, [reduced]);

  return (
    <div
      className={`preloader ${exiting ? "pl-shell-out" : ""}`}
      role="status"
      aria-live="polite"
      aria-label="Ripple preloader"
    >
      <div className="pl-bg" />
      <div className="noise-sheet pl-noise" />

      <div className="pl-corner tl">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
          <path d="M0 0h20M0 0v20" stroke="#f75001" strokeWidth="1" />
        </svg>
        <span className="label-sm">RIPPLE / BOOT / LOCAL</span>
      </div>
      <div className="label-sm pl-corner tr">{repoName ? `${repoName.toUpperCase()} · LOCAL 127.0.0.1` : "LOCAL 127.0.0.1"}</div>
      <div className="pl-corner bl">
        <div className="pl-corner-rule" />
        <div className="label-sm pl-corner-sub">RESOLVING CAUSAL DEPTH</div>
      </div>
      <div className="pl-corner br">
        <div className="mono tnum pl-pct">{String(pct).padStart(3, "0")}</div>
        <div className="label-sm pl-corner-sub">PERCENT</div>
      </div>

      <div className="pl-center">
        <div className="mono pl-letters" aria-label="RIPPLE">
          {"RIPPLE".split("").map((c, i) => (
            <span key={i} className="pl-letter" style={{ ["--ld" as string]: `${90 + i * 68}ms` }}>
              {c}
            </span>
          ))}
        </div>

        <div className="pl-bar">
          <div
            className="pl-bar-fill"
            style={{
              animation: reduced ? "none" : "wipe-in 900ms cubic-bezier(.22,.7,.24,1) 380ms both",
            }}
          />
        </div>

        <div className="pl-stages">
          {STAGES.map((s, i) => {
            const done = i < stage;
            return (
              <div key={s} className="pl-stage" style={{ ["--sd" as string]: `${520 + i * 120}ms` }}>
                <span className={`label ${done ? "pl-stage-done" : "pl-stage-pending"}`}>{s}</span>
                <span className="pl-stage-track">
                  <span
                    className="pl-stage-fill"
                    style={{ transform: `scaleX(${done ? 1 : 0})`, opacity: done ? 0.5 : 0 }}
                  />
                </span>
                <span className="pl-stage-tick">
                  {done && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="pl-tick" style={{ ["--sd" as string]: `${520 + i * 120 + 120}ms` }}>
                      <path d="M2 6.4L4.7 9 10 3.2" stroke="#f75001" strokeWidth="1.3" strokeLinecap="square" />
                    </svg>
                  )}
                </span>
                <span className={`mono tnum pl-stage-status ${done ? "pl-stage-done" : ""}`}>
                  {done ? "OK" : "··"}
                </span>
              </div>
            );
          })}
        </div>

        <p className="pl-stage pl-tagline" style={{ ["--sd" as string]: "1240ms" }}>
          See what your code change touches before you ship it.
        </p>
      </div>

      {!reduced && (
        <div className="pl-sweep-wrap" aria-hidden>
          <div className="pl-sweep" />
        </div>
      )}

      <span className="pl-frame tl" />
      <span className="pl-frame tr" />
      <span className="pl-frame bl" />
      <span className="pl-frame br" />
    </div>
  );
}
