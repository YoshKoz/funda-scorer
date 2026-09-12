#!/usr/bin/env node
/* Parseert de bewaarde Funda-pagina's in tests/fixtures en controleert de
   verwachte velden. Geen netwerk: dit test alleen de parser.

     node tests/capture-fixtures.cjs   # eenmalig, haalt de pagina's op
     node tests/parse-fixtures.cjs
*/
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { laadPlaywright, chromiumPad } = require("./browser.cjs");

const FIX = path.join(__dirname, "fixtures");
const SCRIPT_PAD = path.join(__dirname, "..", "extension", "scoring.js");

const VERWACHT = {
    "appartement.html": {
        prijs: 325000,
        woonopp: 48,
        bouwjaar: 1929,
        energielabel: "E",
        slaapkamers: null,
        kamersRaw: "2 kamers",
        tuinAanwezig: true,
        bergingRaw: null
    },
    "huis.html": {
        prijs: 675000,
        woonopp: 162,
        perceel: 184,
        slaapkamers: 4,
        energielabel: "A+++",
        tuinM2: 90,
        bergingRaw: "Vrijstaande houten berging"
    }
};

// Een lege rij in de kenmerken-tabel liet de volgende kopregel als waarde
// doorgaan. Geen enkel veld mag daarom een sectiekop als waarde hebben.
const KOPPEN = new Set([
    "Overdracht",
    "Bouw",
    "Oppervlakten en inhoud",
    "Indeling",
    "Energie",
    "Kadastrale gegevens",
    "Buitenruimte",
    "Parkeergelegenheid",
    "VvE checklist",
    "Bergruimte"
]);

// ---------- controles ----------

function telControle(tel, ok, regel) {
    tel.checks++;
    if (!ok) tel.fouten++;
    console.log(regel);
}

function controleerVelden(bestand, parsed, tel) {
    for (const [veld, waarde] of Object.entries(VERWACHT[bestand] || {})) {
        const ok = parsed[veld] === waarde;
        telControle(
            tel,
            ok,
            `${ok ? "OK  " : "FAIL"} ${bestand} ${veld} = ${JSON.stringify(parsed[veld])}` +
            (ok ? "" : ` (verwacht ${JSON.stringify(waarde)})`)
        );
    }
}

function controleerKoppen(bestand, parsed, tel) {
    const besmet = Object.entries(parsed).filter(
        ([, waarde]) => typeof waarde === "string" && KOPPEN.has(waarde)
    );
    const ok = besmet.length === 0;
    telControle(
        tel,
        ok,
        ok
            ? `OK   ${bestand} geen kopregel als waarde`
            : `FAIL ${bestand} kopregel als waarde: ` +
            besmet.map(([v, w]) => `${v}=${w}`).join(", ")
    );
}

function fixtureBestanden() {
    if (!fs.existsSync(FIX)) return [];
    return fs.readdirSync(FIX).filter((f) => f.endsWith(".html")).sort();
}

// scoring.js is een gewoon script: we laden het bestand in de pagina met een
// script-tag in plaats van de inhoud als code te evalueren.
async function parseBestand(page, bestand) {
    await page.goto("file://" + path.join(FIX, bestand), { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ path: SCRIPT_PAD });
    return page.evaluate(() => FundaScore.parseListing());
}

async function main() {
    const { chromium } = laadPlaywright();
    const bestanden = fixtureBestanden();
    if (!bestanden.length) {
        console.error("Geen fixtures in " + FIX);
        console.error("Draai eerst: node tests/capture-fixtures.cjs");
        process.exit(2);
    }

    const ctx = await chromium.launchPersistentContext(
        fs.mkdtempSync(path.join(os.tmpdir(), "fs-fix-")),
        { executablePath: chromiumPad(), headless: true }
    );
    const page = ctx.pages()[0] || (await ctx.newPage());
    const tel = { checks: 0, fouten: 0 };

    for (const bestand of bestanden) {
        const parsed = await parseBestand(page, bestand);
        controleerVelden(bestand, parsed, tel);
        controleerKoppen(bestand, parsed, tel);
    }

    await ctx.close();
    console.log(
        tel.fouten === 0
            ? `\n${tel.checks} checks OK`
            : `\n${tel.fouten} van ${tel.checks} checks mislukt`
    );
    process.exit(tel.fouten === 0 ? 0 : 1);
}

main();
