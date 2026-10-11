import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const FIXTURE = resolve("tmp/git-scenarios");
const SHOTS = resolve("tmp/responsive-shots");
const fixtureGit = (...args: string[]) =>
  execFileSync("git", ["-C", FIXTURE, ...args], { encoding: "utf8", windowsHide: true });
const breakTsconfig = () =>
  writeFileSync(join(FIXTURE, "tsconfig.json"), "{ invalid json");
const restoreTsconfig = () => fixtureGit("checkout", "--", "tsconfig.json");

const reDirtyFixture = () => {
  fixtureGit("checkout", "-qf", "s15-import-only");
  mkdirSync(join(FIXTURE, "assets"), { recursive: true });
  writeFileSync(
    join(FIXTURE, "assets", "logo.bin"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
  );
  writeFileSync(
    join(FIXTURE, "src", "session.ts"),
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
};

/**
 * Responsive hardening e2e — Design #33 specimen explorer across
 * mobile / tablet / laptop / desktop viewports. Runs against the same
 * deterministic server as explorer.spec.ts.
 */

async function openExplorer(page: Page) {
  await page.goto("/");
  await page.waitForSelector('[data-testid="rail-plate"], .spec-empty', {
    timeout: 30_000,
  });
  await page.waitForSelector(".preloader", { state: "detached", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/** The page itself must never scroll horizontally. */
async function expectNoHOverflow(page: Page) {
  const dims = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(dims.sw).toBeLessThanOrEqual(dims.cw);
}

async function railBox(page: Page) {
  const box = await page.locator(".rail").boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

const shot = async (page: Page, name: string) =>
  page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });

/* ================= 390 x 844 — mobile drawer ================= */

test("mobile 390x844: no overflow, rail is an off-canvas drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openExplorer(page);
  await expectNoHOverflow(page);

  // Menu trigger exists; rail parked off-canvas.
  await expect(page.getByTestId("rail-open")).toBeVisible();
  const closed = await railBox(page);
  expect(closed.x + closed.width).toBeLessThanOrEqual(4);
  await shot(page, "390x844-closed");

  // Open drawer: scrim + on-canvas rail + close control.
  await page.getByTestId("rail-open").click();
  await expect(page.locator(".rail")).toHaveClass(/open/);
  await page.waitForTimeout(400); // slide-in transition
  const open = await railBox(page);
  expect(open.x).toBeGreaterThanOrEqual(-1);
  await expect(page.locator(".rail-scrim")).toBeVisible();
  await expect(page.getByTestId("rail-close")).toBeVisible();
  await expect(page.getByTestId("rail-search")).toBeVisible();
  await shot(page, "390x844-drawer");

  // Selecting a specimen closes the drawer and updates the plate.
  const items = page.locator('[data-testid="rail-plate"]');
  const before = await page.getByTestId("plate-title").textContent();
  await items.nth(1).click();
  await page.waitForTimeout(500);
  await expect(page.locator(".rail")).not.toHaveClass(/open/);
  expect(await page.getByTestId("plate-title").textContent()).not.toBe(before);
  await expectNoHOverflow(page);
});

test("mobile 390x844: sticky bottom nav, WHY, source panel, tabs", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openExplorer(page);

  // Sticky prev/next paging.
  await expect(page.getByTestId("mnav-prev")).toBeVisible();
  await expect(page.getByTestId("mnav-next")).toBeVisible();
  const first = await page.getByTestId("plate-title").textContent();
  await page.getByTestId("mnav-next").click();
  await page.waitForTimeout(450);
  expect(await page.getByTestId("plate-title").textContent()).not.toBe(first);
  await page.getByTestId("mnav-prev").click();
  await page.waitForTimeout(450);
  expect(await page.getByTestId("plate-title").textContent()).toBe(first);

  // WHY expands without overflow.
  await page.getByTestId("why-toggle").click();
  await expect(page.getByTestId("why-body")).toHaveClass(/open/);
  await expectNoHOverflow(page);
  await shot(page, "390x844-why");

  // Source panel renders real lines, page still does not scroll sideways.
  await expect(page.getByTestId("source-preview")).toBeVisible();
  await expect(page.locator(".srcbox-line").first()).toBeVisible();
  await expectNoHOverflow(page);

  // Category tabs reachable in the secondary scroll row.
  await expect(page.locator(".topbar-tabs")).toBeVisible();
  const a = await page.request.get("/api/analysis").then((r) => r.json());
  if (a.direct.length > 0) {
    await page.locator(".topbar-tab", { hasText: "DIRECT" }).click();
    await page.waitForTimeout(250);
    await page.getByTestId("rail-open").click();
    const cats = await page.locator('[data-testid="rail-plate"] .rail-cat').allTextContents();
    for (const c of cats) expect(c).toMatch(/DIRECT/);
    await page.getByTestId("rail-close").click();
    await page.locator(".topbar-tab", { hasText: "ALL" }).click();
  }
});

test("mobile 390x844: long titles and metadata stay inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openExplorer(page);
  // Step through every plate — title + meta cells must not escape the page.
  const count = await page.locator('[data-testid="rail-plate"]').count();
  for (let i = 0; i < Math.min(count, 12); i++) {
    await page.getByTestId("mnav-next").click();
    await page.waitForTimeout(300);
    await expectNoHOverflow(page);
    const t = await page.getByTestId("plate-title").boundingBox();
    if (t) expect(t.x + t.width).toBeLessThanOrEqual(392);
  }
});

/* ================= small-phone overflow sweeps ================= */

for (const [w, h] of [
  [375, 667],
  [430, 932],
] as const) {
  test(`mobile ${w}x${h}: no horizontal overflow through nav + WHY`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openExplorer(page);
    await expectNoHOverflow(page);
    await shot(page, `${w}x${h}`);
    await page.getByTestId("why-toggle").click();
    await expect(page.getByTestId("why-body")).toHaveClass(/open/);
    await expectNoHOverflow(page);
    await page.getByTestId("mnav-next").click();
    await page.waitForTimeout(400);
    await expectNoHOverflow(page);
    // Drawer flow still works.
    await page.getByTestId("rail-open").click();
    await expect(page.locator(".rail")).toHaveClass(/open/);
    await shot(page, `${w}x${h}-drawer`);
    await page.getByTestId("rail-close").click();
    await expect(page.locator(".rail")).not.toHaveClass(/open/);
  });
}

