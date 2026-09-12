/* Funda Scorer - gedeelde laag.
   Wordt in elke context voor scoring.js geladen (content scripts en popup) en
   bevat de enige plek waar chrome/browser, opslag en opmaak geregeld worden.

   Let op: scoring.js wordt ook in Node geladen (tests) en mag hier niet van
   afhangen. Daar is `FundaCommon` simpelweg niet gedefinieerd. */

const FundaCommon = (() => {
    "use strict";

    // Firefox levert `browser` (promise-based), Chrome `chrome`. Allebei kunnen ze
    // promises, maar sommige builds alleen callbacks; daarom lopen alle
    // opslagaanroepen hieronder via een wrapper die beide aankan.
    const api = typeof browser !== "undefined" && browser.runtime ? browser : chrome;

    const KEYS = {
        weights: "weights",
        filters: "filters",
        houses: "houses",
        houseIndex: "houseIndex",
        bridgePort: "bridgePort"
    };

    // chrome: get(keys, cb) geeft een promise EN roept cb aan.
    // firefox: geeft een promise en negeert/of roept cb aan.
    // Door beide paden naar dezelfde resolver te laten lopen werkt het overal.
    function lees(keys) {
        return new Promise((klaar, fout) => {
            let afgerond = false;
            const cb = (res) => {
                if (afgerond) return;
                afgerond = true;
                klaar(res || {});
            };
            try {
                const r = api.storage.local.get(keys, cb);
                if (r && typeof r.then === "function") r.then(cb, fout);
            } catch (e) {
                fout(e);
            }
        });
    }

    function schrijf(items) {
        return new Promise((klaar, fout) => {
            let afgerond = false;
            const cb = () => {
                if (afgerond) return;
                afgerond = true;
                klaar();
            };
            try {
                const r = api.storage.local.set(items, cb);
                if (r && typeof r.then === "function") r.then(cb, fout);
            } catch (e) {
                fout(e);
            }
        });
    }

    // ---------- opmaak ----------

    const euro = (n) => (n === null || n === undefined ? "—" : "€ " + n.toLocaleString("nl-NL"));

    const getal = (n, suffix) =>
        n === null || n === undefined ? "—" : n.toLocaleString("nl-NL") + (suffix || "");

    // jaartallen zonder duizendtalscheiding: 1904, niet 1.904
    const jaar = (n) => (n === null || n === undefined ? "—" : String(n));

    // prefix "fs-" voor het paneel, "" voor de popup; bijNull voor de klasse die
    // hoort bij een ontbrekende score.
    function scoreClass(s, prefix, bijNull) {
        const p = prefix || "";
        if (s === null || s === undefined) return bijNull === undefined ? p + "na" : bijNull;
        if (s >= 7) return p + "goed";
        if (s >= 5) return p + "matig";
        return p + "slecht";
    }

    // "Utrecht" / "Den Haag" -> "utrecht" / "den-haag"
    function slugify(tekst) {
        return String(tekst || "")
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/g, "-")
            .replaceAll(/^-|-$/g, "");
    }

    // Labels uit innerText kunnen non-breaking spaces en dubbele spaties bevatten.
    function normaliseer(tekst) {
        return String(tekst ?? "")
            .replaceAll(/[\u00a0\u2007\u202f]/g, " ")
            .replaceAll(/\s+/g, " ")
            .trim();
    }

    // ---------- opslaglaag ----------

    // De ranglijst groeit onbeperkt, dus de detailpagina leest alleen de
    // lichte index om te weten of een huis al opgeslagen is, niet de hele map.
    const Store = {
        async weights() {
            const s = await lees(KEYS.weights);
            return { ...s[KEYS.weights] };
        },
        async filters() {
            const s = await lees(KEYS.filters);
            return { ...s[KEYS.filters] };
        },
        async houses() {
            const s = await lees(KEYS.houses);
            return s[KEYS.houses] || {};
        },
        async heeftHuis(url) {
            if (!url) return false;
            const s = await lees([KEYS.houseIndex, KEYS.houses]);
            if (Array.isArray(s[KEYS.houseIndex])) return s[KEYS.houseIndex].includes(url);
            // oudere opslag zonder index: eenmalig terugvallen op de volledige map
            return Boolean(s[KEYS.houses]?.[url]);
        },
        async bewaarHuis(huis) {
            const s = await lees([KEYS.houses, KEYS.houseIndex]);
            const map = s[KEYS.houses] || {};
            map[huis.url] = huis;
            const index = Array.isArray(s[KEYS.houseIndex]) ? s[KEYS.houseIndex].slice() : Object.keys(map);
            if (!index.includes(huis.url)) index.push(huis.url);
            await schrijf({ [KEYS.houses]: map, [KEYS.houseIndex]: index });
            return index.length;
        },
        async verwijderHuis(url) {
            const s = await lees([KEYS.houses, KEYS.houseIndex]);
            const map = s[KEYS.houses] || {};
            delete map[url];
            const index = (Array.isArray(s[KEYS.houseIndex]) ? s[KEYS.houseIndex] : Object.keys(map)).filter(
                (u) => u !== url
            );
            await schrijf({ [KEYS.houses]: map, [KEYS.houseIndex]: index });
        },
        async resetWeights() {
            await schrijf({ [KEYS.weights]: {} });
        }
    };

    return { api, KEYS, lees, schrijf, euro, getal, jaar, scoreClass, slugify, normaliseer, Store };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FundaCommon;
