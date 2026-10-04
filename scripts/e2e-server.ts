/**
 * Deterministic backend for Playwright e2e runs.
 *
 *   npx tsx scripts/e2e-server.ts
 *
 * Ensures tmp/git-scenarios exists (builds it if missing), pins the working
 * tree at the s15 tag, drops an untracked binary file so the analysis emits a
 * BINARY_SKIPPED warning, then serves the explorer on RIPPLE_E2E_PORT.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startExplorer } from "../src/server/explorer.js";

const REPO = resolve("tmp/git-scenarios");
const PORT = Number(process.env.RIPPLE_E2E_PORT ?? 43173);
const BASE = "s0-base";
const HEAD_TAG = "s15-import-only";

if (!existsSync(join(REPO, ".git"))) {
  execFileSync("npx", ["tsx", "scripts/setup-git-fixture.ts"], {
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32",
  });
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", windowsHide: true });
}

// Pin a known committed state, then dirty the tree:
//  - untracked binary  → BINARY_SKIPPED warning
//  - refreshSession + validateUser edits → authenticateRequest becomes a
//    multi-root affected node (two changed roots reach it).
git("checkout", "-qf", HEAD_TAG);
mkdirSync(join(REPO, "assets"), { recursive: true });
writeFileSync(join(REPO, "assets", "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]));
writeFileSync(
  join(REPO, "src", "session.ts"),
  `export function refreshSession(id: string, opts?: number): string {
  return \`sess2-\${id}\`;
}

export function validateUser(id: string): boolean {
  return id.length >= 0;
}

export function currentRegion(): string {
  return "us-east";
}

export function issueToken(): string {
  return "t";
}
`,
);

const running = await startExplorer({ repo: REPO, base: BASE, port: PORT });
const a = running.analysis;
console.log(
  `e2e server: ${a.changed.length} changed · ${a.direct.length} direct · ` +
    `${a.transitive.length} downstream · ${a.tests.length} tests · ${a.warnings.length} warnings`,
);
console.log(`listening: ${running.url}`);
await new Promise(() => {});
