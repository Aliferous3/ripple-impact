import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startExplorer, type RunningExplorer } from "../src/server/explorer.js";

/**
 * Python-adapter explorer e2e (experimental).
 *
 * Builds its own fixtures — a Python monorepo (api/) and a mixed
 * TS+Python repo — then serves each through the real explorer pipeline:
 * scip-python → python AST enrichment → merged graph → AnalysisResult → UI.
 */

const PY_REPO = resolve("tmp/e2e-python");
const MIXED_REPO = resolve("tmp/e2e-mixed");

function write(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });

function buildPyRepo() {
  rmSync(PY_REPO, { recursive: true, force: true });
  write(PY_REPO, "api/pyproject.toml", '[project]\nname = "e2epy"\nversion = "0.1.0"\n');
  write(PY_REPO, "api/pkg/__init__.py", "");
  write(PY_REPO, "api/pkg/models.py", "class User:\n    name: str\n");
  write(
    PY_REPO,
    "api/pkg/store.py",
    "def save(x):\n    return x\n\n\ndef orphan(x):\n    return x\n",
  );
  write(
    PY_REPO,
    "api/pkg/api.py",
    "from .store import save, orphan\n\n\ndef handler(x):\n    return save(x) + orphan(x)\n",
  );
  write(
    PY_REPO,
    "api/pkg/typed.py",
    "from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from .models import User\n\n\ndef f(u: \"User\") -> \"User\":\n    return u\n",
  );
  execFileSync("git", ["init", "-q", PY_REPO], { windowsHide: true });
  git(PY_REPO, "add", "-A");
  git(PY_REPO, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");

  // Dirty the tree: runtime edit + TYPE_CHECKING edit + a deletion that
  // leaves a former caller behind.
  write(
    PY_REPO,
    "api/pkg/store.py",
    "def save(x):\n    return x + 1\n",
  );
  write(
    PY_REPO,
    "api/pkg/typed.py",
    "from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from .models import User as U\n\n\ndef f(u: \"User\") -> \"User\":\n    return u\n",
  );
}

function buildMixedRepo() {
  rmSync(MIXED_REPO, { recursive: true, force: true });
  write(MIXED_REPO, "frontend/tsconfig.json", '{"compilerOptions":{"strict":true},"include":["src"]}');
  write(
    MIXED_REPO,
    "frontend/src/app.ts",
    'import { format } from "./fmt";\n\nexport function handler(x: string): string {\n  return format(x);\n}\n',
  );
  write(MIXED_REPO, "frontend/src/fmt.ts", "export function format(x: string): string {\n  return x.trim();\n}\n");
  write(MIXED_REPO, "backend/pyproject.toml", '[project]\nname = "be"\nversion = "0.1.0"\n');
  write(MIXED_REPO, "backend/pkg/__init__.py", "");
  write(
    MIXED_REPO,
    "backend/pkg/api.py",
    "from .store import save\n\n\ndef handler(x):\n    return save(x)\n",
  );
  write(MIXED_REPO, "backend/pkg/store.py", "def save(x):\n    return x\n\n\ndef format(x):\n    return str(x)\n");
  execFileSync("git", ["init", "-q", MIXED_REPO], { windowsHide: true });
  git(MIXED_REPO, "add", "-A");
  git(MIXED_REPO, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
}

async function analysis(page: Page, base: string) {
  const res = await page.request.get(`${base}/api/analysis`);
  expect(res.ok()).toBe(true);
  return res.json();
}

async function openExplorer(page: Page, url: string) {
  await page.goto(url);
  await page.waitForSelector('[data-testid="rail-plate"], .spec-empty', {
    timeout: 30_000,
  });
  await page.waitForSelector(".preloader", { state: "detached", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(500);
}

test.describe("python adapter explorer", () => {
  let running: RunningExplorer | undefined;
  let base = "";
  test.beforeAll(async () => {
    buildPyRepo();
    running = await startExplorer({ repo: PY_REPO, base: "HEAD", port: 0 });
    base = `http://127.0.0.1:${running.port}`;
  });
  test.afterAll(async () => {
    await running?.close();
  });

  test("runtime change propagates to the python caller", async ({ page }) => {
    await openExplorer(page, base);
    const a = await analysis(page, base);
    const save = a.changed.find((c: { name: string }) => c.name === "save()");
    expect(save?.file).toBe("api/pkg/store.py");
    expect(save?.changeKind).toBe("modified");
    const handler = a.direct.find((s: { name: string }) => s.name === "handler()");
    expect(handler?.file).toBe("api/pkg/api.py");
    // Rail plate renders the python symbol in the standard Design #33 UI.
    await expect(
      page.locator('[data-testid="rail-plate"]', { hasText: "save()" }).first(),
    ).toBeVisible();
  });

  test("type-only module statement marks module scope without runtime impact", async ({ page }) => {
    const a = await analysis(page, base);
    const scoped = a.changed.find((c: { name: string }) => c.name.includes("typed.py"));
    expect(scoped?.changeKind).toBe("module-scope");
    expect(scoped?.typeOnly).toBe(true);
    // The type-only edit must not seed runtime propagation.
    const runtimeNames = [...a.direct, ...a.transitive].map((s: { file: string }) => s.file);
    expect(runtimeNames.every((f) => !f.includes("models.py"))).toBe(true);
  });

  test("deleted python function produces a tombstone with former callers", async ({ page }) => {
    const a = await analysis(page, base);
    const del = a.deleted.find((d: { name: string }) => d.name === "orphan");
    expect(del?.file).toBe("api/pkg/store.py");
    expect(del?.resolved).toBe(true);
    expect(del?.formerCallers.map((c: { name: string }) => c.name)).toContain("handler()");
  });
});

test.describe("mixed typescript+python explorer", () => {
  let mixed: RunningExplorer | undefined;
  test.beforeAll(() => {
    buildMixedRepo();
  });
  test.afterAll(async () => {
    await mixed?.close();
  });

  test("both language families coexist without cross-language edges", async ({ page }) => {
    // Dirty one symbol per language so both appear in one analysis.
    write(
      MIXED_REPO,
      "backend/pkg/store.py",
      "def save(x):\n    return str(x)\n\n\ndef format(x):\n    return str(x)\n",
    );
    write(
      MIXED_REPO,
      "frontend/src/fmt.ts",
      "export function format(x: string): string {\n  return x.trim().toUpperCase();\n}\n",
    );
    mixed = await startExplorer({ repo: MIXED_REPO, base: "HEAD", port: 0 });
    await openExplorer(page, `http://127.0.0.1:${mixed.port}`);
    const a = await analysis(page, `http://127.0.0.1:${mixed.port}`);
    const changed = a.changed.map((c: { name: string; file: string }) => `${c.name}@${c.file}`).sort();
    expect(changed).toContain("save()@backend/pkg/store.py");
    expect(changed).toContain("format()@frontend/src/fmt.ts");
    const direct = a.direct.map((s: { name: string; file: string }) => `${s.name}@${s.file}`).sort();
    // Each handler is impacted only through its own language family —
    // the identically-named foreign symbols never bridge.
    expect(direct).toContain("handler()@backend/pkg/api.py");
    expect(direct).toContain("handler()@frontend/src/app.ts");
  });
});

test.describe("python live re-analysis", () => {
  let live: RunningExplorer | undefined;
  test.afterAll(async () => {
    await live?.close();
    if (existsSync(PY_REPO)) git(PY_REPO, "checkout", "-qf", "HEAD", "--", "api/pkg/typed.py");
  });

  test("editing a .py file refreshes the analysis", async ({ page }) => {
    live = await startExplorer({ repo: PY_REPO, base: "HEAD", port: 0, watch: true });
    const liveBase = `http://127.0.0.1:${live.port}`;
    await openExplorer(page, liveBase);
    const before = await analysis(page, liveBase);
    const beforeNames = before.changed.map((c: { name: string }) => c.name).join();
    write(
      PY_REPO,
      "api/pkg/typed.py",
      "from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from .models import User\n\n\ndef f(u: \"User\") -> \"User\":\n    return u\n\n\ndef added_fn():\n    return 1\n",
    );
    let a;
    await expect
      .poll(
        async () => {
          a = await analysis(page, liveBase);
          return a.changed.map((c: { name: string }) => c.name).join();
        },
        { timeout: 30_000 },
      )
      .not.toBe(beforeNames);
    expect(a!.changed.map((c: { name: string }) => c.name)).toContain("added_fn()");
  });
});
