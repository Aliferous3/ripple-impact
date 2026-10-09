import { expect, test, type Page } from "@playwright/test";

/**
 * Design #33 specimen explorer e2e — runs against scripts/e2e-server.ts:
 * tmp/git-scenarios @ s15-import-only, base s0-base, plus an untracked binary
 * file (BINARY_SKIPPED warning). Expected: changed + deleted + direct +
 * transitive + test + reference plates all present.
 */

async function analysis(page: Page) {
  const res = await page.request.get("/api/analysis");
  expect(res.ok()).toBe(true);
  return res.json();
}

async function openExplorer(page: Page) {
  await page.goto("/");
  await page.waitForSelector('[data-testid="rail-plate"], .spec-empty', {
    timeout: 30_000,
  });
  // Preloader + entrance settle.
  await page.waitForSelector(".preloader", { state: "detached", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/** Select the first rail plate matching a category label. */
async function selectCategory(page: Page, category: string) {
  const item = page.locator('[data-testid="rail-plate"]', {
    has: page.locator(".rail-cat", { hasText: category }),
  }).first();
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
  await page.waitForTimeout(500);
}

test.beforeEach(async ({ page }) => {
  await openExplorer(page);
});

test("rail lists every plate with number, name, and category", async ({ page }) => {
  const a = await analysis(page);
  const expected =
    a.changed.length +
    a.direct.length +
    a.transitive.length +
    a.typeImpact.direct.length +
    a.typeImpact.transitive.length;
  const items = page.locator('[data-testid="rail-plate"]');
  const n = await items.count();
  // Dedup may shrink the raw sum; the rail must at least cover every changed root.
  expect(n).toBeGreaterThanOrEqual(a.changed.length);
  expect(n).toBeLessThanOrEqual(expected + a.tests.length + a.referencing.length);
  await expect(items.first().locator(".rail-num")).toContainText("01");
  // First plate is a changed root.
  await expect(items.first().locator(".rail-cat")).toContainText(/CHANGED|DELETED/);
});

test("main plate shows the selected specimen's real symbol", async ({ page }) => {
  const a = await analysis(page);
  const changed = a.changed.find((c: { changeKind: string }) => c.changeKind !== "deleted");
  test.skip(!changed, "no non-deleted changed symbol in fixture");
  // Click the rail item carrying this symbol's name — category-first ordering
  // means the first CHANGED row may be a different root.
  const item = page.locator('[data-testid="rail-plate"]', {
    has: page.locator(".rail-name", { hasText: changed.name.replace(/\(\)$/, "") }),
  }).first();
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("plate-title")).toContainText(changed.name.replace(/\(\)$/, ""));
  await expect(page.getByTestId("plate-category")).toContainText("CHANGED");
});

test("plate navigation: rail select, next, and prev", async ({ page }) => {
  const items = page.locator('[data-testid="rail-plate"]');
  if ((await items.count()) < 3) test.skip();
  const first = await page.getByTestId("plate-title").textContent();
  await page.getByTestId("next-plate").click();
  await page.waitForTimeout(450);
  const second = await page.getByTestId("plate-title").textContent();
  expect(second).not.toBe(first);
  await page.getByTestId("prev-plate").click();
  await page.waitForTimeout(450);
  expect(await page.getByTestId("plate-title").textContent()).toBe(first);
});

test("keyboard: arrows step plates, '/' focuses search, Enter toggles WHY", async ({ page }) => {
  const items = page.locator('[data-testid="rail-plate"]');
  if ((await items.count()) < 2) test.skip();
  const first = await page.getByTestId("plate-title").textContent();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(450);
  expect(await page.getByTestId("plate-title").textContent()).not.toBe(first);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(450);
  expect(await page.getByTestId("plate-title").textContent()).toBe(first);

  await page.keyboard.press("/");
  await expect(page.getByTestId("rail-search")).toBeFocused();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("why-body")).toHaveClass(/open/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("why-body")).not.toHaveClass(/open/);
});

test("OPEN WHY on a runtime plate shows the full causal path with real rel labels", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.direct.length + a.transitive.length === 0, "no runtime impact in fixture");
  await selectCategory(page, a.direct.length ? "DIRECT" : "TRANSITIVE");
  await page.getByTestId("why-toggle").click();
  const why = page.getByTestId("why-body");
  await expect(why).toContainText(/WHY/i);
  await expect(why).toContainText(/calls|jsx_uses|type_depends|imports|references/);
  // Path chain exists inside WHY.
  await expect(why.locator(".pathchain").first()).toBeVisible();
});

test("WHY CHANGED shows the git diff and source", async ({ page }) => {
  const a = await analysis(page);
  const changed = a.changed.find((c: { changeKind: string }) => c.changeKind !== "deleted");
  test.skip(!changed, "no non-deleted changed symbol");
  await selectCategory(page, "CHANGED");
  await page.getByTestId("why-toggle").click();
  const why = page.getByTestId("why-body");
  await expect(why.locator('[data-testid="why-title"]')).toContainText(/WHY.*CHANGED/i);
  await expect(why.locator('[data-testid="diff-preview"]').first()).toBeVisible({
    timeout: 10_000,
  });
});

