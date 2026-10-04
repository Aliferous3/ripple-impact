import { expect, test, type Page } from "@playwright/test";

/**
 * Explorer e2e — runs against scripts/e2e-server.ts:
 * tmp/git-scenarios @ s15-import-only, base s0-base, plus an untracked binary
 * file (BINARY_SKIPPED warning). Expected: changed + deleted + direct +
 * transitive + test categories all present.
 */

async function analysis(page: Page) {
  const res = await page.request.get("/api/analysis");
  expect(res.ok()).toBe(true);
  return res.json();
}

async function openExplorer(page: Page) {
  await page.goto("/");
  await page.waitForSelector(".rnode", { timeout: 30_000 });
  // Let the depth-staggered reveal finish.
  await page.waitForTimeout(1500);
}

test.beforeEach(async ({ page }) => {
  await openExplorer(page);
});

test("summary counts match the engine's AnalysisResult", async ({ page }) => {
  const a = await analysis(page);
  await expect(page.getByTestId("count-changed")).toHaveText(String(a.changed.length));
  await expect(page.getByTestId("count-direct")).toHaveText(String(a.direct.length));
  await expect(page.getByTestId("count-transitive")).toHaveText(String(a.transitive.length));
  await expect(page.getByTestId("count-tests")).toHaveText(String(a.tests.length));
  await expect(page.getByTestId("count-warnings")).toHaveText(String(a.warnings.length));
  await expect(page.getByTestId("comparison")).toContainText("working tree");
});

test("node categories render distinctly", async ({ page }) => {
  const a = await analysis(page);
  if (a.changed.length) await expect(page.locator(".rnode.changed").first()).toBeVisible();
  if (a.deleted.length) await expect(page.locator(".rnode.deleted").first()).toBeVisible();
  if (a.direct.length) await expect(page.locator(".rnode.direct").first()).toBeVisible();
  if (a.transitive.length) await expect(page.locator(".rnode.transitive").first()).toBeVisible();
  if (a.tests.length) await expect(page.locator(".rnode.test").first()).toBeVisible();
  // Not color-only: every node carries a text tag chip.
  await expect(page.locator(".rnode .tag").first()).toBeVisible();
});

test("WHY AFFECTED: clicking an affected node shows evidence path", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.direct.length === 0, "no direct nodes in fixture");
  const target = a.direct[0];
  // dispatchEvent: node may be outside the viewport after zoom-floor centering.
  await page.locator(".rnode.direct").first().dispatchEvent("click");
  const details = page.getByTestId("details-panel");
  await expect(details.locator(".sym")).toHaveText(target.name);
  await expect(details).toContainText("Why is");
  const paths = details.getByTestId("why-path");
  expect(await paths.count()).toBeGreaterThan(0);
  // Evidence line carries file:line + source (scip / typescript-ast).
  await expect(paths.first().locator(".evidence-line").first()).toContainText(/src\/.+:\d+ · (scip|typescript-ast)/);
});

test("WHY CHANGED: clicking a changed node shows diff evidence + preview", async ({ page }) => {
  const a = await analysis(page);
  const changed = a.changed.find((c: { changeKind: string }) => c.changeKind !== "deleted");
  test.skip(!changed, "no non-deleted changed symbol");
  await page.locator(`.rnode.changed`, { hasText: changed.name }).first().dispatchEvent("click");
  const details = page.getByTestId("details-panel");
  await expect(details).toContainText("Why Ripple thinks this changed");
  await expect(details.locator(".evidence-line").first()).toBeVisible();
  await expect(details.getByTestId("diff-preview")).toBeVisible();
});

test("deleted symbols render and expose former callers", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.deleted.length === 0, "no deleted symbols in fixture");
  await page.locator(".rnode.deleted").first().dispatchEvent("click");
  const details = page.getByTestId("details-panel");
  await expect(details.locator(".status-chip")).toContainText("DELETED");
  await expect(details).toContainText("no longer exists");
  if (a.deleted[0].formerCallers.length > 0) {
    await expect(details).toContainText("Former callers");
  }
});

