#!/usr/bin/env node
/* Laadt de extensie in Chromium (via Playwright) en controleert op een echte
   Funda-detailpagina dat het paneel verschijnt en de score berekend wordt.

     node tests/extension-live.cjs [funda-url]

   Playwright is nodig; zie README. De Chromium uit de Playwright-cache wordt
   hergebruikt zodat er niets gedownload hoeft te worden.

   Let op: Chrome (google-chrome-stable, 152) negeert --load-extension, daarom
   gebruiken we de Chromium van Playwright. Draait de brug, dan moet het paneel
   "pyfunda-API" als bron tonen; met REQUIRE_BRIDGE=1 wordt dat een harde eis. */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const WORTEL = path.resolve(__dirname, "..");
const EXTENSIE = path.join(WORTEL, "extension");
const URL =
    process.argv[2] ||
    "https://www.funda.nl/detail/koop/utrecht/appartement-bataviastraat-42/44592608/";
const headless = process.env.HEADLESS === "1";
const eisBrug = process.env.REQUIRE_BRIDGE === "1";

function laadPlaywright() {
    try {
        return require("playwright");
    } catch (e) {
        console.error("playwright niet gevonden. Bijvoorbeeld:");
        console.error("  npm install --no-save playwright");
        console.error("  NODE_PATH=<pad>/node_modules node tests/extension-live.cjs");
        process.exit(2);
    }
}

// Playwright verwacht zijn eigen build; pak een Chromium die al in de cache
// staat, ongeacht het versienummer, zodat er niets gedownload wordt.
function chromiumPad() {
    const basis = path.join(os.homedir(), ".cache", "ms-playwright");
    if (!fs.existsSync(basis)) return undefined;
    const mappen = fs
        .readdirSync(basis)
        .filter((d) => d.startsWith("chromium-"))
        .sort()
        .reverse();
    for (const map of mappen) {
        for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
            const pad = path.join(basis, map, sub);
            if (fs.existsSync(pad)) return pad;
        }
    }
    return undefined;
}

// De Didomi-cookiebalk staat in een iframe en blokkeert het zicht op het
// paneel. Achtergrond alleen; mislukken is geen testfout.
async function accepteerCookies(page) {
    const pogingen = [
        () => page.locator("#didomi-host iframe").contentFrame().getByRole("button", { name: /alles accepteren/i }).click({ timeout: 6000 }),
        () => page.frameLocator('iframe[title*="toestemming" i]').getByRole("button", { name: /accepteren/i }).click({ timeout: 5000 }),
        () => page.getByRole("button", { name: /alles accepteren/i }).click({ timeout: 3000 }),
        () => page.evaluate(() => { try { window.Didomi && Didomi.setUserAgreeToAll(); } catch (e) { } }),
    ];
    for (const poging of pogingen) {
        try {
            await poging();
            await page.waitForTimeout(1500);
            return true;
        } catch (e) { }
    }
    return false;
}

(async () => {
    const { chromium } = laadPlaywright();
    const profiel = fs.mkdtempSync(path.join(os.tmpdir(), "funda-scorer-"));
    const ctx = await chromium.launchPersistentContext(profiel, {
        executablePath: chromiumPad(),
        headless,
        viewport: { width: 1400, height: 950 },
        args: [
            `--disable-extensions-except=${EXTENSIE}`,
            `--load-extension=${EXTENSIE}`,
            "--disable-blink-features=AutomationControlled",
        ],
    });

    let fouten = 0;
    const check = (naam, ok, extra) => {
        console.log(`${ok ? "OK  " : "FAIL"} ${naam}${extra ? " - " + extra : ""}`);
        if (!ok) fouten++;
    };

    try {
        const page = ctx.pages()[0] || (await ctx.newPage());
        console.log(`URL: ${URL}`);
        await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
        if (!(await accepteerCookies(page))) console.log("     (cookiebalk niet weggeklikt)");

        await page.waitForSelector("#fundascorer-panel", { timeout: 30000 });
        check("paneel aanwezig", true);

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

        check("prijs gelezen", Boolean(feiten["Prijs"] && feiten["Prijs"] !== "—"), feiten["Prijs"]);
        check("wonen gelezen", Boolean(feiten["Wonen"]), feiten["Wonen"]);

        const bron = feiten["Bron"] || "";
        const brugActief = /pyfunda-API/.test(bron);
        check(
            "brug gebruikt",
            eisBrug ? brugActief : true,
            `${bron}${brugActief ? "" : " (brug uit - alleen pagina-tekst)"}`
        );
        if (!brugActief) {
            console.log("     hint: start de brug met ./run-bridge.sh en herlaad de pagina");
        }
        if (feiten["Prijshistorie"]) console.log(`     prijshistorie: ${feiten["Prijshistorie"]}`);
        if (feiten["Interesse"]) console.log(`     interesse: ${feiten["Interesse"]}`);

        const metrics = await page.evaluate(() =>
            [...document.querySelectorAll("#fundascorer-panel .fs-metric")].map((m) => ({
                naam: m.querySelector(".fs-metric-lab").textContent.trim(),
                waarde: m.querySelector(".fs-metric-num").textContent.trim(),
            }))
        );
        console.log("     metrieken: " + metrics.map((m) => `${m.naam} ${m.waarde}`).join(", "));

        if (process.env.SCREENSHOT) {
            await page.screenshot({ path: process.env.SCREENSHOT, fullPage: false });
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