test("source preview renders real source lines with line numbers", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.changed.length === 0, "no changed symbols");
  await expect(page.getByTestId("source-preview")).toBeVisible({ timeout: 10_000 });
  const src = page.getByTestId("source-preview");
  await expect(src.locator(".srcbox-line").first()).toBeVisible({ timeout: 10_000 });
  await expect(src.locator(".srcbox-no").first()).toContainText(/\d+/);
});

test("deleted plate exposes former callers honestly", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.deleted.length === 0, "no deleted symbols in fixture");
  await selectCategory(page, "DELETED");
  await expect(page.getByTestId("plate-category")).toContainText("DELETED");
  await page.getByTestId("why-toggle").click();
  const why = page.getByTestId("why-body");
  await expect(why).toContainText(/DELETED|no longer exists|Removed/i);
  if (a.deleted[0].formerCallers.length > 0)
    await expect(why).toContainText(/FORMER CALLER|former caller/i);
});

test("rail search narrows plates by name and file", async ({ page }) => {
  const a = await analysis(page);
  const all = [...a.direct, ...a.transitive, ...a.changed].find((n) => n.name);
  test.skip(!all, "no filterable symbols");
  const needle = all.name.replace(/\(\)$/, "").slice(0, 6).toLowerCase();
  await page.getByTestId("rail-search").fill(needle);
  await page.waitForTimeout(250);
  const items = page.locator('[data-testid="rail-plate"]');
  expect(await items.count()).toBeGreaterThan(0);
  for (const text of await items.locator(".rail-name").allTextContents())
    expect(text.toLowerCase()).toContain(needle);
  await page.getByTestId("rail-search").fill("");
});

test("category filter tabs restrict the rail", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.direct.length === 0, "no direct plates");
  await page.locator(".topbar-tab", { hasText: "DIRECT" }).click();
  await page.waitForTimeout(250);
  const cats = await page.locator('[data-testid="rail-plate"] .rail-cat').allTextContents();
  expect(cats.length).toBe(a.direct.length);
  for (const c of cats) expect(c).toMatch(/DIRECT/);
  await page.locator(".topbar-tab", { hasText: "ALL" }).click();
});

test("warning chips render and expand to structured detail", async ({ page }) => {
  const a = await analysis(page);
  expect(a.warnings.length).toBeGreaterThan(0); // fixture ships a binary file
  const chips = page.locator('[data-testid="warning-chip"]');
  expect(await chips.count()).toBeGreaterThan(0);
  await chips.first().click();
  await expect(page.locator('[data-testid="warning-detail"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="warning-detail"]').first()).toContainText(
    /BINARY_SKIPPED|NOT_INDEXED|warning|skipped/i,
  );
});

test("test plates are reachable and labeled TEST", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.tests.length === 0, "no relevant tests");
  await selectCategory(page, "TEST");
  await expect(page.getByTestId("plate-category")).toContainText(/TEST/);
  await page.getByTestId("why-toggle").click();
  await expect(page.getByTestId("why-body")).toContainText(/test/i);
});

test("deep link: #n= restores the plate and opens WHY on reload", async ({ page }) => {
  const items = page.locator('[data-testid="rail-plate"]');
  if ((await items.count()) < 2) test.skip();
  await items.nth(1).click();
  await page.waitForTimeout(400);
  const hash = await page.evaluate(() => location.hash);
  expect(hash).toContain("n=");
  const title = await page.getByTestId("plate-title").textContent();
  await page.reload();
  await page.waitForSelector('[data-testid="rail-plate"]', { timeout: 30_000 });
  await page.waitForSelector(".preloader", { state: "detached", timeout: 15_000 }).catch(() => {});
  await expect(page.getByTestId("plate-title")).toHaveText(title ?? "");
  await expect(page.getByTestId("why-body")).toHaveClass(/open/, { timeout: 10_000 });
});

test("watch status and live controls are truthful", async ({ page }) => {
  // The e2e server runs with the filesystem watcher on.
  await expect(page.locator(".topbar-watch")).toContainText(/WATCH|LIVE|IDLE/i);
  await expect(page.locator(".topbar-action")).toBeVisible();
});

test("metadata grid shows only real cells", async ({ page }) => {
  await expect(page.getByTestId("plate-meta")).toBeVisible();
  const meta = page.getByTestId("plate-meta");
  await expect(meta).toContainText(/FILE|RANGE|DEPTH|EVIDENCE|SUBSYSTEM|ROOT|STATUS|RELATION/i);
  // No fabricated metrics.
  await expect(meta).not.toContainText(/AMPLITUDE|CONFIDENCE \d+%|\d+% risk/i);
});
