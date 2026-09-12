/* Funda Scorer - content script.
   Zet een paneel rechtsonder op elke koop-detailpagina met de geparste
   kenmerken, de score en een opslaanknop. */

(() => {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const PANEL_ID = "fundascorer-panel";

  if (document.getElementById(PANEL_ID)) return;

  const fmt = (n, suffix) =>
    n === null || n === undefined ? "—" : n.toLocaleString("nl-NL") + (suffix || "");

  const euro = (n) => (n === null || n === undefined ? "—" : "€ " + n.toLocaleString("nl-NL"));

  // jaartallen zonder duizendtalscheiding: 1904, niet 1.904
  const jaar = (n) => (n === null || n === undefined ? "—" : String(n));

  function scoreClass(s) {
    if (s === null) return "fs-na";
    if (s >= 7) return "fs-goed";
    if (s >= 5) return "fs-matig";
    return "fs-slecht";
  }

  function bar(value) {
    const pct = value === null ? 0 : Math.round(value * 10);
    return `<span class="fs-bar"><span class="fs-bar-fill ${scoreClass(
      value
    )}" style="width:${pct}%"></span></span>`;
  }

  // Het aanbod in dezelfde stad binnen je maxPrijs is de meetlat voor de score.
  async function aanbod(stad, maxPrijs) {
    if (!stad) return null;
    const slug = stad.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
    const store = await api.storage.local.get(["weights", "filters", "houses"]);
    const weights = store.weights || FundaScore.DEFAULT_WEIGHTS;
    const filters = store.filters || FundaScore.DEFAULT_FILTERS;
    const houses = store.houses || {};

    const parsed = FundaScore.parseListing();
    const huis = FundaScore.mergeBridge(parsed, await FundaScore.fetchBridge(parsed.url));
    FundaScore.setReferentie(await aanbod(huis.stad, filters.maxPrijs));
    const res = FundaScore.totalScore(huis, weights);
    const uit = FundaScore.breekpunten(huis, filters);
    const alOpgeslagen = Boolean(houses[huis.url]);

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
          ${Object.keys(FundaScore.DEFAULT_WEIGHTS)
        .map(
          (k) => `<div class="fs-metric">
                        <span class="fs-metric-lab">${FundaScore.METRIC_LABELS[k]}</span>
                        ${bar(res.metrics[k])}
                        <span class="fs-metric-num">${res.metrics[k] === null ? "n.b." : res.metrics[k].toFixed(1)
            }</span>
                      </div>`
        )
        .join("")}
        </div>
        ${uit.length
        ? `<p class="fs-flag">Valt af op: ${uit.join(", ")}</p>`
        : ""
      }
        ${res.notities.length
        ? `<p class="fs-missing">${res.notities.join(" ")}</p>`
        : ""
      }
        ${res.ontbreekt.length
        ? `<p class="fs-missing">Niet op de pagina gevonden: ${res.ontbreekt.join(
          ", "
        )}. Deze tellen niet mee.</p>`
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
      const current = await api.storage.local.get("houses");
      const map = current.houses || {};
      map[huis.url] = huis;
      await api.storage.local.set({ houses: map });
      panel.querySelector(".fs-status").textContent =
        "Opgeslagen. Open het icoon in de werkbalk voor de ranglijst.";
      panel.querySelector(".fs-save").textContent = "Opnieuw opslaan";
    });
  }

  build();
})();
