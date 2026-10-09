import type { CSSProperties } from "react";

/* Inline animation styles are used rather than the `anim`/`a-*` classes alone:
   callers set their own className, and inline longhands always win, so the
   entrance never silently drops out. */
const KEYFRAME: Record<string, string> = {
  "a-fade-up": "fade-up",
  "a-fade": "fade-in",
  "a-wipe": "wipe-in",
  "a-mask": "mask-down",
  "a-rule": "rule-grow",
};

/** Entrance helper — returns className/style only while the entrance stage is running. */
export function en(
  on: boolean,
  delay: number,
  d = 460,
  base = "a-fade-up",
): { className: string; style: CSSProperties } {
  return on
    ? {
        className: `anim ${base}`,
        style: {
          animationName: KEYFRAME[base] ?? "fade-up",
          animationDuration: `${d}ms`,
          animationDelay: `${delay}ms`,
          animationTimingFunction: "cubic-bezier(.22,.7,.24,1)",
          animationFillMode: "both",
        } as CSSProperties,
      }
    : { className: "", style: {} as CSSProperties };
}

/** Rail arrival order — lower categories resolve first. */
export const DEPTH_ORDER: Record<string, number> = {
  changed: 0,
  direct: 0.5,
  transitive: 1.4,
  type: 2.4,
  test: 3.2,
  reference: 4,
  uncertain: 4,
  deleted: 0,
};
