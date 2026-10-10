/**
 * Windows launcher for @sourcegraph/scip-python.
 *
 * scip-python 0.6.6 crashes at module load on Windows:
 *   virtualenv/PythonEnvironment.ts — `new RegExp(path.sep, "g")`
 * builds /\ at end of pattern when path.sep === "\\".
 *
 * Ripple spawns scip-python as a subprocess anyway, so neutralizing
 * `path.sep` inside THIS child process repairs the regex without touching
 * vendored code and without affecting the parent process. `path.sep` is a
 * plain writable string; path.join/resolve are unaffected (they use
 * hardcoded separators internally). Local analysis only — this launcher
 * changes nothing about what scip-python reads or writes.
 *
 * Usage: node scip-python-launcher.cjs <path-to-scip-python-index.js> [args...]
 */
"use strict";
const path = require("path");
try {
  Object.defineProperty(path, "sep", { value: "/", writable: true });
} catch {
  try {
    path.sep = "/";
  } catch {
    /* best-effort — non-Windows or frozen module */
  }
}
const entry = process.argv[2];
if (!entry) {
  console.error("usage: scip-python-launcher.cjs <scip-python-index.js> [args...]");
  process.exit(2);
}
// Present argv to commander as if the entry were invoked directly.
process.argv = [process.argv[0], entry, ...process.argv.slice(3)];
require(entry);
