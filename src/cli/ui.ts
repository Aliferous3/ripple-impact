/**
 * Terminal output helpers — restrained, stderr-for-status so `--json`
 * stdout stays machine-clean. No branding banner, no fake percentages.
 * Honors NO_COLOR and non-TTY output (CI/log capture gets plain lines).
 */

export const useColor =
  !process.env.NO_COLOR && (process.stdout.isTTY || process.stderr.isTTY);

const c = (code: string) => (s: string) =>
  useColor ? `\u001b[${code}m${s}\u001b[0m` : s;

export const dim = c("2");
export const bold = c("1");
export const amber = c("33");
export const red = c("31");
export const green = c("32");
export const purple = c("35");

let quietMode = false;
export function setQuiet(q: boolean): void {
  quietMode = q;
}

/** Human-facing status — always stderr, never contaminates --json stdout. */
export function status(msg: string): void {
  if (!quietMode) console.error(msg);
}

/** Label/value result lines — stdout (this IS the output). */
export function kv(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(18)}${value}`);
}



let pendingPhase = false;

/**
 * Progress for long phases: writes "Label… " immediately, then the
 * caller finishes with done() which appends the elapsed seconds.
 * Safe on non-TTY stderr — the partial line simply holds until done().
 */
export function phase(label: string): (extra?: string) => void {
  if (quietMode) return () => {};
  process.stderr.write(`${label}… `);
  pendingPhase = true;
  const t0 = performance.now();
  return (extra = "") => {
    pendingPhase = false;
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    process.stderr.write(`${s}s${extra ? ` ${extra}` : ""}\n`);
  };
}

export function error(msg: string): void {
  // end a dangling "Label… " progress line before the error lands
  if (pendingPhase) process.stderr.write("\n");
  pendingPhase = false;
  console.error(`error: ${msg}`);
}
