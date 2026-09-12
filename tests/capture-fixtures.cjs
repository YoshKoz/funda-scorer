#!/usr/bin/env node
/* Haalt echte Funda-detailpagina's op en bewaart ze in tests/fixtures, zodat
   tests/parse-fixtures.cjs de parser offline kan controleren.

     node tests/capture-fixtures.cjs

   Let op: headless wordt door Funda's botbeveiliging onderschept ("Je bent bijna
   op de pagina die je zoekt"), daarom draait dit met een zichtbaar venster. */
"use strict";

const fs = require("fs");
const path = require("path");
const { laadPlaywright, chromiumPad } = require("./browser.cjs");

const FIX = path.join(__dirname, "fixtures");
const DOELEN = [
    ["appartement.html", "https://www.funda.nl/detail/koop/utrecht/appartement-bataviastraat-42/44592608/"],
    ["huis.html", "https://www.funda.nl/detail/koop/tiel/huis-kleine-ronduit-21/44588639/"]
];

(async () => {
    const { chromium } = laadPlaywright();
    fs.mkdirSync(FIX, { recursive: true });
    const ctx = await chromium.launchPersistentContext(
        fs.mkdtempSync(path.join(require("os").tmpdir(), "fs-cap-")),
        {
            executablePath: chromiumPad(),
            headless: false,
            viewport: { width: 1400, height: 950 },
            args: ["--disable-blink-features=AutomationControlled"]
        }
    );
    const page = ctx.pages()[0] || (await ctx.newPage());
    for (const [naam, url] of DOELEN) {
        try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
            await page.evaluate(() => {
                try {
                    window.Didomi && Didomi.setUserAgreeToAll();
                } catch (e) { }
            });
            await page.waitForTimeout(7000);
            const titel = await page.title();
            if (/bijna/.test(titel)) {
                console.log(`FAIL ${naam}: botbeveiliging (${titel})`);
                continue;
            }
            const html = await page.content();
            fs.writeFileSync(path.join(FIX, naam), html);
            console.log(`OK   ${naam}: ${html.length} bytes | ${titel}`);
        } catch (e) {
            console.log(`FAIL ${naam}: ${e.message.split("\n")[0]}`);
        }
    }
    await ctx.close();
})();
