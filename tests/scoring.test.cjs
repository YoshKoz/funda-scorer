#!/usr/bin/env node
/* Unit tests voor de pure scorelogica. Geen browser, geen netwerk.

     node tests/scoring.test.cjs
*/
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const FS = require(path.join(__dirname, "..", "extension", "scoring.js"));

let gefaald = 0;
let gedaan = 0;

function test(naam, fn) {
    gedaan++;
    try {
        fn();
        console.log("OK   " + naam);
    } catch (e) {
        gefaald++;
        console.log("FAIL " + naam + "\n     " + e.message.split("\n")[0]);
    }
}

const appartement = {
    prijs: 325000,
    prijsPerM2: 6771,
    buurtPrijsPerM2: 6053,
    woonopp: 48,
    perceel: null,
    slaapkamers: null,
    bouwjaar: 1929,
    energielabel: "E",
    woningtype: "Benedenwoning (appartement)",
    liggingRaw: "Aan rustige weg en in woonwijk",
    isolatieRaw: "Dubbel glas en vloerisolatie",
    tuinM2: 0,
    tuinAanwezig: true,
    bergingRaw: null
};

const huis = {
    prijs: 675000,
    prijsPerM2: 4167,
    buurtPrijsPerM2: 4035,
    woonopp: 162,
    perceel: 184,
    slaapkamers: 4,
    bouwjaar: 2021,
    energielabel: "A+++",
    woningtype: "Herenhuis, 2-onder-1-kapwoning",
    liggingRaw: "Aan rustige weg en in woonwijk",
    isolatieRaw: "Dakisolatie, drievoudig glas, muurisolatie en vloerisolatie",
    tuinM2: 90,
    tuinAanwezig: true,
    bergingRaw: "Vrijstaande houten berging"
};

const aanbod = (n) =>
    Array.from({ length: n }, (_, i) => ({
        ...huis,
        prijs: 300000 + i * 10000,
        woonopp: 60 + i * 3,
        slaapkamers: 2 + (i % 4)
    }));

// ---------- ontbrekende velden ----------

test("ontbrekende berging is onbekend, niet 0", () => {
    assert.equal(FS.totalScore(appartement, FS.DEFAULT_WEIGHTS, null).metrics.berging, null);
});

test("ontbrekende tuin is onbekend, niet 0", () => {
    const zonderTuin = { ...huis, tuinM2: 0, tuinAanwezig: false };
    assert.equal(FS.totalScore(zonderTuin, FS.DEFAULT_WEIGHTS, null).metrics.buitenruimte, null);
});

test("onherkenbare ligging is onbekend, niet 5", () => {
    const raar = { ...huis, liggingRaw: "Aan een hele mooie plek" };
    assert.equal(FS.totalScore(raar, FS.DEFAULT_WEIGHTS, null).metrics.ligging, null);
});

test("onherkenbare isolatietekst is onbekend, niet 0", () => {
    const raar = { ...huis, isolatieRaw: "Van alles en nog wat" };
    assert.equal(FS.totalScore(raar, FS.DEFAULT_WEIGHTS, null).metrics.isolatie, null);
});

test("ontbrekend energielabel is onbekend", () => {
    assert.equal(FS.totalScore({ ...huis, energielabel: null }, FS.DEFAULT_WEIGHTS, null).metrics.energie, null);
});

// ---------- dekking ----------

test("ontbrekende metriek verlaagt de dekking en wordt gemeld", () => {
    const r = FS.totalScore(appartement, FS.DEFAULT_WEIGHTS, null);
    assert.ok(r.dekking < 1, "dekking zou onder 100% moeten zitten");
    assert.ok(r.ontbreekt.includes("Slaapkamers"), "Slaapkamers zou ontbreken");
});

test("volledige invoer geeft dekking 1", () => {
    const r = FS.totalScore(huis, FS.DEFAULT_WEIGHTS, null);
    assert.equal(r.dekking, 1);
    assert.deepEqual(r.ontbreekt, []);
});

// ---------- schalen ----------

test("woonopp zonder referentie gebruikt de band van het woningtype", () => {
    const apt = FS.metricScores(appartement, null).woonopp;
    const hs = FS.metricScores(huis, null).woonopp;
    assert.ok(apt > 0, `appartement van 48 m² mag niet 0 scoren (was ${apt})`);
    assert.ok(hs > apt, "een huis van 162 m² hoort hoger te scoren dan een appartement van 48 m²");
});

test("energielabel A+++ scoort hoger dan E", () => {
    assert.ok(
        FS.metricScores(huis, null).energie > FS.metricScores(appartement, null).energie
    );
});

