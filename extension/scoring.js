/* Funda Scorer - gedeelde parse- en scorelogica.
   Wordt geladen door zowel content.js als popup.js. */

const FundaScore = (() => {
  "use strict";

  // ---------- standaardinstellingen ----------

  // Alleen deze metrieken tellen mee voor de score. De zoek-API (en dus de
  // ringen op de kaart) levert precies deze velden, zodat de score op de
  // detailpagina hetzelfde getal is als de ring op de kaart. De overige
  // kenmerken worden wel getoond maar zijn niet weegbaar, zodat er geen
  // schuifjes in de popup staan die niets doen.
  const SCORE_METRICS = ["prijsVsBuurt", "energie", "woonopp", "slaapkamers"];

  const INFO_METRICS = [
    "buitenruimte",
    "berging",
    "perceel",
    "bouwjaar",
    "klus",
    "ligging",
    "ketel",
    "isolatie"
  ];

  const DEFAULT_WEIGHTS = {
    prijsVsBuurt: 35,
    energie: 20,
    woonopp: 30,
    slaapkamers: 15
  };

  // Vaste schalen als er geen referentieaanbod is. Woonoppervlak verschilt te
  // veel tussen woningtypen voor één band: 48 m² is krap voor een huis maar
  // heel gewoon voor een appartement.
  const WOONOPP_BAND = {
    appartement: [30, 120],
    huis: [60, 220]
  };

  // Kopregels uit de kenmerken-tabel. afterLabel gebruikt ze om te weigeren:
  // heeft een rij geen waarde, dan staat de volgende kopregel er direct achter
  // en mag die niet als waarde gelden (gebeurde bij "Patio/atrium" ->
  // "Parkeergelegenheid").
  const SECTIE_KOPPEN = [
    "Overdracht",
    "Bouw",
    "Oppervlakten en inhoud",
    "Indeling",
    "Energie",
    "Kadastrale gegevens",
    "Buitenruimte",
    "Parkeergelegenheid",
    "VvE checklist",
    "Bergruimte",
    "Voorzieningen",
    "Servicekosten",
    "Garage"
  ];

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
  // schalen. De referentie is een gewoon object dat je meegeeft aan
  // metricScores/totalScore: geen verborgen staat, dus dezelfde invoer geeft
  // altijd dezelfde uitvoer.
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

  function maakReferentie(aanbod, weights) {
    if (!Array.isArray(aanbod) || aanbod.length < 5) return null;

    const ladders = {
      prijs: ladder(aanbod.map((h) => h.prijs)),
      woonopp: ladder(aanbod.map((h) => h.woonopp)),
      slaapkamers: ladder(aanbod.map((h) => h.slaapkamers))
    };
    if (!ladders.prijs || !ladders.woonopp) return null;

    // De ijkwaarden gebruiken dezelfde wegingen als de score zelf, anders is
    // het cijfer niet consistent met het ruwe getal.
    const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
    const ruw = aanbod.map((h) => ruweScore(h, w, null)).filter((s) => s !== null);
    return { ladders, scores: ladder(ruw) };
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

  const norm = (s) =>
    typeof FundaCommon !== "undefined"
      ? FundaCommon.normaliseer(s)
      : String(s === null || s === undefined ? "" : s).replace(/\s+/g, " ").trim();

  const isKopregel = (regel) => SECTIE_KOPPEN.includes(norm(regel));

  function textLines(root) {
    const raw = (root || document.body).innerText || "";
    return raw.split("\n").map(norm);
  }

  // Pakt de waarde achter een label. Heeft de rij geen waarde, dan volgt de
  // volgende kopregel direct: die wordt geweigerd in plaats van als waarde
  // door te gaan.
  function afterLabel(lines, label, offset) {
    const skip = offset || 0;
    const doel = norm(label);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== doel) continue;
      let seen = 0;
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        if (lines[j] === "") continue;
        if (seen === skip) return isKopregel(lines[j]) ? null : lines[j];
        seen++;
      }
    }
    return null;
  }

  // Sommige labels staan meerdere keren op de pagina ("Cv-ketel" staat zowel
  // als waarde bij Verwarming/Warm water als label bij het toestel; "Isolatie"
  // staat bij Energie en nog eens bij de berging). Deze variant loopt alle
  // voorkomens af en pakt de eerste waarde die op het patroon past.
  function afterLabelMatching(lines, label, regex) {
    const doel = norm(label);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== doel) continue;
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (lines[j] === "" || lines[j] === doel) continue;
        if (isKopregel(lines[j])) break;
        if (regex.test(lines[j])) return lines[j];
        break;
      }
    }
    return null;
  }

  function parseTitleAddress() {
    // Eerst de og:title-meta, dan de paginatitel
    // ("Huis te koop: Nijhoffstraat 3 6821 BG Arnhem | Funda").
    const og = document.querySelector('meta[property="og:title"]');
    for (const ruw of [og && og.getAttribute("content"), document.title]) {
      const t = norm(ruw);
      if (!t) continue;
      const m = t.match(/^[^:]*:\s*(.+?)\s*\|\s*/) || t.match(/^[^:]*:\s*(.+)$/);
      const adres = norm(m ? m[1] : t.replace(/\|\s*Funda\s*$/, ""));
      if (adres) return adres;
    }
    return "";
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

  // Eén implementatie voor beide bronnen (paginatekst en API); eerst waren het
  // er twee die net anders rekenden.
  function tuinVan(zoek) {
    let m2 = 0;
    const delen = [];
    for (const veld of TUIN_VELDEN) {
      const v = parseNumber(zoek(veld));
      if (v) {
        m2 += v;
        delen.push(`${veld.toLowerCase()} ${v} m²`);
      }
    }
    return { m2, delen: delen.join(" + ") };
  }

  // Alleen echte labels accepteren, zodat een kopregel er niet als
  // energielabel in komt. Funda's API schrijft de klasse met het aantal plussen
  // als cijfer ("A3"), de pagina zelf schrijft "A+++" — die twee gelijktrekken.
  function energieLabel(waarde) {
    if (!waarde) return null;
    const t = norm(waarde).toUpperCase().replace(/\s/g, "");
    if (/^(A\+*|B|C|D|E|F|G)$/.test(t)) return t;
    const m = t.match(/^A([1-4])$/);
    return m ? "A" + "+".repeat(Number(m[1])) : null;
  }

  function statusWaarde(waarde) {
    if (!waarde) return null;
    const t = norm(waarde);
    return isKopregel(t) ? null : t;
  }

  // "Soort woonhuis" staat niet op elke pagina (bij appartementen ontbreekt het
  // label), dus leiden we het type ook af uit de url en de titel. Anders kreeg
  // een appartement de huisband en scoorde het op woonoppervlak 0.
  function typeHint() {
    const bron = `${location.pathname} ${document.title}`.toLowerCase();
    return /appartement|benedenwoning|bovenwoning|portiekflat|galerijflat|studio/.test(bron)
      ? "appartement"
      : null;
  }

  function parseListing() {
    const lines = textLines();
    const get = (label, offset) => afterLabel(lines, label, offset);

    const kamersRaw = get("Aantal kamers");
    let slaapkamers = null;
    if (kamersRaw) {
      // "5 kamers (4 slaapkamers)" wel, "2 kamers" niet: het totaal aantal
      // kamers is niet het aantal slaapkamers, dus dan blijft het onbekend.
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
    const tuin = tuinVan((veld) => get(veld));
    const tuinM2 = tuin.m2;
    const tuinDelen = tuin.delen;
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
      status: statusWaarde(get("Status")),
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
      energielabel: energieLabel(get("Energielabel")),
      isolatieRaw: isolatieRaw,
      ketelJaar: ketelJaar,
      ketelRaw: ketelRaw,
      liggingRaw: get("Ligging"),
      tuinM2: tuinM2,
      tuinRaw: tuinRaw,
      tuinDelen: tuinDelen,
      tuinAanwezig: tuinAanwezig,
      bergingRaw: get("Schuur/berging"),
      eigendom: get("Eigendomssituatie"),
      woningtype: get("Soort woonhuis"),
      typeHint: typeHint()
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
      if (typeof FundaCommon !== "undefined") {
        await FundaCommon.schrijf({ [BRIDGE_POORT_KEY]: poort });
      } else if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [BRIDGE_POORT_KEY]: poort });
      }
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
        let poort = null;
        if (typeof FundaCommon !== "undefined") {
          poort = (await FundaCommon.lees(BRIDGE_POORT_KEY))[BRIDGE_POORT_KEY];
        } else if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          poort = (await chrome.storage.local.get(BRIDGE_POORT_KEY))[BRIDGE_POORT_KEY];
        }
        if (poort) voorkeur = `http://127.0.0.1:${poort}`;
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

  const BRIDGE_NUMERIEK = [
    "prijs",
    "prijsPerM2",
    "buurtPrijsPerM2",
    "woonopp",
    "perceel",
    "inhoud",
    "slaapkamers",
    "bouwjaar"
  ];

  function mergeBridge(huis, data) {
    if (!data) return huis;
    const out = Object.assign({}, huis);
    for (const veld of BRIDGE_VELDEN) {
      const v = data[veld];
      if (v === null || v === undefined) continue;
      // Een waarde die we niet kunnen lezen mag de goede paginatekst niet
      // overschrijven; anders komt er bijvoorbeeld "A3" of "onbekend" in.
      if (veld === "energielabel") {
        const label = energieLabel(v);
        if (label) out[veld] = label;
        continue;
      }
      if (BRIDGE_NUMERIEK.includes(veld)) {
        const n = typeof v === "number" ? v : parseNumber(v);
        if (n !== null) out[veld] = n;
        continue;
      }
      out[veld] = v;
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

  // "Isolatie" en "Cv-ketel" staan in meerdere secties; de voorkeursvolgorde
  // hier bepaalt welke wint (Bergruimte heeft een eigen Isolatie-regel). Valt
  // Funda een sectienaam om, dan zoeken we alsnog in alle secties.
  function kenmerk(data, secties, label) {
    const k = data.kenmerken || {};
    const orde = secties.concat(Object.keys(k).filter((n) => !secties.includes(n)));
    for (const naam of orde) {
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

    const buiten = data.kenmerken["Buitenruimte"] || data.kenmerken["Tuin"] || null;
    if (buiten) {
      const tuin = tuinVan((veld) => buiten[veld]);
      let m2 = tuin.m2;
      const delen = tuin.delen ? [tuin.delen] : [];
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
    const t = String(raw).toLowerCase();
    if (/geen isolatie/.test(t)) return 0;

    let punten = 0;
    let herkend = false;
    if (/volledig ge[iï]soleerd/.test(t)) { punten += 6; herkend = true; }
    if (/hr\+\+\+/.test(t)) { punten += 4; herkend = true; }
    else if (/hr\+\+/.test(t)) { punten += 3; herkend = true; }
    else if (/hr-?glas|dubbel glas|drievoudig|triple/.test(t)) { punten += 2; herkend = true; }
    if (/dakisolatie/.test(t)) { punten += 2; herkend = true; }
    if (/muurisolatie|spouwmuur/.test(t)) { punten += 2; herkend = true; }
    if (/vloerisolatie/.test(t)) { punten += 2; herkend = true; }

    // Onbekende tekst levert geen 0 op: dan weten we het niet.
    if (!herkend) return null;
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

  // Woonoppervlak zonder referentie: kies de band bij het woningtype.
  function woonoppScore(h, ref) {
    if (ref) return maalTien(percentiel(ref.ladders.woonopp, h.woonopp));
    if (h.woonopp === null || h.woonopp === undefined) return null;
    const type = `${h.woningtype || ""} ${h.typeHint || ""}`.toLowerCase();
    const band = WOONOPP_BAND[type.includes("appartement") ? "appartement" : "huis"];
    return scale(h.woonopp, band[0], band[1]);
  }

  function metricScores(h, ref) {
    const nu = new Date().getFullYear();
    const r = ref || null;

    // Met referentie telt de vraagprijs zelf: goedkoop t.o.v. het aanbod = hoog.
    let prijsScore = null;
    if (r) {
      const p = percentiel(r.ladders.prijs, h.prijs);
      prijsScore = p === null ? null : (1 - p) * 10;
    } else if (h.prijsPerM2 && h.buurtPrijsPerM2) {
      prijsScore = scale(h.prijsPerM2 / h.buurtPrijsPerM2, 1.4, 0.8);
    } else if (h.prijsPerM2) {
      prijsScore = scale(h.prijsPerM2, 7000, 2000);
    }

    // Onbekende tekst wordt niet als "gemiddeld" gescoord: dan is de ligging
    // simpelweg niet te beoordelen.
    let liggingScore = null;
    if (h.liggingRaw) {
      const l = String(h.liggingRaw).toLowerCase();
      if (/drukke weg/.test(l)) liggingScore = 1;
      else if (/rustige weg/.test(l)) liggingScore = 9;
      else if (/woonwijk|beschutte/.test(l)) liggingScore = 6;
      else if (/vrij uitzicht|bosrand|water/.test(l)) liggingScore = 7;
      if (liggingScore !== null && /vrij uitzicht|bosrand|water/.test(l))
        liggingScore = clamp(liggingScore + 1, 0, 10);
    }

    // Een ontbrekend veld betekent onbekend, niet "geen".
    let bergingScore = null;
    if (h.bergingRaw) bergingScore = /geen/i.test(h.bergingRaw) ? 0 : 10;

    let tuinScore = null;
    if (h.tuinM2 > 0) tuinScore = scale(h.tuinM2, 0, 60);
    else if (h.tuinAanwezig) tuinScore = 5; // tuin vermeld, maat onbekend

    return {
      prijsVsBuurt: prijsScore,
      energie: energyScore(h.energielabel),
      woonopp: woonoppScore(h, r),
      slaapkamers:
        r && r.ladders.slaapkamers
          ? maalTien(percentiel(r.ladders.slaapkamers, h.slaapkamers))
          : scale(h.slaapkamers, 1, 4),
      buitenruimte: tuinScore,
      klus: klusScore(h),
      bouwjaar: scale(h.bouwjaar, 1900, 2000),
      berging: bergingScore,
      ligging: liggingScore,
      ketel: h.ketelJaar === null || h.ketelJaar === undefined ? null : scale(nu - h.ketelJaar, 18, 2),
      isolatie: isolatieScore(h.isolatieRaw),
      perceel: scale(h.perceel, 15, 200)
    };
  }

  // ---------- totaalscore ----------

  const maalTien = (p) => (p === null ? null : p * 10);

  function telOp(m, w) {
    let som = 0;
    let gewicht = 0;
    let totaalGewicht = 0;
    const ontbreekt = [];
    for (const key of SCORE_METRICS) {
      totaalGewicht += w[key];
      const s = m[key];
      if (s === null || s === undefined) {
        ontbreekt.push(METRIC_LABELS[key] || key);
        continue;
      }
      som += s * w[key];
      gewicht += w[key];
    }
    return { som, gewicht, totaalGewicht, ontbreekt };
  }

  function ruweScore(h, weights, ref) {
    const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
    const { som, gewicht } = telOp(metricScores(h, ref), w);
    return gewicht > 0 ? som / gewicht : null;
  }

  function totalScore(h, weights, ref) {
    const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
    const r = ref || null;
    const m = metricScores(h, r);
    const { som, gewicht, totaalGewicht, ontbreekt } = telOp(m, w);
    const notities = [];

    if (!r) {
      notities.push("Geen referentieaanbod: percentielscores uit.");
      if (h.woonopp)
        notities.push("Woonoppervlak op vaste schaal voor dit woningtype.");
    }
    if (!r && h.prijsPerM2 && !h.buurtPrijsPerM2)
      notities.push("Geen buurtgemiddelde: prijs/m² op absolute schaal gescoord.");
    if (h.tuinAanwezig && !(h.tuinM2 > 0))
      notities.push("Tuin vermeld zonder oppervlak: als middenscore gerekend.");

    // De score telt alleen de metrieken die er zijn. Zonder volledige dekking
    // zijn scores onderling niet goed vergelijkbaar, dus dat wordt gemeld.
    const dekking = totaalGewicht > 0 ? gewicht / totaalGewicht : 0;

    let score = gewicht > 0 ? som / gewicht : null;
    if (score !== null && r && r.scores) score = cijfer(percentiel(r.scores, score));
    const waarde = score !== null && h.prijs ? score / (h.prijs / 100000) : null;

    return { score, waarde, metrics: m, ontbreekt, notities, dekking };
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
    INFO_METRICS,
    maakReferentie,
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
