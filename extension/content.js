/* Funda Scorer - content script.
   Zet een paneel rechtsonder op elke koop-detailpagina met de geparste
   kenmerken, de score en een opslaanknop. */

(() => {
  "use strict";

  const PANEL_ID = "fundascorer-panel";

  if (document.getElementById(PANEL_ID)) return;

  const { euro, getal: fmt, jaar } = FundaCommon;
  const scoreClass = (s) => FundaCommon.scoreClass(s, "fs-", "fs-na");

  function bar(value) {
    const pct = value === null ? 0 : Math.round(value * 10);
    return `<span class="fs-bar"><span class="fs-bar-fill ${scoreClass(
      value
    )}" style="width:${pct}%"></span></span>`;
  }

  // Het aanbod in dezelfde stad binnen je maxPrijs is de meetlat voor de score.
  async function aanbod(stad, maxPrijs) {
    if (!stad) return null;
    const slug = FundaCommon.slugify(stad);
    const prijs = maxPrijs > 0 ? `&max_price=${maxPrijs}` : "";
    try {
      const basis = await FundaScore.resolveBridgeUrl();
      const res = await fetch(`${basis}/area?area=${slug}${prijs}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data && data.ok ? data.listings : null;
    } catch (e) {
      return null;
    }
  }

  async function build() {
    const [bewaard, bewaardFilters] = await Promise.all([
      FundaCommon.Store.weights(),
      FundaCommon.Store.filters()
    ]);
    const weights = Object.assign({}, FundaScore.DEFAULT_WEIGHTS, bewaard);
    const filters = Object.assign({}, FundaScore.DEFAULT_FILTERS, bewaardFilters);

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
    panel.innerHTML = `
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
          <dt>Prijs/m²</dt><dd>${euro(huis.prijsPerM2)} <span class="fs-dim">buurt ${euro(
      huis.buurtPrijsPerM2
    )}</span></dd>
          <dt>Wonen</dt><dd>${fmt(huis.woonopp, " m²")} · perceel ${fmt(huis.perceel, " m²")}</dd>
          <dt>Slaapkamers</dt><dd>${fmt(huis.slaapkamers)}</dd>
          <dt>Kamers</dt><dd>${huis.kamersRaw || "—"} · inhoud ${fmt(huis.inhoud, " m³")}</dd>
          <dt>Label</dt><dd>${huis.energielabel || "—"} · bouwjaar ${jaar(huis.bouwjaar)}</dd>
          <dt>Tuin</dt><dd>${huis.tuinM2
        ? fmt(huis.tuinM2, " m²") + (huis.tuinDelen ? ` <span class="fs-dim">${huis.tuinDelen}</span>` : "")
        : huis.tuinAanwezig
          ? "aanwezig, maat onbekend"
          : "geen"
      }</dd>
          <dt>Status</dt><dd>${huis.status || "—"}${huis.specifiek ? ` <span class="fs-dim">${huis.specifiek}</span>` : ""
      }</dd>
          <dt>Ligging</dt><dd>${huis.liggingRaw || "—"}</dd>
          <dt>Isolatie</dt><dd>${huis.isolatieRaw || "—"}</dd>
          <dt>Cv-ketel</dt><dd>${huis.ketelRaw
        ? `${jaar(huis.ketelJaar)} <span class="fs-dim">${huis.ketelRaw}</span>`
        : "—"
      }</dd>
          <dt>Berging</dt><dd>${huis.bergingRaw || "—"}</dd>
          <dt>Eigendom</dt><dd>${huis.eigendom || "—"}</dd>
          <dt>Waarde-index</dt><dd>${res.waarde === null ? "—" : res.waarde.toFixed(2) + " punt per € 100k"
      }</dd>
          <dt>Bron</dt><dd>${huis.bridge
        ? `pyfunda-API${huis.buurt ? ` · buurt ${huis.buurt}` : ""}`
        : `<span class="fs-dim">alleen pagina-tekst (brug uit)</span>`
      }</dd>
          ${huis.bridge && huis.prijsHistorie && huis.prijsHistorie.length
        ? `<dt>Prijshistorie</dt><dd>${huis.prijsHistorie.length} mutaties${huis.prijsDalingen ? ` · ${huis.prijsDalingen} verlaging(en)` : ""
        }${huis.eerstePrijs && huis.prijs && huis.eerstePrijs !== huis.prijs
          ? ` <span class="fs-dim">vanaf ${euro(huis.eerstePrijs)}</span>`
          : ""
        }</dd>`
        : ""
      }
          ${huis.bridge && (huis.bekeken || huis.bewaard)
        ? `<dt>Interesse</dt><dd>${fmt(huis.bekeken)} bekeken · ${fmt(
          huis.bewaard
        )} bewaard</dd>`
        : ""
      }
        </dl>
        <div class="fs-metrics">
          ${FundaScore.SCORE_METRICS.map(
        (k) => `<div class="fs-metric">
                        <span class="fs-metric-lab">${FundaScore.METRIC_LABELS[k]} <span class="fs-dim">×${weights[k]}</span></span>
                        ${bar(res.metrics[k])}
                        <span class="fs-metric-num">${res.metrics[k] === null ? "n.b." : res.metrics[k].toFixed(1)
          }</span>
                      </div>`
      ).join("")}
        </div>
        <details class="fs-extra" style="margin-top:10px">
          <summary>Overige kenmerken <span class="fs-dim">(tellen niet mee in de score)</span></summary>
          <div class="fs-metrics">
            ${FundaScore.INFO_METRICS.map(
        (k) => `<div class="fs-metric">
                        <span class="fs-metric-lab">${FundaScore.METRIC_LABELS[k]}</span>
                        ${bar(res.metrics[k])}
                        <span class="fs-metric-num">${res.metrics[k] === null ? "n.b." : res.metrics[k].toFixed(1)
          }</span>
                      </div>`
      ).join("")}
          </div>
        </details>
        ${uit.length
        ? `<p class="fs-flag">Valt af op: ${uit.join(", ")}</p>`
        : ""
      }
        ${res.notities.length
        ? `<p class="fs-missing">${res.notities.join(" ")}</p>`
        : ""
      }
        ${res.dekking < 1 && res.ontbreekt.length
        ? `<p class="fs-missing">Niet gevonden: ${res.ontbreekt.join(
          ", "
        )}. De score telt op ${Math.round(res.dekking * 100)}% van het gewicht, dus vergelijk met voorzichtigheid.</p>`
        : ""
      }
        <button class="fs-save" type="button">${alOpgeslagen ? "Opnieuw opslaan" : "Opslaan in ranglijst"
      }</button>
        <p class="fs-status" role="status"></p>
      </div>
    `;

    document.body.appendChild(panel);

    panel.querySelector(".fs-collapse").addEventListener("click", () => {
      panel.classList.toggle("fs-collapsed");
      panel.querySelector(".fs-collapse").textContent = panel.classList.contains(
        "fs-collapsed"
      )
        ? "+"
        : "–";
    });

    panel.querySelector(".fs-save").addEventListener("click", async () => {
      const aantal = await FundaCommon.Store.bewaarHuis(huis);
      panel.querySelector(".fs-status").textContent =
        `Opgeslagen (${aantal} in de ranglijst). Open het icoon in de werkbalk.`;
      panel.querySelector(".fs-save").textContent = "Opnieuw opslaan";
    });
  }

  build();
})();
