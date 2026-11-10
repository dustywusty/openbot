import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Browser, chromium } from "playwright-core";

// Exercise the production override in a real layout engine, including long code lines.
const enabled = process.env.OPENBOT_APP_BROWSER === "1";
let browser: Browser | undefined;
beforeAll(async () => {
  if (enabled)
    browser = await chromium.launch({
      channel: process.env.OPENBOT_APP_BROWSER_CHANNEL ?? "chromium",
    });
});
afterAll(async () => {
  await browser?.close();
});

for (const viewport of [390, 1600]) {
  for (const skin of [false, true]) {
    test.skipIf(!enabled)(
      `chat columns respect saved widths at ${viewport}px, skin=${skin}`,
      async () => {
        const page = await browser!.newPage({
          viewport: { width: viewport, height: 900 },
        });
        try {
          const css = readFileSync(
            new URL("../src/chat-width.css", import.meta.url),
            "utf8",
          );
          await page.setContent(`<html ${skin ? 'data-skin="opendots"' : ""}><head><style>
          *{box-sizing:border-box}body{margin:0;display:flex}aside{width:200px;flex-shrink:0}main{flex:1;min-width:0}
          [data-transcript-column],[data-slot="composer-column"]{width:100%;max-width:768px;margin-inline:auto;padding:16px}
          :root[data-skin] [data-transcript-column],:root[data-skin] [data-slot="composer-column"]{max-width:672px}
          pre{white-space:pre} .settings{max-width:600px}
          @media(max-width:600px){aside{display:none}}
          ${css}
        </style></head><body><aside>Sidebar</aside><main><section class="settings">Other page</section>
          <div data-transcript-column><pre>${"long_code_line".repeat(1000)}</pre></div>
          <div data-slot="composer-column"><textarea style="width:100%"></textarea></div>
        </main></body></html>`);
          const widths: number[] = [];
          for (const width of ["comfortable", "wide", "full"]) {
            await page.evaluate((value) => {
              document.documentElement.dataset.chatWidth = value;
            }, width);
            const layout = await page.evaluate(() => {
              const box = (selector: string) =>
                document.querySelector(selector)!.getBoundingClientRect().width;
              const pre = document.querySelector("pre")!;
              return {
                transcript: box("[data-transcript-column]"),
                composer: box('[data-slot="composer-column"]'),
                main: box("main"),
                settings: box(".settings"),
                sidebar: box("aside"),
                overflow: document.documentElement.scrollWidth > innerWidth,
                codeScrolls: pre.scrollWidth > pre.clientWidth,
              };
            });
            expect(layout.transcript).toBe(layout.composer);
            expect(layout.transcript).toBeLessThanOrEqual(layout.main);
            expect(layout.overflow).toBe(false);
            expect(layout.codeScrolls).toBe(true);
            expect(layout.settings).toBe(Math.min(600, layout.main));
            if (viewport > 600) expect(layout.sidebar).toBe(200);
            widths.push(layout.transcript);
          }
          if (viewport > 600) {
            expect(widths[0]).toBe(skin ? 672 : 768);
            expect(widths[1]).toBe(1152);
            expect(widths[2]).toBe(1400);
          } else expect(widths).toEqual([390, 390, 390]);
        } finally {
          await page.close();
        }
      },
    );
  }
}
