import type { ImpactKey, Specimen } from "./model.js";

interface Props {
  specimen: Specimen;
  replayKey: string | number;
  reduced: boolean;
}

const VERM = "#f75001";
const PAPER = "#f2efea";

/** Geometric class mark — variant geometry only; the ring + tick frame never change. */
export default function ClassMark({ specimen, replayKey, reduced }: Props) {
  const k: ImpactKey = specimen.impactKey;
  const md = (ms: number) => ({ ["--md" as string]: reduced ? "0ms" : `${ms}ms` });
  const draw = (len: string, mdMs: number) =>
    ({
      ["--len" as string]: len,
      ["--md" as string]: reduced ? "0ms" : `${mdMs}ms`,
    }) as React.CSSProperties;

  return (
    <div className="classmark">
      <svg width="150" height="150" viewBox="0 0 150 150" fill="none" aria-hidden className="classmark-svg">
        {/* frame ticks */}
        <g stroke={PAPER} strokeWidth="1" opacity="0.34">
          <path d="M6 34V6h28" />
          <path d="M144 34V6h-28" />
          <path d="M6 116v28h28" />
          <path d="M144 116v28h-28" />
        </g>

        <g key={replayKey}>
          {/* outer ring */}
          <circle
            cx="75" cy="75" r="52"
            stroke={VERM} strokeWidth="1.7"
            className={reduced ? "" : "mark-draw"}
            style={draw("327", 60)}
            opacity={0.95}
          />
          {/* faint measurement arc */}
          <circle
            cx="75" cy="75" r="43"
            stroke={VERM} strokeWidth="1"
            strokeDasharray="46 224" strokeLinecap="butt" opacity={0.34}
            className={reduced ? "" : "mark-draw"}
            style={draw("271", 200)}
          />
          {/* 12 o'clock index */}
          <path d="M75 23V31" stroke={VERM} strokeWidth="1.6" className={reduced ? "" : "mark-fade"} style={md(240)} />
          <path d="M75 119v8" stroke={VERM} strokeWidth="1.2" opacity="0.5" className={reduced ? "" : "mark-fade"} style={md(260)} />

          {/* --- variant geometry --- */}
          {k === "changed" && (
            <g>
              <rect x="53" y="53" width="44" height="44" transform="rotate(45 75 75)" stroke={VERM} strokeWidth="1.5" fill="rgba(247,80,1,0.05)" className={reduced ? "" : "mark-draw"} style={draw("177", 340)} />
              <rect x="62" y="62" width="26" height="26" transform="rotate(45 75 75)" stroke={VERM} strokeWidth="1" opacity="0.5" className={reduced ? "" : "mark-fade"} style={md(560)} />
              <circle cx="75" cy="75" r="4" fill={VERM} className={reduced ? "" : "mark-fade"} style={md(720)} />
            </g>
          )}

          {k === "direct" && (
            <g>
              <rect x="53" y="53" width="44" height="44" transform="rotate(45 75 75)" stroke={VERM} strokeWidth="1.5" fill="rgba(247,80,1,0.04)" className={reduced ? "" : "mark-draw"} style={draw("177", 340)} />
              <circle cx="75" cy="75" r="15" stroke={VERM} strokeWidth="1.2" opacity="0.9" className={reduced ? "" : "mark-pulse"} style={md(520)} />
              <circle cx="75" cy="75" r="4" fill={VERM} className={reduced ? "" : "mark-fade"} style={md(680)} />
            </g>
          )}

          {k === "transitive" && (
            <g>
              <rect x="53" y="53" width="44" height="44" transform="rotate(45 75 75)" stroke={VERM} strokeWidth="1.4" fill="rgba(247,80,1,0.04)" opacity="0.75" className={reduced ? "" : "mark-draw"} style={draw("177", 340)} />
              <path d="M48 66h54" stroke={VERM} strokeWidth="1.5" className={reduced ? "" : "mark-stroke"} style={md(520)} />
              <path d="M48 84h54" stroke={VERM} strokeWidth="1.1" opacity="0.7" className={reduced ? "" : "mark-stroke"} style={md(660)} />
              <circle cx="75" cy="75" r="3.4" fill={VERM} className={reduced ? "" : "mark-fade"} style={md(760)} />
            </g>
          )}

          {k === "type" && (
            <g>
              <path d="M75 47L101 96H49L75 47Z" stroke={VERM} strokeWidth="1.5" fill="rgba(247,80,1,0.05)" className={reduced ? "" : "mark-draw"} style={draw("196", 340)} />
              <path d="M75 63L88 90H62L75 63Z" stroke={VERM} strokeWidth="1" opacity="0.52" className={reduced ? "" : "mark-fade"} style={md(560)} />
              <circle cx="75" cy="84" r="3.6" fill={VERM} className={reduced ? "" : "mark-fade"} style={md(700)} />
            </g>
          )}

          {k === "test" && (
            <g>
              <rect x="52" y="52" width="46" height="46" stroke={VERM} strokeWidth="1.5" fill="rgba(247,80,1,0.045)" className={reduced ? "" : "mark-draw"} style={draw("184", 340)} />
              <path d="M62 75.5L71 84.5L90 62" stroke={VERM} strokeWidth="1.8" strokeLinecap="square" fill="none" className={reduced ? "" : "mark-stroke"} style={md(540)} />
              <path d="M52 63h8M90 87h8" stroke={VERM} strokeWidth="1" opacity="0.55" className={reduced ? "" : "mark-fade"} style={md(700)} />
            </g>
          )}

          {k === "reference" && (
            <g opacity="0.5">
              <rect x="53" y="53" width="44" height="44" transform="rotate(45 75 75)" stroke={VERM} strokeWidth="1.4" strokeDasharray="26 14" fill="none" className={reduced ? "" : "mark-draw"} style={draw("177", 340)} />
              <circle cx="75" cy="75" r="12" stroke={VERM} strokeWidth="1" strokeDasharray="18 9" opacity="0.7" className={reduced ? "" : "mark-draw"} style={draw("76", 540)} />
              <circle cx="75" cy="75" r="2.8" fill={VERM} opacity="0.75" className={reduced ? "" : "mark-fade"} style={md(660)} />
            </g>
          )}

          {k === "deleted" && (
            <g>
              <circle cx="75" cy="75" r="34" stroke={VERM} strokeWidth="1.6" fill="none" opacity="0.9" className={reduced ? "" : "mark-break"} style={md(340)} />
              <rect x="59" y="59" width="32" height="32" transform="rotate(45 75 75)" stroke={VERM} strokeWidth="1" opacity="0.22" className={reduced ? "" : "mark-fade"} style={md(560)} />
              <circle cx="75" cy="75" r="3" fill={VERM} opacity="0.5" className={reduced ? "" : "mark-fade"} style={md(700)} />
            </g>
          )}

          {k === "uncertain" && (
            <g>
              <circle cx="75" cy="75" r="46" stroke={VERM} strokeWidth="1.2" strokeDasharray="7 10" opacity="0.7" fill="none" className={reduced ? "" : "mark-draw"} style={draw("290", 340)} />
              <rect x="58" y="58" width="34" height="34" transform="rotate(45 75 75)" stroke={VERM} strokeWidth="1.2" strokeDasharray="14 10" opacity="0.75" className={reduced ? "" : "mark-draw"} style={draw("136", 520)} />
              <circle cx="75" cy="75" r="3" fill={VERM} className={reduced ? "" : "mark-fade"} style={md(680)} />
            </g>
          )}
        </g>
      </svg>

      <div className="classmark-meta">
        <span className="label-sm classmark-label">CLASS MARK</span>
        <span className="label classmark-kind">{specimen.impact}</span>
        <span className="mono classmark-file">{specimen.sourceFile.split("/").pop()}</span>
      </div>
    </div>
  );
}
