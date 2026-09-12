/* Funda Scorer - gedeelde parse- en scorelogica.
   Wordt geladen door zowel content.js als popup.js. */

const FundaScore = (() => {
  "use strict";

  // ---------- standaardinstellingen ----------

  const DEFAULT_WEIGHTS = {
    prijsVsBuurt: 35,
    energie: 20,
    woonopp: 30,
    slaapkamers: 15,
    buitenruimte: 10,
    klus: 10,
    bouwjaar: 5,
    berging: 5,
    ligging: 5,
    ketel: 5,
    isolatie: 5,
    perceel: 5
  };

  const METRIC_LABELS = {
    prijsVsBuurt: "Prijs t.o.v. aanbod",
    energie: "Energielabel",
    woonopp: "Woonoppervlak",
    slaapkamers: "Slaapkamers",
    buitenruimte: "Buitenruimte",
    klus: "Bouwkundige staat",
    bouwjaar: "Bouwjaar",
    berging: "Berging/schuur",
    ligging: "Ligging aan de weg",
    ketel: "Leeftijd cv-ketel",
    isolatie: "Isolatie",
    perceel: "Perceel"
  };

  const DEFAULT_FILTERS = {
    minSlaapkamers: 0,
    minWoonopp: 0,
    maxPrijs: 0, // 0 = uit
    tuinVerplicht: false,
    bergingVerplicht: false
  };

  // ---------- helpers ----------

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // Referentie: het aanbod waarin je zoekt. Prijs, oppervlak en slaapkamers
  // scoren als percentiel daarbinnen, en de eindscore wordt een schoolcijfer:
  // mediaan van het aanbod = 6, p90 = 8. Zonder referentie gelden de vaste
  // schalen hieronder.
  let referentie = null;

  function ladder(waarden) {
    const reeks = waarden.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
    if (reeks.length < 2) return null;
    const laatste = reeks.length - 1;
    return Array.from({ length: 21 }, (_, i) => reeks[Math.round((i / 20) * laatste)]);
  }

  function percentiel(reeks, value) {
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    const stap = 1 / (reeks.length - 1);
    if (value <= reeks[0]) return 0;
    if (value >= reeks[reeks.length - 1]) return 1;
    for (let i = 1; i < reeks.length; i++) {
      if (value <= reeks[i]) {
        const breedte = reeks[i] - reeks[i - 1];
        const deel = breedte === 0 ? 0 : (value - reeks[i - 1]) / breedte;
        return (i - 1 + deel) * stap;
      }
    }
    return 1;
  }

  const CIJFER_ANKERS = [
    [0, 2],
    [0.1, 4],
    [0.5, 6],
    [0.9, 8],
    [1, 10]
  ];

  function cijfer(p) {
    for (let i = 1; i < CIJFER_ANKERS.length; i++) {
      if (p <= CIJFER_ANKERS[i][0]) {
        const [p0, c0] = CIJFER_ANKERS[i - 1];
        const [p1, c1] = CIJFER_ANKERS[i];
        return c0 + ((p - p0) / (p1 - p0)) * (c1 - c0);
      }
    }
    return 10;
  }

  function setReferentie(aanbod) {
    referentie = null;
    if (!Array.isArray(aanbod) || aanbod.length < 5) return;

    const ladders = {
      prijs: ladder(aanbod.map((h) => h.prijs)),
      woonopp: ladder(aanbod.map((h) => h.woonopp)),
      slaapkamers: ladder(aanbod.map((h) => h.slaapkamers))
    };
    if (!ladders.prijs || !ladders.woonopp) return;

    referentie = { ladders, scores: null };
    const ruw = aanbod.map((h) => ruweScore(h, DEFAULT_WEIGHTS)).filter((s) => s !== null);
    referentie.scores = ladder(ruw);
  }

  function scale(value, worst, best) {
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    if (best === worst) return 5;
    return clamp(((value - worst) / (best - worst)) * 10, 0, 10);
  }

  // "€ 235.000" / "1.234,50" -> 235000 / 1234.5
  function parseNumber(str) {
    if (!str) return null;
    const m = String(str).replace(/\s/g, "").match(/-?[\d.]+(?:,\d+)?/);
    if (!m) return null;
    const n = parseFloat(m[0].replace(/\./g, "").replace(",", "."));
    return Number.isNaN(n) ? null : n;
  }

  // ---------- parser ----------
  // Werkt op de zichtbare tekst van de pagina: zoekt een labelregel en pakt de
  // eerstvolgende niet-lege regel als waarde. Labels komen uit de kenmerken-
  // tabel van Funda. Verandert Funda de labeltekst, dan blijft het veld leeg
  // en meldt het paneel welke metrieken ontbreken.

  function textLines(root) {
    const raw = (root || document.body).innerText || "";
    return raw.split("\n").map((l) => l.trim());
  }

  function afterLabel(lines, label, offset) {
    const skip = offset || 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === label) {
        let seen = 0;
        for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
          if (lines[j] === "") continue;
          if (seen === skip) return lines[j];
          seen++;
        }
      }
    }
    return null;
  }

  // Sommige labels staan meerdere keren op de pagina ("Cv-ketel" staat zowel
  // als waarde bij Verwarming/Warm water als label bij het toestel; "Isolatie"
  // staat bij Energie en nog eens bij de berging). Deze variant loopt alle
  // voorkomens af en pakt de eerste waarde die op het patroon past.
  function afterLabelMatching(lines, label, regex) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== label) continue;
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (lines[j] === "" || lines[j] === label) continue;
        if (regex.test(lines[j])) return lines[j];
        break;
      }
    }
    return null;
  }

  function parseTitleAddress() {
    // paginatitel: "Huis te koop: Nijhoffstraat 3 6821 BG Arnhem | Funda"
    const t = document.title || "";
    const m = t.match(/^[^:]*:\s*(.+?)\s*\|/);
    return m ? m[1] : t.replace(/\s*\|\s*Funda\s*$/, "").trim();
  }

  const TUIN_VELDEN = [
    "Achtertuin",
    "Voortuin",
    "Zijtuin",
    "Tuin rondom",
    "Patio/atrium",
    "Plaats",
    "Gebouwgebonden buitenruimte"
  ];

  function parseListing() {
    const lines = textLines();
    const get = (label, offset) => afterLabel(lines, label, offset);

    const kamersRaw = get("Aantal kamers");
    let slaapkamers = null;
    if (kamersRaw) {
      const m = kamersRaw.match(/(\d+)\s*slaapkamer/);
      if (m) slaapkamers = parseInt(m[1], 10);
    }

    const ketelRaw = afterLabelMatching(lines, "Cv-ketel", /(19|20)\d{2}/);
    let ketelJaar = null;
    if (ketelRaw) {
      const m = ketelRaw.match(/(19|20)\d{2}/);
      if (m) ketelJaar = parseInt(m[0], 10);
    }

    // Alle tuinvelden optellen: Funda splitst voor-, achter- en zijtuin.
    let tuinM2 = 0;
    const tuinDelen = [];
    for (const veld of TUIN_VELDEN) {
      const v = parseNumber(get(veld));
      if (v) {
        tuinM2 += v;
        tuinDelen.push(`${veld.toLowerCase()} ${v} m²`);
      }
    }
    const tuinRaw = get("Tuin"); // bv. "Achtertuin en voortuin" - soms zonder maat
    const tuinAanwezig = tuinM2 > 0 || Boolean(tuinRaw);

    // "Isolatie" staat ook bij de berging; pak de regel die over de woning gaat.
    const isolatieRaw =
      afterLabelMatching(lines, "Isolatie", /glas|isolatie|isoleerd/i) || null;

    const specifiek = get("Specifiek");

    return {
      url: location.href.split("?")[0],
      adres: parseTitleAddress(),
      opgeslagenOp: new Date().toISOString().slice(0, 10),
      status: get("Status"),
      prijs: parseNumber(get("Vraagprijs")),
      prijsPerM2: parseNumber(get("Vraagprijs per m²")),
      buurtPrijsPerM2: parseNumber(get("Gem. vraagprijs / m²")),
      woonopp: parseNumber(get("Wonen")),
      perceel: parseNumber(get("Perceel")),
      inhoud: parseNumber(get("Inhoud")),
      slaapkamers: slaapkamers,
      kamersRaw: kamersRaw,
      bouwjaar: parseNumber(get("Bouwjaar")),
      specifiek: specifiek,
      energielabel: get("Energielabel"),
      isolatieRaw: isolatieRaw,
      ketelJaar: ketelJaar,
      ketelRaw: ketelRaw,
      liggingRaw: get("Ligging"),
      tuinM2: tuinM2,
      tuinRaw: tuinRaw,
      tuinDelen: tuinDelen.join(" + "),
      tuinAanwezig: tuinAanwezig,
      bergingRaw: get("Schuur/berging"),
      eigendom: get("Eigendomssituatie"),
      woningtype: get("Soort woonhuis")
    };
  }

  // ---------- pyfunda-brug ----------
  // Lokale server (bridge/bridge.py) levert de velden uit Funda's eigen API.
  // Staat de brug uit, dan blijft de DOM-parse leidend.

  const BRIDGE_URL = "http://127.0.0.1:8765";

  // De brug staat niet altijd op 8765: op deze machine bezet de
  // claudecodebrowser-MCP die poort al. We zoeken eenmalig een poort die
  // antwoordt op /health en onthouden die in chrome.storage.local.
  const BRIDGE_POORTS = [8765, 8767, 8768, 8769, 8770];
  const BRIDGE_POORT_KEY = "bridgePort";

  let bridgeBasis = null; // gevonden basis-url, daarna hergebruikt
  let bridgeBezig = null; // lopende zoekactie

  async function bridgeOnthouden(poort) {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local)
        await chrome.storage.local.set({ [BRIDGE_POORT_KEY]: poort });
    } catch (e) { }
  }

  // Let op: een vreemde server op dezelfde poort antwoordt ook, maar zonder
  // "ok": true. Daarom op dat veld controleren en niet alleen op HTTP 200.
  async function bridgeProbeer(poort) {
    const basis = `http://127.0.0.1:${poort}`;
    try {
      const res = await fetch(`${basis}/health`, { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok === true ? basis : null;
    } catch (e) {
      return null;
    }
  }

  function poortVan(basis) {
    return Number(String(basis).split(":").pop());
  }

  async function resolveBridgeUrl() {
    if (bridgeBasis) return bridgeBasis;
    if (bridgeBezig) return bridgeBezig;

    bridgeBezig = (async () => {
      let voorkeur = BRIDGE_URL;
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          const store = await chrome.storage.local.get(BRIDGE_POORT_KEY);
          if (store && store[BRIDGE_POORT_KEY]) voorkeur = `http://127.0.0.1:${store[BRIDGE_POORT_KEY]}`;
        }
      } catch (e) { }

      const orde = [voorkeur].concat(
        BRIDGE_POORTS.map((p) => `http://127.0.0.1:${p}`).filter((u) => u !== voorkeur)
      );
      for (const basis of orde) {
        if (await bridgeProbeer(poortVan(basis))) {
          bridgeBasis = basis;
          if (basis !== voorkeur) await bridgeOnthouden(poortVan(basis));
          return basis;
        }
      }

      // Niets gevonden: niet onthouden, zodat een later gestarte brug alsnog
      // gevonden wordt. fetchBridge/fetchAdres vallen terug op DOM-only.
      return voorkeur;
    })();

    try {
      return await bridgeBezig;
    } finally {
      bridgeBezig = null;
    }
  }

  async function fetchBridge(url) {
    const basis = await resolveBridgeUrl();
    try {
      const res = await fetch(`${basis}/listing?url=${encodeURIComponent(url)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok ? data : null;
    } catch (e) {
      return null;
    }
  }

  // Werkt ook voor woningen die van Funda verdwenen zijn: Walter zoekt op
  // adres + postcode, niet op listing-id.
  async function fetchAdres(query) {
    const basis = await resolveBridgeUrl();
    try {
      const res = await fetch(`${basis}/adres?q=${encodeURIComponent(query)}`);
      return await res.json();
    } catch (e) {
      return { ok: false, error: "brug niet bereikbaar op " + basis };
    }
  }

  // API-waarden winnen: de DOM-parse breekt zodra Funda labels hernoemt.
  const BRIDGE_VELDEN = [
    "prijs",
    "prijsPerM2",
    "buurtPrijsPerM2",
    "woonopp",
    "perceel",
    "inhoud",
    "slaapkamers",
    "bouwjaar",
    "energielabel",
    "woningtype"
  ];

  function mergeBridge(huis, data) {
    if (!data) return huis;
    const out = Object.assign({}, huis);
    for (const veld of BRIDGE_VELDEN) {
      const v = data[veld];
      if (v !== null && v !== undefined) out[veld] = v;
    }
    if (data.status) out.status = data.status === "available" ? "Beschikbaar" : data.status;
    if (data.adres) out.adres = data.adres;
    out.buurt = data.buurt || null;
    out.stad = data.stad || null;
    out.bekeken = data.bekeken ?? null;
    out.bewaard = data.bewaard ?? null;
    out.publicatiedatum = data.publicatiedatum || null;
    out.prijsHistorie = data.prijsHistorie || [];
    out.bridge = true;

    const dalingen = out.prijsHistorie.filter((c) => /verlaag|lower|decrease/i.test(c.status || ""));
    out.prijsDalingen = dalingen.length;
    const eerste = out.prijsHistorie[out.prijsHistorie.length - 1];
    out.eerstePrijs = eerste && eerste.prijs ? eerste.prijs : null;

    mergeKenmerken(out, data);
    return out;
  }

  // "Isolatie" en "Cv-ketel" staan in meerdere secties; de sectievolgorde hier
  // bepaalt welke wint (Bergruimte heeft een eigen Isolatie-regel).
  function kenmerk(data, secties, label) {
    const k = data.kenmerken || {};
    for (const naam of secties) {
      const sec = k[naam];
      if (sec && sec[label] !== undefined && sec[label] !== null) return sec[label];
    }
    return null;
  }

  function mergeKenmerken(out, data) {
    if (!data.kenmerken) return;

    const isolatie = kenmerk(data, ["Indeling", "Energie"], "Isolatie");
    if (isolatie) out.isolatieRaw = isolatie;

    const ketel = kenmerk(data, ["Indeling", "Energie"], "Cv-ketel");
    if (ketel) {
      out.ketelRaw = ketel;
      const m = String(ketel).match(/(19|20)\d{2}/);
      if (m) out.ketelJaar = parseInt(m[0], 10);
    }

    const ligging = kenmerk(data, ["Buitenruimte"], "Ligging");
    if (ligging) out.liggingRaw = ligging;

    const berging = kenmerk(data, ["Bergruimte"], "Schuur/berging");
    if (berging) out.bergingRaw = berging;

    const specifiek = kenmerk(data, ["Bouw"], "Specifiek");
    if (specifiek) out.specifiek = specifiek;

    const buiten = data.kenmerken["Buitenruimte"];
    if (buiten) {
      let m2 = 0;
      const delen = [];
      for (const veld of TUIN_VELDEN) {
        const v = parseNumber(buiten[veld]);
        if (v) {
          m2 += v;
          delen.push(`${veld.toLowerCase()} ${v} m²`);
        }
      }
      // gebouwgebonden buitenruimte staat bij de oppervlakten, niet bij Buitenruimte
      if (data.buitenruimte) {
        m2 += data.buitenruimte;
        delen.push(`gebouwgebonden buitenruimte ${data.buitenruimte} m²`);
      }
      out.tuinM2 = m2;
      out.tuinDelen = delen.join(" + ");
      out.tuinRaw = buiten["Tuin"] || out.tuinRaw;
      out.tuinAanwezig = m2 > 0 || Boolean(out.tuinRaw);
    }
  }

  // ---------- scores per metriek (0..10, of null = onbekend) ----------

  const ENERGY_SCORES = {
    G: 0,
    F: 1.5,
    E: 3,
    D: 4.5,
    C: 6,
    B: 7.5,
    A: 9,
    "A+": 9.4,
    "A++": 9.6,
    "A+++": 9.8,
    "A++++": 10
  };

  function energyScore(label) {
    if (!label) return null;
    const clean = label.trim().toUpperCase().replace(/\s/g, "");
    const s = ENERGY_SCORES[clean];
    return s === undefined ? null : s;
  }

  function isolatieScore(raw) {
    if (!raw) return null;
    const t = raw.toLowerCase();
    if (/geen isolatie/.test(t)) return 0;
    let punten = 0;
    if (/volledig ge[iï]soleerd/.test(t)) punten += 6;
    if (/hr\+\+\+/.test(t)) punten += 4;
    else if (/hr\+\+/.test(t)) punten += 3;
    else if (/hr-?glas|dubbel glas/.test(t)) punten += 2;
    if (/dakisolatie/.test(t)) punten += 2;
    if (/muurisolatie|spouwmuur/.test(t)) punten += 2;
    if (/vloerisolatie/.test(t)) punten += 2;
    // "gedeeltelijk dubbel glas" is geen dubbel glas
    if (/gedeeltelijk/.test(t)) punten = punten / 2;
    return clamp(punten, 0, 10);
  }

  function klusScore(h) {
    const spec = (h.specifiek || "").toLowerCase();
    if (/kluswoning|te renoveren|casco/.test(spec)) return 0;
    if (/nieuwbouw/.test(spec)) return 10;
    return null; // Funda meldt niets bijzonders: metriek telt niet mee
  }

  function metricScores(h) {
    const nu = new Date().getFullYear();

    // Met referentie telt de vraagprijs zelf: goedkoop t.o.v. het aanbod = hoog.
    let prijsScore = null;
    if (referentie) {
      const p = percentiel(referentie.ladders.prijs, h.prijs);
      prijsScore = p === null ? null : (1 - p) * 10;
    } else if (h.prijsPerM2 && h.buurtPrijsPerM2) {
      prijsScore = scale(h.prijsPerM2 / h.buurtPrijsPerM2, 1.4, 0.8);
    } else if (h.prijsPerM2) {
      prijsScore = scale(h.prijsPerM2, 7000, 2000);
    }

    let liggingScore = null;
    if (h.liggingRaw) {
      const l = h.liggingRaw.toLowerCase();
      if (/drukke weg/.test(l)) liggingScore = 1;
      else if (/rustige weg/.test(l)) liggingScore = 9;
      else if (/woonwijk|beschutte/.test(l)) liggingScore = 6;
      else liggingScore = 5;
      if (/vrij uitzicht|bosrand|water/.test(l)) liggingScore = clamp(liggingScore + 1, 0, 10);
    }

    // h.beperkt: bron kent tuin/berging niet (kaart-API), dan als onbekend laten
    let bergingScore = null;
    if (h.bergingRaw) bergingScore = /geen/i.test(h.bergingRaw) ? 0 : 10;
    else if (h.woonopp && !h.beperkt) bergingScore = 0; // veld ontbreekt = geen berging vermeld

    let tuinScore = null;
    if (h.tuinM2 > 0) tuinScore = scale(h.tuinM2, 0, 60);
    else if (h.tuinAanwezig) tuinScore = 5; // tuin vermeld, maat onbekend
    else if (h.woonopp && !h.beperkt) tuinScore = 0;

    return {
      prijsVsBuurt: prijsScore,
      energie: energyScore(h.energielabel),
      woonopp: referentie
        ? maalTien(percentiel(referentie.ladders.woonopp, h.woonopp))
        : scale(h.woonopp, 55, 195),
      slaapkamers:
        referentie && referentie.ladders.slaapkamers
          ? maalTien(percentiel(referentie.ladders.slaapkamers, h.slaapkamers))
          : scale(h.slaapkamers, 1, 4),
      buitenruimte: tuinScore,
      klus: klusScore(h),
      bouwjaar: scale(h.bouwjaar, 1900, 2000),
      berging: bergingScore,
      ligging: liggingScore,
      ketel: h.ketelJaar === null ? null : scale(nu - h.ketelJaar, 18, 2),
      isolatie: isolatieScore(h.isolatieRaw),
      perceel: scale(h.perceel, 15, 200)
    };
  }

  // ---------- totaalscore ----------

  // Alleen de metrieken die de zoek-API ook levert, zodat de score op de
  // detailpagina hetzelfde getal is als de ring op de kaart.
  const SCORE_METRICS = ["prijsVsBuurt", "energie", "woonopp", "slaapkamers"];

  const maalTien = (p) => (p === null ? null : p * 10);

  function ruweScore(h, weights) {
    const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
    const m = metricScores(h);
    let som = 0;
    let gewicht = 0;
    for (const key of SCORE_METRICS) {
      const s = m[key];
      if (s === null || s === undefined) continue;
      som += s * w[key];
      gewicht += w[key];
    }
    return gewicht > 0 ? som / gewicht : null;
  }

  function totalScore(h, weights) {
    const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
    const m = metricScores(h);
    let som = 0;
    let gewicht = 0;
    const ontbreekt = [];
    const notities = [];

    for (const key of SCORE_METRICS) {
      const s = m[key];
      if (s === null || s === undefined) {
        ontbreekt.push(METRIC_LABELS[key] || key);
        continue;
      }
      som += s * w[key];
      gewicht += w[key];
    }

    if (!referentie && h.prijsPerM2 && !h.buurtPrijsPerM2)
      notities.push("Geen buurtgemiddelde: prijs/m² op absolute schaal gescoord.");
    if (h.tuinAanwezig && !(h.tuinM2 > 0))
      notities.push("Tuin vermeld zonder oppervlak: als middenscore gerekend.");

    let score = gewicht > 0 ? som / gewicht : null;
    if (score !== null && referentie && referentie.scores)
      score = cijfer(percentiel(referentie.scores, score));
    const waarde = score !== null && h.prijs ? score / (h.prijs / 100000) : null;

    return { score, waarde, metrics: m, ontbreekt, notities };
  }

  // ---------- breekpunten ----------

  function breekpunten(h, filters) {
    const f = Object.assign({}, DEFAULT_FILTERS, filters || {});
    const uit = [];
    if (h.status && !/beschikbaar/i.test(h.status)) uit.push(h.status.toLowerCase());
    if (f.minSlaapkamers > 0 && h.slaapkamers !== null && h.slaapkamers < f.minSlaapkamers)
      uit.push(`< ${f.minSlaapkamers} slaapkamers`);
    if (f.minWoonopp > 0 && h.woonopp !== null && h.woonopp < f.minWoonopp)
      uit.push(`< ${f.minWoonopp} m² wonen`);
    if (f.maxPrijs > 0 && h.prijs !== null && h.prijs > f.maxPrijs)
      uit.push(`boven € ${f.maxPrijs.toLocaleString("nl-NL")}`);
    if (f.tuinVerplicht && !h.tuinAanwezig) uit.push("geen tuin");
    if (f.bergingVerplicht && !(h.bergingRaw && !/geen/i.test(h.bergingRaw)))
      uit.push("geen berging");
    return uit;
  }

  return {
    DEFAULT_WEIGHTS,
    DEFAULT_FILTERS,
    METRIC_LABELS,
    SCORE_METRICS,
    setReferentie,
    parseListing,
    parseNumber,
    fetchBridge,
    fetchAdres,
    resolveBridgeUrl,
    mergeBridge,
    BRIDGE_URL,
    BRIDGE_POORTS,
    metricScores,
    totalScore,
    breekpunten
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FundaScore;