test("focus mode dims unrelated nodes and restores", async ({ page }) => {
  const a = await analysis(page);
  const roots = a.changed.filter((c: { changeKind: string }) => c.changeKind !== "deleted");
  test.skip(roots.length < 2, "need ≥2 changed roots to observe dimming");
  await page.locator(".rnode.changed").first().dispatchEvent("click");
  await page.getByTestId("focus-btn").click();
  await expect(page.getByTestId("clear-focus")).toBeVisible();
  expect(await page.locator(".rnode.dim").count()).toBeGreaterThan(0);
  await page.getByTestId("clear-focus").click();
  await page.waitForTimeout(300);
  expect(await page.locator(".rnode.dim").count()).toBe(0);
});

test("category filters only change presentation", async ({ page }) => {
  const before = await page.locator(".rnode").count();
  await page.getByTestId("filter-transitive").click();
  await page.waitForTimeout(400);
  const after = await page.locator(".rnode").count();
  const a = await analysis(page);
  expect(before - after).toBe(Math.min(a.transitive.length, before));
  await page.getByTestId("filter-transitive").click();
});

test("depth control narrows the graph", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.transitive.length === 0, "no transitive nodes in fixture");
  const all = await page.locator(".rnode").count();
  await page.getByTestId("depth-select").selectOption("1");
  await page.waitForTimeout(500);
  const directOnly = await page.locator(".rnode").count();
  expect(directOnly).toBeLessThan(all);
  expect(await page.locator(".rnode.transitive").count()).toBe(0);
});

test("search finds symbols and selects them", async ({ page }) => {
  const a = await analysis(page);
  const any = [...a.direct, ...a.transitive, ...a.changed].find((n) => n.id || n.name);
  test.skip(!any, "no searchable nodes");
  const needle = any.name.replace(/\(\)$/, "").slice(0, 6);
  await page.getByTestId("search-input").fill(needle);
  const results = page.getByTestId("search-results");
  await expect(results).toBeVisible();
  await results.locator(".sr").first().click();
  await expect(page.getByTestId("details-panel").locator(".sym")).not.toBeEmpty();
});

test("tests panel lists relevant tests and opens details", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.tests.length === 0, "no relevant tests");
  const items = page.getByTestId("test-item");
  expect(await items.count()).toBe(a.tests.length);
  await items.first().click();
  await expect(page.getByTestId("details-panel")).toContainText(/TEST|test/);
});

test("warnings render in the sidebar, not just the console", async ({ page }) => {
  const a = await analysis(page);
  expect(a.warnings.length).toBeGreaterThan(0); // fixture includes a binary file
  const items = page.getByTestId("warning-item");
  expect(await items.count()).toBe(a.warnings.length);
  await expect(items.first()).toContainText(/BINARY_SKIPPED|NOT_INDEXED/);
});

test("source preview loads real lines for a node", async ({ page }) => {
  const a = await analysis(page);
  const target = [...a.direct, ...a.changed].find(
    (n: { id?: string; range?: unknown }) => n.id && n.range,
  );
  test.skip(!target, "no node with a source range");
  await page.locator(".rnode", { hasText: target.name }).first().dispatchEvent("click");
  await expect(page.getByTestId("source-preview")).toBeVisible({ timeout: 10_000 });
});

test("keyboard: '/' focuses search, Escape clears selection", async ({ page }) => {
  await page.keyboard.press("/");
  await expect(page.getByTestId("search-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.locator(".rnode").first().dispatchEvent("click");
  await page.getByTestId("details-panel").locator(".sym").waitFor();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("details-panel")).toContainText("Select a node");
});

test("deep link: selected node id survives reload via URL hash", async ({ page }) => {
  const a = await analysis(page);
  const changed = a.changed.find((c: { id?: string }) => c.id);
  test.skip(!changed, "no node-backed changed symbol");
  await page.locator(`.rnode.changed`, { hasText: changed.name }).first().dispatchEvent("click");
  await page.waitForTimeout(300);
  const hash = await page.evaluate(() => location.hash);
  expect(hash).toContain("n=");
  await page.reload();
  await page.waitForSelector(".rnode", { timeout: 30_000 });
  await expect(page.getByTestId("details-panel").locator(".sym")).toHaveText(changed.name);
});

test("multi-root provenance shows all reaching roots", async ({ page }) => {
  const a = await analysis(page);
  const multi = [...a.direct, ...a.transitive].find(
    (n: { roots: string[] }) => n.roots.length > 1,
  );
  test.skip(!multi, "no multi-root node in this fixture");
  await page.locator(".rnode", { hasText: multi.name }).first().dispatchEvent("click");
  expect(await page.getByTestId("why-path").count()).toBeGreaterThan(1);
});
