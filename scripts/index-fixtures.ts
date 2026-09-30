/**
 * Runs scip-typescript over every fixture project, writing <fixture>/index.scip.
 * Usage: npx tsx scripts/index-fixtures.ts [fixtureName]
 */
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const fixturesRoot = resolve("fixtures");
const scipTypescriptBin = resolve(
  "node_modules/@sourcegraph/scip-typescript/dist/src/main.js",
);
const only = process.argv[2];

const fixtures = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => !only || name === only);

for (const name of fixtures) {
  const dir = join(fixturesRoot, name);
  if (!existsSync(join(dir, "package.json"))) continue;
  const out = join(dir, "index.scip");
  const t0 = performance.now();
  execFileSync(
    process.execPath,
    [
      scipTypescriptBin,
      "index",
      "--cwd",
      dir,
      "--output",
      out,
      "--no-progress-bar",
    ],
    { stdio: "pipe" },
  );
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${name}: indexed in ${ms}ms -> ${out}`);
}
