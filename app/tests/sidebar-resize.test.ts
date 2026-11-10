import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { compile } from "tailwindcss";

/** OPENBOT_APP_BROWSER=1 OPENBOT_BROWSER_CHANNEL=chrome bun test app/tests/sidebar-resize.test.ts */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const APP = join(import.meta.dir, "..");
const ORIGIN = "http://openbot.test";
let browser: Browser;
let script: string;
let css: string;

function packageStylesheet(id: string): string {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = [
    join(APP, "node_modules", name),
    join(APP, "..", "node_modules", name),
  ].find(existsSync);
  if (!dir) throw new Error(`No stylesheet package: ${id}`);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const entry = pkg.exports?.[`.${id.slice(name.length)}`];
  return join(
    dir,
    typeof entry === "string"
      ? entry
      : (entry?.style ?? entry?.default ?? pkg.main ?? "index.css"),
  );
}

beforeAll(async () => {
  if (!asked) return;
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "sidebar-resize.fixture.tsx")],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success)
    throw new AggregateError(built.logs, "Fixture bundle failed");
  script = await built.outputs[0].text();
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({
    channel: process.env.OPENBOT_BROWSER_CHANNEL ?? "chromium",
  });
});
afterAll(async () => {
  await browser?.close();
});

async function open(page: Page) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html data-desktop-titlebar="overlay"><head></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
      });
    if (path === "/fixture.js")
      return route.fulfill({ contentType: "text/javascript", body: script });
    return route.fulfill({ status: 404 });
  });
  await page.goto(ORIGIN);
  await page.getByRole("button", { name: "Account menu" }).waitFor();
  if (!css) {
    const classes = await page.evaluate(() => [
      ...new Set(
        [...document.querySelectorAll("[class]")].flatMap((el) => [
          ...el.classList,
        ]),
      ),
    ]);
    const entry = join(APP, "src", "styles.css");
    const tailwind = dirname(Bun.resolveSync("tailwindcss/package.json", APP));
    const compiler = await compile(readFileSync(entry, "utf8"), {
      base: dirname(entry),
      loadStylesheet: async (id, base) => {
        const path =
          id === "tailwindcss"
            ? join(tailwind, "index.css")
            : id.startsWith(".")
              ? join(base, id)
              : packageStylesheet(id);
        return {
          path,
          base: dirname(path),
          content: readFileSync(path, "utf8"),
        };
      },
    });
    css = compiler.build(classes);
  }
  await page.addStyleTag({ content: css });
}
async function width(page: Page) {
  return page
    .locator('[data-slot="sidebar-container"]')
    .evaluate((el) => el.getBoundingClientRect().width);
}
async function drag(page: Page, delta: number) {
  const rail = page.locator('[data-slot="sidebar-rail"]');
  const box = await rail.boundingBox();
  if (!box) throw new Error("Resize rail missing");
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(50);
}

describe.skipIf(!asked)("sidebar can shrink after it has been widened", () => {
  for (const zoom of [1, 1.25])
    test(`account footer does not lock width at ${zoom * 100}% zoom`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1250, height: 900 },
      });
      try {
        await open(page);
        // Browser zoom reduces the CSS viewport; CSS zoom also scales the actual pointer geometry.
        await page.evaluate((zoom) => {
          document.documentElement.style.zoom = String(zoom);
        }, zoom);
        await drag(page, 600);
        expect(await width(page)).toBeCloseTo(480 * zoom, 0);
        await drag(page, -1000);
        expect(await width(page)).toBeCloseTo(220 * zoom, 0);
        expect(
          await page.evaluate(() =>
            localStorage.getItem("openbot-sidebar-width:app"),
          ),
        ).toBe("220");
        const account = page.getByRole("button", { name: "Account menu" });
        expect(await account.isVisible()).toBe(true);
        const bounds = await account.boundingBox();
        expect(bounds!.width).toBeGreaterThan(150 * zoom);
        await page.reload();
        await page.getByRole("button", { name: "Account menu" }).waitFor();
        await page.addStyleTag({ content: css });
        expect(await width(page)).toBeCloseTo(220, 0);
        // Repeated expansion must not permanently raise the minimum on the next drag.
        await drag(page, 600);
        await drag(page, -1000);
        expect(await width(page)).toBeCloseTo(220, 0);
        const headerPadding = await page
          .locator('[data-slot="sidebar-header"]')
          .evaluate((el) => getComputedStyle(el).paddingLeft);
        expect(headerPadding).toBe("80px");
      } finally {
        await page.close();
      }
    });
});
