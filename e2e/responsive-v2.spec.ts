import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const FIXTURE = resolve("tmp/git-scenarios");
const SHOTS = resolve("tmp/responsive-v2-shots");
const fixtureGit = (...args: string[]) =>
  execFileSync("git", ["-C", FIXTURE, ...args], { encoding: "utf8", windowsHide: true });
const restoreTsconfig = () => fixtureGit("checkout", "--", "tsconfig.json");
const breakTsconfig = () =>
  writeFileSync(join(FIXTURE, "tsconfig.json"), "{ invalid json");

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
 * Responsive V2 — the no-clipping pass. The page may never produce a
 * horizontal scrollbar check alone: ancestors can silently amputate
 * controls via overflow. Every assertion below walks the DOM and verifies
 * that visible interactive/panel elements are fully inside the viewport
 * and not clipped by any non-sanctioned ancestor.
 */

async function openExplorer(page: Page) {
  await page.goto("/");
  await page.waitForSelector('[data-testid="rail-plate"], .spec-empty', {
    timeout: 30_000,
  });
  await page.waitForSelector(".preloader", { state: "detached", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
}

/** Every 40px 320–1920, plus awkward widths that straddle transitions. */
const SWEEP_WIDTHS: number[] = [];
for (let w = 320; w <= 1920; w += 40) SWEEP_WIDTHS.push(w);
SWEEP_WIDTHS.push(347, 413, 563, 719, 799, 917, 1087, 1199, 1279, 1317, 1433, 1591);
SWEEP_WIDTHS.sort((a, b) => a - b);
const SWEEP_HEIGHTS = [667, 768, 844, 900, 1080];

const LONG_PATH = "python-service/demo_service/very/deeply/nested/checkout.py";
const LONG_NAME =
  "VeryLongGeneratedApplicationServiceFactoryConfigurationHandler";

/**
 * In-page clip detector. Returns a list of violations for visible
 * interactive/important elements clipped by the viewport or a
 * non-sanctioned ancestor.
 */
async function collectViolations(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Horizontal scrolling is only sanctioned inside these.
    const X_OK = ".topbar-tabs, .srcbox-body, .srcbox-code, .diffbox-body";
    // Vertical scroll containers — content below the fold is reachable.
    const Y_OK = ".spec-main, .rail-list, .srcbox-body, .diffbox-body";
    const SELECTOR =
      "button, input, a[href], [role='button'], [role='tab'], " +
      ".topbar-watch, .srcbox, .srcbox-head, .srcbox-foot, .failstrip, " +
      ".spec-mobilenav, .plate-meta, .plate-nav, .why-btn, .topbar, " +
      ".rail-head, .rail-search, .plate-title";
    const out: any[] = [];
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}.${[...el.classList].filter((c) => !c.startsWith("a-")).slice(0, 2).join(".")} "${(el.textContent || "").trim().slice(0, 34)}"`;

    for (const el of document.querySelectorAll(SELECTOR)) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (r.width < 2 || r.height < 2) continue;
      if (el.closest(".why-body:not(.open)")) continue; // collapsed accordion
      const inParkedRail = el.closest(".rail:not(.open)");
      if (inParkedRail && vw < 768) continue; // parked drawer
      if (r.right <= 0 || r.left >= vw) continue; // fully offscreen

      // Walk ancestors — first horizontal clipper decides.
      let sanctionedX = false;
      let xViolator: string | null = null;
      for (let cur = el.parentElement; cur; cur = cur.parentElement) {
        const o = getComputedStyle(cur).overflowX;
        if (o === "visible") continue;
        if (cur.matches(X_OK)) {
          sanctionedX = true;
          break;
        }
        const cr = cur.getBoundingClientRect();
        if (r.left < cr.left - 1 || r.right > cr.right + 1) xViolator = name(cur);
        break;
      }
      if (!sanctionedX) {
        if (xViolator || r.left < -1 || r.right > vw + 1) {
          out.push({ el: name(el), kind: "x", v: xViolator ?? "viewport", l: +r.left.toFixed(1), r: +r.right.toFixed(1), vw });
          continue;
        }
      }

      // Vertical: only elements intersecting the viewport vertically.
      if (r.top < vh && r.bottom > 0) {
        for (let cur = el.parentElement; cur; cur = cur.parentElement) {
          const o = getComputedStyle(cur).overflowY;
          if (o === "visible") continue;
          if (cur.matches(Y_OK)) break; // scroll-reachable
          const cr = cur.getBoundingClientRect();
          if (r.top < cr.top - 1 || r.bottom > cr.bottom + 1) {
            out.push({ el: name(el), kind: "y", v: name(cur), t: +r.top.toFixed(1), b: +r.bottom.toFixed(1) });
          }
          break;
        }
      }
    }
    return out;
  });
}

const shot = async (page: Page, name: string) =>
  page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });

/* ================= arbitrary-width sweep ================= */

test("sweep 320→1920: no clipped controls, no page overflow, state survives live resize", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await openExplorer(page);
  // Long real-world values before the sweep.
  await page.evaluate(
    ({ LONG_PATH, LONG_NAME }) => {
      const f = document.querySelector(".srcbox-file");
      if (f) f.textContent = LONG_PATH;
      const t = document.querySelector('[data-testid="plate-title"]');
      if (t) t.textContent = LONG_NAME;
    },
    { LONG_PATH, LONG_NAME },
  );

  const allViolations: any[] = [];
  const titleBefore = await page.getByTestId("plate-title").textContent();

  // 1920 → 320 (down sweep), then 320 → 1920 (up sweep), cycling heights.
  const down = [...SWEEP_WIDTHS].reverse();
  const up = SWEEP_WIDTHS;
  let i = 0;
  for (const w of [...down, ...up]) {
    const h = SWEEP_HEIGHTS[i++ % SWEEP_HEIGHTS.length];
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(380); // drawer/transform transitions settle
    const v = await collectViolations(page);
    for (const x of v) allViolations.push({ w, h, ...x });
    // document itself may never gain a horizontal scrollbar
    const dims = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    if (dims.sw > dims.cw) allViolations.push({ w, h, el: "document", kind: "page-x" });
  }

  // Selection survived the whole live resize without reload.
  expect(await page.getByTestId("plate-title").textContent()).toBe(titleBefore);
  expect(errors).toEqual([]);
  expect(allViolations).toEqual([]);
});

/* ================= drawer-open sweep (mobile widths) ================= */

test("sweep: open drawer keeps every control inside the viewport", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await openExplorer(page);
  const bad: any[] = [];
  for (const w of [320, 347, 375, 413, 480, 563, 640, 719, 767]) {
    await page.setViewportSize({ width: w, height: 844 });
    await page.getByTestId("rail-open").click();
    await page.waitForTimeout(450);
    const v = await collectViolations(page);
    for (const x of v) bad.push({ w, ...x });
    await page.getByTestId("rail-close").click();
    await page.waitForTimeout(450);
  }
  expect(bad).toEqual([]);
});

/* ================= WHY-open sweep ================= */

test("sweep: WHY expanded keeps controls visible at every width", async ({ page }) => {
  test.setTimeout(120_000);
  await openExplorer(page);
  await page.evaluate((p) => {
    const f = document.querySelector(".srcbox-file");
    if (f) f.textContent = p;
  }, LONG_PATH);
  await page.getByTestId("why-toggle").click();
  await expect(page.getByTestId("why-body")).toHaveClass(/open/);
  const bad: any[] = [];
  for (const w of [320, 390, 563, 719, 767, 799, 917, 1024, 1199, 1317, 1591, 1920]) {
    const h = SWEEP_HEIGHTS[w % SWEEP_HEIGHTS.length];
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(380);
    const v = await collectViolations(page);
    for (const x of v) bad.push({ w, h, ...x });
  }
  expect(bad).toEqual([]);
});

/* ================= the recorded COPY failure ================= */

test("COPY button: fully inside srcbox + viewport at every width (incl. long paths)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openExplorer(page);
  await page.evaluate((p) => {
    const f = document.querySelector(".srcbox-file");
    if (f) f.textContent = p;
  }, LONG_PATH);

  const bad: any[] = [];
  for (let w = 320; w <= 1920; w += 20) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(60);
    const r = await page.evaluate(() => {
      const c = document.querySelector(".srcbox-copy");
      const b = document.querySelector(".srcbox");
      if (!c || !b) return null;
      const cr = c.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const cs = getComputedStyle(c);
      const visible = cs.display !== "none" && cr.width > 1;
      return { vw: innerWidth, visible, cl: cr.left, cr: cr.right, br: br.right };
    });
    if (r?.visible && (r.cr > r.br + 1 || r.cr > r.vw + 1))
      bad.push({ w: r.vw, copyRight: Math.round(r.cr), boxRight: Math.round(r.br) });
  }
  expect(bad).toEqual([]);
});

/* ================= §15 — repro pair at recording-window size ================= */

test("repro: plate-wrap content-box regression clips COPY; fix removes it", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  await openExplorer(page);
  await page.evaluate((p) => {
    const f = document.querySelector(".srcbox-file");
    if (f) f.textContent = p;
  }, LONG_PATH);

  // Simulate the pre-fix rule to prove the failure class existed.
  await page.addStyleTag({
    content: ".spec-plate-wrap { box-sizing: content-box !important; max-width: 1320px !important; }",
  });
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => {
    const c = document.querySelector(".srcbox-copy")!.getBoundingClientRect();
    const main = document.querySelector(".spec-main")!.getBoundingClientRect();
    return { copyR: c.right, mainR: main.right, clipped: c.right > main.right + 1 };
  });
  expect(before.clipped).toBe(true); // the bug reproduced
  await shot(page, "repro-copy-clipped-1180");

  // Remove the simulated rule — current CSS must keep COPY inside.
  await page.evaluate(() => {
    document.querySelectorAll("style").forEach((s) => {
      if (s.textContent?.includes("content-box !important")) s.remove();
    });
  });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const c = document.querySelector(".srcbox-copy")!.getBoundingClientRect();
    const b = document.querySelector(".srcbox")!.getBoundingClientRect();
    const main = document.querySelector(".spec-main")!.getBoundingClientRect();
    return { copyR: c.right, boxR: b.right, mainR: main.right };
  });
  expect(after.copyR).toBeLessThanOrEqual(after.boxR + 1);
  expect(after.copyR).toBeLessThanOrEqual(after.mainR + 1);
  await shot(page, "repro-copy-fixed-1180");
});

/* ================= short heights ================= */

for (const [w, h] of [
  [1366, 600],
  [1280, 640],
  [1024, 600],
  [390, 667],
] as const) {
  test(`short height ${w}x${h}: controls reachable, nothing clipped`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openExplorer(page);
    expect(await collectViolations(page)).toEqual([]);
    // Reach the bottom of the plate — nav controls must exist & be usable.
    await page.locator(".spec-main").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(300);
    expect(await collectViolations(page)).toEqual([]);
    const next = page.locator(
      w < 768 ? '[data-testid="mnav-next"]' : '[data-testid="next-plate"]',
    );
    await expect(next).toBeVisible();
    await shot(page, `${w}x${h}-short`);
  });
}

/* ================= required screenshot matrix ================= */

const SHOT_WIDTHS = [
  320, 375, 390, 430, 480, 600, 720, 767, 768, 850, 900, 960, 1023, 1024,
  1100, 1180, 1240, 1280, 1366, 1440, 1600, 1920,
];
test("screenshot matrix at all representative widths", async ({ page }) => {
  test.setTimeout(180_000);
  await openExplorer(page);
  let i = 0;
  for (const w of SHOT_WIDTHS) {
    const h = [900, 844, 768][i++ % 3];
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(380);
    await shot(page, `${w}x${h}`);
    expect(await collectViolations(page)).toEqual([]);
  }
});

/* ================= interrupted state sweep ================= */

test("mobile interrupted strip survives narrow widths", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 375, height: 667 });
  await openExplorer(page);
  try {
    breakTsconfig();
    await expect(page.getByTestId("fail-strip")).toBeVisible({ timeout: 45_000 });
    for (const w of [320, 375, 480, 720]) {
      await page.setViewportSize({ width: w, height: 700 });
      await page.waitForTimeout(350);
      expect(await collectViolations(page)).toEqual([]);
    }
    await shot(page, "320x700-interrupted");
  } finally {
    restoreTsconfig();
  }
  await expect(page.getByTestId("fail-strip")).not.toBeVisible({ timeout: 60_000 });
});

test.afterAll(() => {
  try {
    restoreTsconfig();
    reDirtyFixture();
  } catch {
    /* fixture already populated */
  }
});
