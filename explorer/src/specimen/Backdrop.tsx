import { memo } from "react";

interface Ghost {
  x: string;
  y: string;
  text: string;
  go: number;
  size?: number;
  delay?: number;
  tone?: "warm" | "paper";
}

/* Generic decorative fragments only — never populated from real repository
   source. Ambient texture must not leak user code. */
const GHOSTS: Ghost[] = [
  { x: "1.6%", y: "26%", text: "{  }", go: 0.042, size: 26, delay: -3 },
  { x: "0.8%", y: "63%", text: "=>", go: 0.03, size: 19, delay: -9, tone: "paper" },
  { x: "2.2%", y: "79%", text: "[  ]", go: 0.036, size: 22, delay: -14 },
  { x: "6.5%", y: "47%", text: "src/index.ts", go: 0.028, size: 11, delay: -6, tone: "paper" },
  { x: "27%", y: "86%", text: "src/main.ts", go: 0.03, size: 11, delay: -17, tone: "paper" },
  { x: "44%", y: "91%", text: "::", go: 0.034, size: 18, delay: -11 },
  { x: "60%", y: "88%", text: "src/app.tsx", go: 0.026, size: 11, delay: -4, tone: "paper" },
  { x: "76%", y: "83%", text: "< />", go: 0.033, size: 21, delay: -13 },
  { x: "89%", y: "24%", text: "()", go: 0.04, size: 27, delay: -8 },
  { x: "94%", y: "52%", text: "L231", go: 0.031, size: 12, delay: -20, tone: "paper" },
  { x: "86%", y: "68%", text: "{ }", go: 0.034, size: 24, delay: -5 },
  { x: "96%", y: "72%", text: "d5", go: 0.029, size: 12, delay: -16, tone: "paper" },
  { x: "91%", y: "89%", text: "=>", go: 0.032, size: 20, delay: -10 },
  { x: "34%", y: "6%", text: "L182", go: 0.024, size: 11, delay: -19, tone: "paper" },
];

/* Generic TypeScript-looking texture — not derived from the analyzed repo. */
const STRIP = [
  "import type { Config } from \"./config\";",
  "export interface Node {",
  "  id: string;",
  "  kind: string;",
  "  depth: number;",
  "}",
  "export function traverse(",
  "  root: Node,",
  "): Node[] {",
  "  return walk(root, []);",
  "}",
  "const CACHE = new Map<string, Node>();",
  "export const version = \"0.1.0\";",
  "type Edges = Node[\"edges\"];",
  "export function resolve(",
  "  ref: Ref,",
  "): string { return ref.id; }",
  "describe(\"graph\", () => {",
  "  expect(traverse(root)).toEqual([",
  "    expect.any(Object),",
  "  ]);",
  "});",
  "export const href = (",
  "  id: string,",
  ") => `/n/${id}`;",
];

function Strip({ side, reduced }: { side: "left" | "right"; reduced: boolean }) {
  return (
    <div
      aria-hidden
      className={`bd-strip ${side === "left" ? "bd-strip-l" : "bd-strip-r"}`}
      style={{
        maskImage:
          "linear-gradient(to bottom, transparent, #000 12%, #000 74%, transparent 97%)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent, #000 12%, #000 74%, transparent 97%)",
      }}
    >
      <div
        className="bg-strip mono bd-strip-inner"
        style={{
          fontSize: side === "left" ? "9.5px" : "10px",
          color: side === "left" ? "#f2efea" : "#f75001",
          transform: reduced ? "none" : undefined,
          animationDuration: reduced ? "0s" : undefined,
        }}
      >
        {STRIP.map((l, i) => (
          <div key={i} className="bd-strip-line">
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

function BackdropBase({ reduced, fieldKey }: { reduced: boolean; fieldKey: number }) {
  return (
    <div aria-hidden className="backdrop">
      {/* base panel surface — warm anodised dark, not flat black */}
      <div className="bd-surface" />
      <div className="noise-sheet bd-noise" />

      {/* L1 — editor grid: vertical rulers + horizontal guides + indent lines */}
      <div
        className="bg-grid bd-grid"
        style={{ animation: reduced ? "none" : undefined }}
      />
      <div className="bd-indent" style={{ left: "27%", background: "rgba(247,80,1,0.05)" }} />
      <div className="bd-indent" style={{ left: "41%", background: "rgba(242,239,234,0.03)" }} />
      <div className="bd-indent" style={{ left: "55%", background: "rgba(242,239,234,0.022)" }} />
      <div className="bd-indent" style={{ left: "79%", background: "rgba(242,239,234,0.026)" }} />

      {/* L2 — code ghosts */}
      {GHOSTS.map((g, i) => (
        <span
          key={i}
          aria-hidden
          className="bg-ghost mono bd-ghost"
          style={{
            left: g.x,
            top: g.y,
            fontSize: g.size ?? 14,
            fontWeight: g.size && g.size > 20 ? 500 : 400,
            color: g.tone === "paper" ? "#f2efea" : "#f75001",
            opacity: g.go,
            animationDelay: `${g.delay ?? -i}s`,
            animation: reduced ? "none" : undefined,
          }}
        >
          {g.text}
        </span>
      ))}

      {/* L3 — edge source columns */}
      <Strip side="left" reduced={reduced} />
      <Strip side="right" reduced={reduced} />

      {/* L4 — ripple disturbance field behind the selected specimen */}
      <div
        className="bg-field bd-field"
        style={{ animation: reduced ? "none" : undefined }}
      />
      {fieldKey > 0 && !reduced && <div key={fieldKey} className="field-expand bd-field-pulse" />}

      {/* L5 — technical marks: registration crosses + corner ticks */}
      <RegMark x="25.5%" y="12.5%" />
      <RegMark x="79.5%" y="88.5%" />
      <RegMark x="4.6%" y="12%" />
      <RegMark x="97.6%" y="14%" />
      <Tick x="24.2%" y="9%" />
      <Tick x="80.8%" y="9%" rotate />
      <Tick x="24.2%" y="91%" />
      <Tick x="80.8%" y="91%" rotate />
    </div>
  );
}

function RegMark({ x, y }: { x: string; y: string }) {
  return (
    <span aria-hidden className="bd-regmark" style={{ left: x, top: y }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 0v14M0 7h14" stroke="#f75001" strokeWidth="0.7" />
        <circle cx="7" cy="7" r="3.4" stroke="#f2efea" strokeWidth="0.6" opacity="0.7" />
      </svg>
    </span>
  );
}

function Tick({ x, y, rotate }: { x: string; y: string; rotate?: boolean }) {
  return (
    <span
      aria-hidden
      className="bd-tick"
      style={{ left: x, top: y, transform: rotate ? "rotate(90deg)" : undefined }}
    >
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
        <path d="M0 0h26M0 0v26" stroke="#f2efea" strokeWidth="1" />
      </svg>
    </span>
  );
}

export default memo(BackdropBase);