/* ================= 768 x 1024 — tablet ================= */

test("tablet 768x1024: narrow in-flow rail, stacked plate, no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await openExplorer(page);
  await expectNoHOverflow(page);

  // Rail is back in the flex flow at the reduced tablet width.
  const box = await railBox(page);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.width).toBeGreaterThanOrEqual(220);
  expect(box.width).toBeLessThanOrEqual(248);
  await expect(page.getByTestId("rail-open")).not.toBeVisible();
  await expect(page.getByTestId("mnav-next")).not.toBeVisible();
  await shot(page, "768x1024");

  // WHY + source stack vertically, still no overflow.
  await page.getByTestId("why-toggle").click();
  await expect(page.getByTestId("why-body")).toHaveClass(/open/);
  await expectNoHOverflow(page);
});

/* ================= 1024 x 768 — small laptop ================= */

test("laptop 1024x768: 272px rail, two-column plate, no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openExplorer(page);
  await expectNoHOverflow(page);
  const box = await railBox(page);
  expect(box.width).toBeGreaterThanOrEqual(260);
  expect(box.width).toBeLessThanOrEqual(284);
  await expect(page.getByTestId("plate-title")).toBeVisible();
  await expect(page.getByTestId("source-preview")).toBeVisible();
  await shot(page, "1024x768");
});

/* ================= 1366 x 768 / 1440 x 900 / 1920 x 1080 — desktop ================= */

for (const [w, h, railW] of [
  [1366, 768, 348],
  [1440, 900, 348],
  [1920, 1080, 348],
] as const) {
  test(`desktop ${w}x${h}: full rail, identity preserved, no overflow`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openExplorer(page);
    await expectNoHOverflow(page);
    const box = await railBox(page);
    // content-box: 348px + 1px border-right = 349 effective.
    expect(box.width).toBe(railW + 1);
    // Desktop topbar: one row, tagline + plate count visible.
    await expect(page.locator(".topbar-tagline")).toBeVisible();
    await expect(page.getByTestId("rail-open")).not.toBeVisible();
    const topbar = await page.locator(".topbar").boundingBox();
    // 72px row + 1px border-bottom (content-box) — unchanged from before.
    expect(topbar!.height).toBe(73);
    await shot(page, `${w}x${h}`);
  });
}

/* ================= empty state at mobile ================= */

test("mobile 390x844: empty state renders without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const real = await page.request.get("/api/analysis").then((r) => r.json());
  const empty = {
    ...real,
    changed: [],
    deleted: [],
    direct: [],
    transitive: [],
    referencing: [],
    tests: [],
    typeImpact: { direct: [], transitive: [] },
  };
  await page.route("**/api/analysis", (route) => route.fulfill({ json: empty }));
  await page.goto("/");
  await page.waitForSelector(".spec-empty", { timeout: 30_000 });
  await page.waitForSelector(".preloader", { state: "detached", timeout: 15_000 }).catch(() => {});
  await expect(page.locator(".spec-empty-title")).toContainText("No change surface");
  await expectNoHOverflow(page);
  await shot(page, "390x844-empty");
});

/* ================= interrupted state at mobile ================= */

test("mobile 390x844: ANALYSIS INTERRUPTED strip fits the viewport", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openExplorer(page);
  try {
    breakTsconfig();
    const strip = page.getByTestId("fail-strip");
    await expect(strip).toBeVisible({ timeout: 45_000 });
    await expect(strip).toContainText("ANALYSIS INTERRUPTED");
    await expectNoHOverflow(page);
    const s = await strip.boundingBox();
    expect(s!.x + s!.width).toBeLessThanOrEqual(392);
    await shot(page, "390x844-interrupted");
  } finally {
    restoreTsconfig();
  }
  await expect(page.getByTestId("fail-strip")).not.toBeVisible({ timeout: 60_000 });
});

/* Mutation above must leave the fixture populated for later files. */
test.afterAll(() => {
  try {
    restoreTsconfig();
    reDirtyFixture();
  } catch {
    /* fixture already populated */
  }
});
