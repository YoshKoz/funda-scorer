/* Funda Scorer - content script.
   Zet een paneel rechtsonder op elke koop-detailpagina met de geparste
   kenmerken, de score en een opslaanknop. */

(() => {
  "use strict";

  const PANEL_ID = "fundascorer-panel";

  if (document.getElementById(PANEL_ID)) return;

  const { euro, getal: fmt, jaar, scoreClass: scoreKlasse } = FundaCommon;
  const scoreClass = (s) => scoreKlasse(s, "fs-", "fs-na");

  function bar(value) {
    const pct = value === null ? 0 : Math.round(value * 10);
    const klasse = scoreClass(value);
    return `<span class="fs-bar"><span class="fs-bar-fill ${klasse}" style="width:${pct}%"></span></span>`;
  }

  // Het aanbod in dezelfde stad binnen je maxPrijs is de meetlat voor de score.
  // De brug is optioneel: zonder antwoord scoren we zonder referentie.
  async function aanbod(stad, maxPrijs) {
    if (!stad) return null;
    const slug = FundaCommon.slugify(stad);
    const prijs = maxPrijs > 0 ? `&max_price=${maxPrijs}` : "";
    try {
      const basis = await FundaScore.resolveBridgeUrl();
      const res = await fetch(`${basis}/area?area=${slug}${prijs}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data?.ok ? data.listings : null;
    } catch {
      return null;
    }
  }

  // ---------- teksten voor het paneel ----------
  // Losse functies in plaats van geneste ternaries in een template: dat houdt
  // build() leesbaar en de cognitieve complexiteit laag.

  function tuinTekst(huis) {
    if (huis.tuinM2) {
      const maat = fmt(huis.tuinM2, " m²");
      return huis.tuinDelen ? `${maat} <span class="fs-dim">${huis.tuinDelen}</span>` : maat;
    }
    return huis.tuinAanwezig ? "aanwezig, maat onbekend" : "geen";
  }

  function statusTekst(huis) {
    const basis = huis.status || "—";
    return huis.specifiek ? `${basis} <span class="fs-dim">${huis.specifiek}</span>` : basis;
  }

  function ketelTekst(huis) {
    if (!huis.ketelRaw) return "—";
    return `${jaar(huis.ketelJaar)} <span class="fs-dim">${huis.ketelRaw}</span>`;
  }

  function bronTekst(huis) {
    if (!huis.bridge) return `<span class="fs-dim">alleen pagina-tekst (brug uit)</span>`;
    const buurt = huis.buurt ? ` · buurt ${huis.buurt}` : "";
    return `pyfunda-API${buurt}`;
  }

  function historieRij(huis) {
    const historie = huis.prijsHistorie;
    if (!huis.bridge || !historie?.length) return "";
    const dalingen = huis.prijsDalingen ? ` · ${huis.prijsDalingen} verlaging(en)` : "";
    const vanaf =
      huis.eerstePrijs && huis.prijs && huis.eerstePrijs !== huis.prijs
        ? ` <span class="fs-dim">vanaf ${euro(huis.eerstePrijs)}</span>`
        : "";
    return `<dt>Prijshistorie</dt><dd>${historie.length} mutaties${dalingen}${vanaf}</dd>`;
  }

  function interesseRij(huis) {
    if (!huis.bridge || !(huis.bekeken || huis.bewaard)) return "";
    return `<dt>Interesse</dt><dd>${fmt(huis.bekeken)} bekeken · ${fmt(huis.bewaard)} bewaard</dd>`;
  }

  function metricRij(key, res, weights) {
    const waarde = res.metrics[key];
    const gewicht = weights ? ` <span class="fs-dim">×${weights[key]}</span>` : "";
    const nummer = waarde === null ? "n.b." : waarde.toFixed(1);
    return `<div class="fs-metric">
              <span class="fs-metric-lab">${FundaScore.METRIC_LABELS[key]}${gewicht}</span>
              ${bar(waarde)}
              <span class="fs-metric-num">${nummer}</span>
            </div>`;
  }

  function metricsBlok(keys, res, weights) {
    return keys.map((key) => metricRij(key, res, weights)).join("");
  }

  function blok(tekst, klasse) {
    return tekst ? `<p class="${klasse}">${tekst}</p>` : "";
  }

  function paneelHtml({ huis, res, uit, weights, alOpgeslagen }) {
    const waardeIndex = res.waarde === null ? "—" : `${res.waarde.toFixed(2)} punt per € 100k`;
    const opslaanLabel = alOpgeslagen ? "Opnieuw opslaan" : "Opslaan in ranglijst";
    const zonderReferentie =
      res.dekking < 1 && res.ontbreekt.length
        ? `Niet gevonden: ${res.ontbreekt.join(", ")}. De score telt op ` +
        `${Math.round(res.dekking * 100)}% van het gewicht, dus vergelijk met voorzichtigheid.`
        : "";

    return `
      <header class="fs-head">
        <span class="fs-title">Funda Scorer</span>
        <button class="fs-collapse" type="button" title="In-/uitklappen">–</button>
      </header>
      <div class="fs-body">
        <div class="fs-total ${scoreClass(res.score)}">
          <span class="fs-total-num">${res.score === null ? "—" : res.score.toFixed(1)}</span>
          <span class="fs-total-lab">van 10</span>
        </div>
        <dl class="fs-facts">
          <dt>Prijs</dt><dd>${euro(huis.prijs)}</dd>
          <dt>Prijs/m²</dt><dd>${euro(huis.prijsPerM2)} <span class="fs-dim">buurt ${euro(huis.buurtPrijsPerM2)}</span></dd>
          <dt>Wonen</dt><dd>${fmt(huis.woonopp, " m²")} · perceel ${fmt(huis.perceel, " m²")}</dd>
          <dt>Slaapkamers</dt><dd>${fmt(huis.slaapkamers)}</dd>
          <dt>Kamers</dt><dd>${huis.kamersRaw || "—"} · inhoud ${fmt(huis.inhoud, " m³")}</dd>
          <dt>Label</dt><dd>${huis.energielabel || "—"} · bouwjaar ${jaar(huis.bouwjaar)}</dd>
          <dt>Tuin</dt><dd>${tuinTekst(huis)}</dd>
          <dt>Status</dt><dd>${statusTekst(huis)}</dd>
          <dt>Ligging</dt><dd>${huis.liggingRaw || "—"}</dd>
          <dt>Isolatie</dt><dd>${huis.isolatieRaw || "—"}</dd>
          <dt>Cv-ketel</dt><dd>${ketelTekst(huis)}</dd>
          <dt>Berging</dt><dd>${huis.bergingRaw || "—"}</dd>
          <dt>Eigendom</dt><dd>${huis.eigendom || "—"}</dd>
          <dt>Waarde-index</dt><dd>${waardeIndex}</dd>
          <dt>Bron</dt><dd>${bronTekst(huis)}</dd>
          ${historieRij(huis)}
          ${interesseRij(huis)}
        </dl>
        <div class="fs-metrics">${metricsBlok(FundaScore.SCORE_METRICS, res, weights)}</div>
        <details class="fs-extra" style="margin-top:10px">
          <summary>Overige kenmerken <span class="fs-dim">(tellen niet mee in de score)</span></summary>
          <div class="fs-metrics">${metricsBlok(FundaScore.INFO_METRICS, res, null)}</div>
        </details>
        ${blok(uit.length ? `Valt af op: ${uit.join(", ")}` : "", "fs-flag")}
        ${blok(res.notities.join(" "), "fs-missing")}
        ${blok(zonderReferentie, "fs-missing")}
        <button class="fs-save" type="button">${opslaanLabel}</button>
        <p class="fs-status" role="status"></p>
      </div>
    `;
  }

  function koppelEvents(panel, huis) {
    const inklap = panel.querySelector(".fs-collapse");
    inklap.addEventListener("click", () => {
      panel.classList.toggle("fs-collapsed");
      inklap.textContent = panel.classList.contains("fs-collapsed") ? "+" : "–";
    });

    const opslaan = panel.querySelector(".fs-save");
    opslaan.addEventListener("click", async () => {
      const aantal = await FundaCommon.Store.bewaarHuis(huis);
      panel.querySelector(".fs-status").textContent =
        `Opgeslagen (${aantal} in de ranglijst). Open het icoon in de werkbalk.`;
      opslaan.textContent = "Opnieuw opslaan";
    });
  }

  async function build() {
    const [bewaard, bewaardFilters] = await Promise.all([
      FundaCommon.Store.weights(),
      FundaCommon.Store.filters()
    ]);
    const weights = { ...FundaScore.DEFAULT_WEIGHTS, ...bewaard };
    const filters = { ...FundaScore.DEFAULT_FILTERS, ...bewaardFilters };

    const parsed = FundaScore.parseListing();
    const huis = FundaScore.mergeBridge(parsed, await FundaScore.fetchBridge(parsed.url));
    // De referentie is een gewoon object: scoring.js heeft geen verborgen staat
    // meer, dus dezelfde invoer geeft altijd dezelfde score.
    const ref = FundaScore.maakReferentie(await aanbod(huis.stad, filters.maxPrijs), weights);
    const res = FundaScore.totalScore(huis, weights, ref);
    const uit = FundaScore.breekpunten(huis, filters);
    const alOpgeslagen = await FundaCommon.Store.heeftHuis(huis.url);

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = paneelHtml({ huis, res, uit, weights, alOpgeslagen });
    document.body.appendChild(panel);
    koppelEvents(panel, huis);
  }

  build();
})();
