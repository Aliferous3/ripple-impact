import { expect, test, type Page } from "@playwright/test";

/**
 * Cascade explorer e2e — runs against scripts/e2e-server.ts:
 * tmp/git-scenarios @ s15-import-only, base s0-base, plus an untracked binary
 * file (BINARY_SKIPPED warning). Expected: changed + deleted + direct +
 * transitive + test tiers all present.
 */

async function analysis(page: Page) {
  const res = await page.request.get("/api/analysis");
  expect(res.ok()).toBe(true);
  return res.json();
}

async function openExplorer(page: Page) {
  await page.goto("/");
  await page.waitForSelector(".row-btn, .refs-collapsed, .cluster-btn, .cascade-empty", {
    timeout: 30_000,
  });
  // Let the depth-staggered unfold finish.
  await page.waitForTimeout(1500);
}

test.beforeEach(async ({ page }) => {
  await openExplorer(page);
});

test("tier rail counts match the engine's AnalysisResult", async ({ page }) => {
  const a = await analysis(page);
  const railCount = (tier: string) =>
    page.locator(".rail-tier", { hasText: tier }).locator(".rail-count");
  // Deleted changed symbols live in the DELETED tier, not CHANGED.
  const nonDeletedChanged = a.changed.filter(
    (c: { changeKind: string }) => c.changeKind !== "deleted",
  ).length;
  await expect(railCount("CHANGED")).toHaveText(String(nonDeletedChanged));
  if (a.deleted.length)
    await expect(railCount("DELETED")).toHaveText(String(a.deleted.length));
  await expect(railCount("DIRECT")).toHaveText(String(a.direct.length));
  await expect(railCount("TRANSITIVE")).toHaveText(String(a.transitive.length));
  if (a.typeImpact.length)
    await expect(railCount("TYPE-AFFECTED")).toHaveText(String(a.typeImpact.length));
  if (a.tests.length) await expect(railCount("TESTS")).toHaveText(String(a.tests.length));
  if (a.warnings.length)
    expect(await page.locator(".rail-warns .warnchip").count()).toBeGreaterThan(0);
});

test("tiers render as a causal document", async ({ page }) => {
  const a = await analysis(page);
  await expect(page.getByTestId("tier-changed")).toBeVisible();
  // Tier header carries count + note + rule.
  await expect(
    page.getByTestId("tier-changed").locator(".tier-head"),
  ).toContainText("CHANGED");
  const order = await page.locator(".tier").evaluateAll((els) =>
    els.map((el) => el.id),
  );
  // Causal ordering: changed first, references last.
  expect(order[0]).toBe("tier-changed");
  if (a.referencing.length)
    expect(order[order.length - 1]).toBe("tier-references");
  // Tree-branch glyph syntax is present.
  await expect(page.locator(".branch").first()).toContainText(/[├└]──/);
});

test("references are collapsed by default and expand on request", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.referencing.length === 0, "no referencing nodes in fixture");
  const refs = page.getByTestId("tier-references");
  const collapsed = refs.locator(".refs-collapsed");
  await expect(collapsed).toContainText("impact not proven");
  expect(await refs.locator(".row-btn").count()).toBe(0);
  // Referencing ids already proven elsewhere are deduped, so the tier may
  // hold fewer rows than `referencing` — but the collapsed label count must
  // equal the expanded row count.
  const collapsedText = await collapsed.textContent();
  const shown = Number(collapsedText!.match(/(\d+) related/)?.[1]);
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThanOrEqual(a.referencing.length);
  await refs.getByTestId("refs-show").click();
  expect(await refs.locator(".row-btn").count()).toBe(shown);
});

test("WHY AFFECTED: expanding a direct row shows evidence path inline", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.direct.length === 0, "no direct nodes in fixture");
  const target = a.direct[0];
  await page.locator('[data-testid="row-direct"] .row-btn').first().click();
  const why = page.locator(".why").first();
  await expect(why).toBeVisible();
  await expect(why).toContainText(/WHY (IS .+ )?AFFECTED|WHY/i);
  // Evidence path carries real relationship names + file:line.
  await expect(why.locator(".pathchain").first()).toBeVisible();
  await expect(why).toContainText(/calls|jsx_uses|type_depends|imports|references/);
});

test("WHY CHANGED: expanding a changed row shows diff + source", async ({ page }) => {
  const a = await analysis(page);
  const changed = a.changed.find((c: { changeKind: string }) => c.changeKind !== "deleted");
  test.skip(!changed, "no non-deleted changed symbol");
  await page
    .locator('[data-testid="row-changed"] .row-btn', { hasText: changed.name })
    .first()
    .click();
  const why = page.locator(".why").first();
  await expect(why).toContainText(/WHY (RIPPLE THINKS THIS )?CHANGED|WHY/i);
  await expect(why.locator(".diffbox, .codebox").first()).toBeVisible({ timeout: 10_000 });
});

