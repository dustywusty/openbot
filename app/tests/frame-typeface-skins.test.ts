import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";

/** OPENBOT_APP_BROWSER=1 bun test app/tests/frame-typeface-skins.test.ts */
const asked = process.env.OPENBOT_APP_BROWSER === "1";
const read = (name: string) =>
  readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const fontRoot = dirname(
  Bun.resolveSync(
    "@fontsource-variable/atkinson-hyperlegible-next/package.json",
    import.meta.dir,
  ),
);
let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  if (!asked) return;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({
    channel: process.env.OPENBOT_BROWSER_CHANNEL ?? "chromium",
  });
  page = await browser.newPage();
  const font = readFileSync(join(fontRoot, "index.css"), "utf8").replaceAll(
    "./files/",
    "/fonts/",
  );
  const css = `${read("theme.css")}\n${font}\n${read("frame.css")}\n${read("typeface.css").replace(/^@import.*;$/m, "")}`;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (/^\/fonts\/[a-z0-9-]+\.woff2$/.test(path))
        return new Response(Bun.file(join(fontRoot, "files", path.slice(7))));
      return new Response(
        `<!doctype html><html><head><style>${css}</style></head><body>
        <div data-slot="sidebar-wrapper"><aside data-variant="inset"><div data-slot="sidebar-inner"><div data-slot="sidebar-header">OpenBot</div></div></aside><main data-slot="sidebar-inset"><p class="font-sans">Computer 0 O I l 1</p></main></div>
        </body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
});
afterAll(async () => {
  if (!asked) return;
  await browser?.close();
  server?.stop(true);
});

async function appearance(skin: string | null = null, dark = false) {
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.evaluate(
    ({ skin, dark }) => {
      if (skin) document.documentElement.dataset.skin = skin;
      document.documentElement.classList.toggle("dark", dark);
    },
    { skin, dark },
  );
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const style = (selector: string) =>
      getComputedStyle(document.querySelector(selector) as Element);
    return {
      wash: style('[data-slot="sidebar-wrapper"]').backgroundImage,
      blur: style('[data-slot="sidebar-inner"]').backdropFilter,
      sheetShadow: style("main").boxShadow,
      font: style("p").fontFamily,
      loaded: document.fonts.check(
        '16px "Atkinson Hyperlegible Next Variable"',
      ),
    };
  });
}

describe.skipIf(!asked)("released OpenBot appearance in a real browser", () => {
  test("default light and dark OpenBot load Atkinson, glass and the gradient frame", async () => {
    for (const dark of [false, true]) {
      const actual = await appearance(null, dark);
      expect(actual.wash).toContain("radial-gradient");
      expect(actual.blur).toContain("blur(24px)");
      expect(actual.sheetShadow).not.toBe("none");
      expect(actual.font).toContain("Atkinson Hyperlegible Next Variable");
      expect(actual.loaded).toBe(true);
    }
  });

  test("each alternate skin keeps its frame and typeface", async () => {
    for (const skin of ["openduet", "opendots", "openmuse"]) {
      const actual = await appearance(skin);
      expect(actual.wash).toBe("none");
      expect(actual.blur).toBe("none");
      expect(actual.sheetShadow).toBe("none");
      expect(actual.font).not.toContain("Atkinson");
    }
  });

  test("increased contrast removes decorative transparency and gradients", async () => {
    await page.emulateMedia({ contrast: "more" });
    try {
      const actual = await appearance();
      expect(actual.wash).toBe("none");
      expect(actual.blur).toBe("none");
      expect(actual.font).toContain("Atkinson");
    } finally {
      await page.emulateMedia({ contrast: "no-preference" });
    }
  });

  test("reduced transparency removes the glass and wash", async () => {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
    });
    try {
      const actual = await appearance();
      expect(actual.wash).toBe("none");
      expect(actual.blur).toBe("none");
    } finally {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
      await session.detach();
    }
  });
});