// ---------- zuiverheid ----------

test("scoren is puur: geen verborgen referentiestaat", () => {
    const ref = FS.maakReferentie(aanbod(40), FS.DEFAULT_WEIGHTS);
    assert.ok(ref, "referentie zou opgebouwd moeten zijn");
    const eerste = FS.totalScore(huis, FS.DEFAULT_WEIGHTS, ref);
    FS.totalScore(appartement, FS.DEFAULT_WEIGHTS, null); // tussendoor zonder referentie
    const tweede = FS.totalScore(huis, FS.DEFAULT_WEIGHTS, ref);
    assert.equal(eerste.score, tweede.score);
});

test("maakReferentie geeft null bij te weinig aanbod", () => {
    assert.equal(FS.maakReferentie(aanbod(4), FS.DEFAULT_WEIGHTS), null);
});

test("met referentie wordt de prijs percentiel gescoord", () => {
    const ref = FS.maakReferentie(aanbod(40), FS.DEFAULT_WEIGHTS);
    const goedkoop = FS.totalScore({ ...huis, prijs: 300000 }, FS.DEFAULT_WEIGHTS, ref);
    const duur = FS.totalScore({ ...huis, prijs: 690000 }, FS.DEFAULT_WEIGHTS, ref);
    assert.ok(
        goedkoop.metrics.prijsVsBuurt > duur.metrics.prijsVsBuurt,
        "een goedkoper huis in hetzelfde aanbod hoort hoger te scoren"
    );
});

// ---------- wegingen ----------

test("de weegbare metrieken en de scoremetrieken zijn dezelfde set", () => {
    assert.deepEqual(Object.keys(FS.DEFAULT_WEIGHTS).sort(), [...FS.SCORE_METRICS].sort());
});

test("INFO_METRICS en SCORE_METRICS vullen samen alle labels", () => {
    assert.deepEqual(
        [...FS.SCORE_METRICS, ...FS.INFO_METRICS].sort(),
        Object.keys(FS.METRIC_LABELS).sort()
    );
});

// ---------- breekpunten ----------

test("breekpunten flaggen een huis boven de maximale prijs", () => {
    const uit = FS.breekpunten(huis, { maxPrijs: 500000, minSlaapkamers: 5, minWoonopp: 0 });
    assert.ok(uit.some((t) => t.includes("500.000")), "prijs zou moeten afvallen");
    assert.ok(uit.some((t) => t.includes("slaapkamers")), "slaapkamers zou moeten afvallen");
});

test("geen breekpunten als alles past", () => {
    assert.deepEqual(FS.breekpunten(huis, { maxPrijs: 800000, minSlaapkamers: 3 }), []);
});

// ---------- parseNumber ----------

test("parseNumber haalt getallen uit Funda-tekst", () => {
    assert.equal(FS.parseNumber("€ 325.000 kosten koper"), 325000);
    assert.equal(FS.parseNumber("48 m²"), 48);
    assert.equal(FS.parseNumber("1.234,50"), 1234.5);
    assert.equal(FS.parseNumber("187 m³"), 187);
});

test("parseNumber geeft null zonder getal", () => {
    assert.equal(FS.parseNumber("Parkeergelegenheid"), null);
    assert.equal(FS.parseNumber(""), null);
    assert.equal(FS.parseNumber(null), null);
});

// ---------- brug samenvoegen ----------

test("API-klasse A3 wordt A+++", () => {
    assert.equal(FS.mergeBridge({ adres: "x" }, { energielabel: "A3" }).energielabel, "A+++");
    assert.equal(FS.metricScores({ energielabel: "A+++" }, null).energie, 9.8);
});

test("onleesbaar energielabel overschrijft de paginatekst niet", () => {
    const uit = FS.mergeBridge(
        { adres: "x", energielabel: "A+++" },
        { energielabel: "Wat betekent dit?" }
    );
    assert.equal(uit.energielabel, "A+++");
});

test("onleesbaar numeriek API-veld overschrijft de paginatekst niet", () => {
    assert.equal(FS.mergeBridge({ woonopp: 48 }, { woonopp: "onbekend" }).woonopp, 48);
    assert.equal(FS.mergeBridge({ woonopp: 48 }, { woonopp: "162 m²" }).woonopp, 162);
});

console.log(gefaald === 0 ? `\n${gedaan} tests OK` : `\n${gefaald} van ${gedaan} tests mislukt`);
process.exit(gefaald === 0 ? 0 : 1);
