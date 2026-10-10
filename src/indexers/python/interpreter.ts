import { execFileSync } from "node:child_process";

/**
 * Python interpreter discovery for the enrichment helper.
 *
 * scip-python itself resolves the project's environment on its own; this
 * discovery is for OUR stdlib-ast classification pass, which runs Python
 * locally. Deterministic order, first usable >=3.10 wins:
 *   python → py -3 → python3
 * No interpreter, or <3.10, declines analysis honestly — never a degraded
 * silent attempt.
 */

export const PYTHON_MIN = "3.10";

export interface PythonEnv {
  /** Executable, e.g. "python" or "py". */
  exe: string;
  /** Fixed args before script args (["-3"] for the `py` launcher). */
  args: string[];
  version: string;
}

export class PythonUnavailableError extends Error {
  readonly code: "PYTHON_INTERPRETER_UNAVAILABLE" | "PYTHON_VERSION_UNSUPPORTED";
  constructor(code: PythonUnavailableError["code"], message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const CANDIDATES: { exe: string; args: string[] }[] = [
  { exe: "python", args: [] },
  { exe: "py", args: ["-3"] },
  { exe: "python3", args: [] },
];

const VERSION_SNIPPET =
  "import sys;print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')";

function probe(exe: string, args: string[]): string | undefined {
  try {
    const out = execFileSync(exe, [...args, "-c", VERSION_SNIPPET], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    });
    return out.trim();
  } catch {
    return undefined;
  }
}

function atLeast(version: string, min: string): boolean {
  const a = version.split(".").map((n) => parseInt(n, 10) || 0);
  const b = min.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

let cached: PythonEnv | null | undefined;

/** First usable Python >=3.10, or undefined. Cached for the process. */
export function findPython(): PythonEnv | undefined {
  if (cached !== undefined) return cached ?? undefined;
  for (const c of CANDIDATES) {
    const version = probe(c.exe, c.args);
    if (!version) continue;
    if (atLeast(version, PYTHON_MIN)) {
      cached = { ...c, version };
      return cached;
    }
  }
  cached = null;
  return undefined;
}

/** Versions found during probing — for honest error messages. */
export function describeProbed(): string {
  const found: string[] = [];
  for (const c of CANDIDATES) {
    const v = probe(c.exe, c.args);
    if (v) found.push(`${c.exe}${c.args.length ? " " + c.args.join(" ") : ""}=${v}`);
  }
  return found.join(", ") || "none of python / py -3 / python3 responded";
}

/** Resolve the interpreter or throw a structured, honest error. */
export function requirePython(): PythonEnv {
  const env = findPython();
  if (env) return env;
  const probed = describeProbed();
  const any = probed !== "none of python / py -3 / python3 responded";
  throw new PythonUnavailableError(
    any ? "PYTHON_VERSION_UNSUPPORTED" : "PYTHON_INTERPRETER_UNAVAILABLE",
    any
      ? `Python >=${PYTHON_MIN} required; found: ${probed}`
      : `no Python interpreter found (tried: python, py -3, python3)`,
  );
}
