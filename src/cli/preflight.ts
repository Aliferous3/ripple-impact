import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { allAdapters, planForRepo } from "../indexers/registry.js";

/**
 * First-run environment checks — produce understandable messages instead
 * of opaque stack traces for the common setup problems.
 */

const SKIP = new Set(["node_modules", ".git", ".ripple", "dist", "build", "coverage", "out"]);

export interface PreflightResult {
  errors: string[];
  warnings: string[];
}

function hasSourceFiles(dir: string, sourceFile: (name: string) => boolean, depth = 0): boolean {
  if (depth > 6) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && sourceFile(String(e.name))) return true;
    if (e.isDirectory() && !SKIP.has(String(e.name)) && hasSourceFiles(join(dir, String(e.name)), sourceFile, depth + 1))
      return true;
  }
  return false;
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

/**
 * `needsGit`: commands that diff or read history (impact/changed/explore
 * --base). `analyze`/`dump`/`inspect` work on a plain directory too.
 */
export function preflight(root: string, needsGit: boolean): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    errors.push(`"${root}" is not a directory.`);
    return { errors, warnings };
  }

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) errors.push(`Ripple requires Node.js 22 or later (running ${process.version}).`);

  if (needsGit) {
    try {
      git(["--version"]);
    } catch {
      errors.push("git is not installed or not on PATH — diff analysis needs it.");
    }
    if (errors.length === 0) {
      try {
        git(["rev-parse", "--is-inside-work-tree"], root);
      } catch {
        errors.push(
          `"${root}" is not a Git repository.\nRun Ripple inside a repository or pass --root <path>.`,
        );
      }
      if (errors.length === 0) {
        try {
          git(["rev-parse", "--verify", "HEAD"], root);
        } catch {
          errors.push("This repository has no commits yet — commit at least once before diffing.");
        }
      }
    }
  }

  const plan = planForRepo(root);
  if (!plan || !hasSourceFiles(root, plan.files.sourceFile)) {
    const supported = allAdapters()
      .flatMap((a) => a.languages)
      .join(", ");
    errors.push(
      `Ripple could not find a supported language project here ` +
        `(supported today: ${supported}; Python is experimental).`,
    );
  } else if (plan.projects.some((p) => p.adapter.id === "typescript-javascript")) {
    const hasTsConfig =
      existsSync(join(root, "tsconfig.json")) || existsSync(join(root, "jsconfig.json"));
    const hasPkg = existsSync(join(root, "package.json"));
    const anchoredElsewhere = plan.projects.some(
      (p) => p.adapter.id === "typescript-javascript" && p.root !== "",
    );
    if (!hasTsConfig && !hasPkg && !anchoredElsewhere) {
      warnings.push(
        "no tsconfig.json/jsconfig.json or package.json found — scip-typescript may index nothing",
      );
    }
  }

  return { errors, warnings };
}
