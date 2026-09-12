#!/usr/bin/env node
/* Parseert de bewaarde Funda-pagina's in tests/fixtures en controleert de
   verwachte velden. Geen netwerk: dit test alleen de parser.

     node tests/capture-fixtures.cjs   # eenmalig, haalt de pagina's op
     node tests/parse-fixtures.cjs
*/
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { laadPlaywright, chromiumPad } = require("./browser.cjs");

const FIX = path.join(__dirname, "fixtures");
const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "extension", "scoring.js"), "utf8");

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
const KOPPEN = [
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
];

(async () => {
    const { chromium } = laadPlaywright();
    const bestanden = fs.existsSync(FIX)
        ? fs.readdirSync(FIX).filter((f) => f.endsWith(".html")).sort()
        : [];
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
    let fouten = 0;
    let checks = 0;

    for (const bestand of bestanden) {
        await page.goto("file://" + path.join(FIX, bestand), { waitUntil: "domcontentloaded" });
        const parsed = await page.evaluate(
            (code) => new Function(code + "; return FundaScore;")().parseListing(),
            SCRIPT
        );

        for (const [veld, waarde] of Object.entries(VERWACHT[bestand] || {})) {
            checks++;
            const ok = parsed[veld] === waarde;
            if (!ok) fouten++;
            console.log(
                `${ok ? "OK  " : "FAIL"} ${bestand} ${veld} = ${JSON.stringify(parsed[veld])}` +
                (ok ? "" : ` (verwacht ${JSON.stringify(waarde)})`)
            );
        }

        checks++;
        const besmet = Object.entries(parsed).filter(
            ([, waarde]) => typeof waarde === "string" && KOPPEN.includes(waarde)
        );
        if (besmet.length) {
            fouten++;
            console.log(
                `FAIL ${bestand} kopregel als waarde: ` + besmet.map(([v, w]) => `${v}=${w}`).join(", ")
            );
        } else {
            console.log(`OK   ${bestand} geen kopregel als waarde`);
        }
    }

    await ctx.close();
    console.log(fouten === 0 ? `\n${checks} checks OK` : `\n${fouten} van ${checks} checks mislukt`);
    process.exit(fouten === 0 ? 0 : 1);
})();