test("deleted tier exposes former callers", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.deleted.length === 0, "no deleted symbols in fixture");
  await page.locator('[data-testid="row-deleted"] .row-btn').first().click();
  const why = page.locator(".why").first();
  await expect(why).toContainText(/DELETED|no longer exists/i);
  if (a.deleted[0].formerCallers.length > 0) {
    await expect(why).toContainText(/FORMER CALLER|former caller/i);
  }
});

test("filter narrows rows and updates counts", async ({ page }) => {
  const a = await analysis(page);
  const all = [...a.direct, ...a.transitive, ...a.changed].find((n) => n.name);
  test.skip(!all, "no filterable symbols");
  const needle = all.name.replace(/\(\)$/, "").slice(0, 6).toLowerCase();
  await page.getByTestId("filter-input").fill(needle);
  await expect(page.getByTestId("filter-count")).toContainText(/\d+ rows/);
  const names = await page.locator(".row-label").allTextContents();
  expect(names.length).toBeGreaterThan(0);
  for (const n of names) {
    const row = page.locator(".row-btn", { hasText: n }).first();
    const text = await row.textContent();
    expect(text!.toLowerCase()).toContain(needle);
  }
  await page.locator(".filter-clear").click();
  await page.waitForTimeout(200);
});

test("depth control hides deeper transitive rows", async ({ page }) => {
  const a = await analysis(page);
  const deep = a.transitive.filter((t: { depth?: number }) => (t.depth ?? 0) > 1);
  test.skip(deep.length === 0, "no depth>1 transitive nodes in fixture");
  const before = await page.locator('[data-testid="row-transitive"]').count();
  await page.getByTestId("depth-1").click();
  await page.waitForTimeout(300);
  expect(await page.locator('[data-testid="row-transitive"]').count()).toBeLessThan(before);
  await page.getByTestId("depth-all").click();
});

test("warnings render as rail chips, not just console", async ({ page }) => {
  const a = await analysis(page);
  expect(a.warnings.length).toBeGreaterThan(0); // fixture includes a binary file
  const chips = page.locator(".rail-warns .warnchip");
  expect(await chips.count()).toBe(a.warnings.length);
  await expect(chips.first()).toContainText(/BINARY_SKIPPED|NOT_INDEXED/);
});

test("tests tier lists relevant tests as cascade rows", async ({ page }) => {
  const a = await analysis(page);
  test.skip(a.tests.length === 0, "no relevant tests");
  const rows = page.locator('[data-testid="row-tests"]');
  expect(await rows.count()).toBe(a.tests.length);
  await rows.first().locator(".row-btn").click();
  await expect(page.locator(".why").first()).toContainText(/TEST|test/);
});

test("keyboard: '/' focuses filter, Escape clears", async ({ page }) => {
  await page.keyboard.press("/");
  await expect(page.getByTestId("filter-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.locator(".row-btn").first().click();
  await page.locator(".why").first().waitFor();
  await page.keyboard.press("Escape");
  expect(await page.locator(".why").count()).toBe(0);
});

test("deep link: expanded row survives reload via URL hash", async ({ page }) => {
  const a = await analysis(page);
  const changed = a.changed.find((c: { id?: string }) => c.id);
  test.skip(!changed, "no node-backed changed symbol");
  await page
    .locator('[data-testid="row-changed"] .row-btn', { hasText: changed.name })
    .first()
    .click();
  const hash = await page.evaluate(() => location.hash);
  expect(hash).toContain("n=");
  await page.reload();
  await page.waitForSelector(".row-btn", { timeout: 30_000 });
  await expect(page.locator(".why").first()).toBeVisible({ timeout: 10_000 });
});

test("multi-root provenance lists every causal root", async ({ page }) => {
  const a = await analysis(page);
  const multi = [...a.direct, ...a.transitive].find(
    (n: { roots: string[] }) => n.roots.length > 1,
  );
  test.skip(!multi, "no multi-root node in this fixture");
  await page.locator(".row-btn", { hasText: multi.name }).first().click();
  const why = page.locator(".why").first();
  await expect(why).toContainText(/causal root|EVIDENCE PATH/i);
  expect(await why.locator(".pathwrap").count()).toBeGreaterThan(1);
});

test("collapse all closes every open WHY", async ({ page }) => {
  const rows = page.locator(".row-btn");
  if ((await rows.count()) < 2) test.skip();
  await rows.nth(0).click();
  await rows.nth(1).click();
  expect(await page.locator(".why").count()).toBeGreaterThanOrEqual(2);
  await page.getByTestId("collapse-all").click();
  expect(await page.locator(".why").count()).toBe(0);
});
