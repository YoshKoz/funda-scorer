#!/usr/bin/env node
/* Laadt de extensie in Chromium en zet het paneel op een bewaarde Funda-pagina.

   Geen zichtbaar venster en geen verbinding met funda.nl: de navigatie naar
   www.funda.nl wordt onderschept en uit tests/fixtures bediend. Daardoor matcht
   de content script nog steeds (het is dezelfde URL) maar is de test
   deterministisch en werkt hij headless. Alleen de brug op 127.0.0.1 wordt
   echt aangeroepen.

     node tests/extension-offline.cjs [fixture.html]

   Draait de brug, dan hoort het paneel "pyfunda-API" als bron te tonen; met
   REQUIRE_BRIDGE=1 is dat een harde eis. Zonder brug valt het paneel terug op
   de paginatekst en blijft de test groen.

   Screenshot: SCREENSHOT=/tmp/paneel.png */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { laadPlaywright, chromiumPad } = require("./browser.cjs");

const FIX = path.join(__dirname, "fixtures");
const EXTENSIE = path.join(__dirname, "..", "extension");
const fixture = process.argv[2] || "appartement.html";
const eisBrug = process.env.REQUIRE_BRIDGE === "1";

// De pagina moet dezelfde url houden als waar de fixture vandaan komt. Anders
// haalt de brug de verkeerde woning op en overschrijft die de parse (API wint).
// Houd dit gelijk aan de lijst in tests/capture-fixtures.cjs.
const URLS = {
    "appartement.html":
        "https://www.funda.nl/detail/koop/utrecht/appartement-bataviastraat-42/44592608/",
    "huis.html": "https://www.funda.nl/detail/koop/tiel/huis-kleine-ronduit-21/44588639/"
};
const URL = URLS[fixture] || URLS["appartement.html"];
const VERWACHT = {
    "appartement.html": { Prijs: "325.000", Wonen: "48 m²", Label: "E" },
    "huis.html": { Prijs: "675.000", Wonen: "162 m²", Label: "A+++" }
};

(async () => {
    const bestand = path.join(FIX, fixture);
    if (!fs.existsSync(bestand)) {
        console.error(`Geen fixture ${bestand}. Draai eerst: node tests/capture-fixtures.cjs`);
        process.exit(2);
    }

    // Scripts uit de opgeslagen pagina halen: die zijn toch niet zichtbaar in
    // innerText waar de parser op werkt, en zo kan Funda's JS de test niet
    // beïnvloeden (redirects, cookiebalk, botbeveiliging).
    const html = fs
        .readFileSync(bestand, "utf8")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<script\b[^>]*\/>/gi, "");

    const { chromium } = laadPlaywright();
    const profiel = fs.mkdtempSync(path.join(os.tmpdir(), "fs-off-"));
    const ctx = await chromium.launchPersistentContext(profiel, {
        executablePath: chromiumPad(),
        headless: true,
        viewport: { width: 1400, height: 950 },
        args: [
            `--disable-extensions-except=${EXTENSIE}`,
            `--load-extension=${EXTENSIE}`,
            "--disable-blink-features=AutomationControlled",
            // De pagina is hier synthetisch (route.fulfill), waardoor Chrome de
            // oorsprong als publiek ziet en de fetch naar 127.0.0.1 blokkeert met
            // "Permission was denied for this request to access the loopback address
            // space". Op een echte funda.nl-pagina gebeurt dat niet. Alleen in deze
            // test zetten we die controle uit.
            "--disable-features=LocalNetworkAccessChecks"
        ]
    });

    let fouten = 0;
    const check = (naam, ok, extra) => {
        console.log(`${ok ? "OK  " : "FAIL"} ${naam}${extra ? " - " + extra : ""}`);
        if (!ok) fouten++;
    };

    try {
        const page = ctx.pages()[0] || (await ctx.newPage());

        if (process.env.DEBUG === "1") {
            page.on("console", (m) => console.log(`     [console:${m.type()}] ${m.text()}`));
            page.on("pageerror", (e) => console.log(`     [pageerror] ${e.message}`));
            page.on("requestfailed", (r) =>
                console.log(`     [requestfailed] ${r.url()} ${r.failure()?.errorText}`)
            );
            page.on("response", (r) => {
                if (r.url().includes("127.0.0.1")) console.log(`     [brug] ${r.status()} ${r.url()}`);
            });
        }

        // Alleen funda.nl onderscheppen; de brug op 127.0.0.1 blijft bereikbaar.
        await page.route("https://www.funda.nl/**", (route) => {
            if (route.request().resourceType() === "document") {
                route.fulfill({
                    status: 200,
                    contentType: "text/html; charset=utf-8",
                    body: html
                });
            } else {
                route.abort();
            }
        });

        await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForSelector("#fundascorer-panel", { timeout: 20000 });
        check("paneel aanwezig", true, fixture);

        const score = (await page.locator("#fundascorer-panel .fs-total-num").innerText()).trim();
        check("score berekend", score !== "—" && score !== "", `score ${score}/10`);

        const feiten = await page.evaluate(() => {
            const dl = document.querySelector("#fundascorer-panel .fs-facts");
            const uit = {};
            if (!dl) return uit;
            const knopen = [...dl.children];
            for (let i = 0; i + 1 < knopen.length; i += 2) {
                uit[knopen[i].textContent.trim()] = knopen[i + 1].textContent.trim();
            }
            return uit;
        });

        for (const [label, deel] of Object.entries(VERWACHT[fixture] || {})) {
            const waarde = feiten[label] || "";
            check(`${label} = ${deel}`, waarde.includes(deel), waarde);
        }

        const bron = feiten["Bron"] || "";
        const brugActief = /pyfunda-API/.test(bron);
        check("brug gebruikt", eisBrug ? brugActief : true, bron);
        if (!brugActief) console.log("     hint: start de brug met ./run-bridge.sh");

        const scored = await page.evaluate(
            () =>
                (document.querySelector("#fundascorer-panel .fs-body > .fs-metrics") || { children: [] })
                    .children.length
        );
        check("weegbare metrieken getoond", scored === 4, `${scored} van 4`);

        const info = await page.evaluate(() =>
            document.querySelectorAll("#fundascorer-panel .fs-extra .fs-metric").length
        );
        check("overige kenmerken getoond", info === 8, `${info} van 8`);

        if (process.env.SCREENSHOT) {
            await page.screenshot({ path: process.env.SCREENSHOT });
            console.log(`     screenshot: ${process.env.SCREENSHOT}`);
        }
    } catch (e) {
        check("uitvoeren", false, e.message.split("\n")[0]);
    } finally {
        await ctx.close();
        fs.rmSync(profiel, { recursive: true, force: true });
    }

    console.log(fouten === 0 ? "\nAlles OK" : `\n${fouten} controle(s) mislukt`);
    process.exit(fouten === 0 ? 0 : 1);
})();
