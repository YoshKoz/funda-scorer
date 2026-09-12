/* Funda Scorer - popup */

(() => {
  "use strict";

  const { euro, scoreClass: scoreKlasse } = FundaCommon;
  const scoreClass = (s) => scoreKlasse(s, "", "");

  let houses = {};
  let weights = { ...FundaScore.DEFAULT_WEIGHTS };
  let filters = { ...FundaScore.DEFAULT_FILTERS };

  // Opgeslagen huizen zijn compleet (gescoord op de detailpagina), dus hier is
  // geen referentieaanbod nodig. Herberekenen gebeurt één keer per wijziging in
  // plaats van bij elke sortering.
  let scoreCache = null;
  let cacheSleutel = "";

  function berekend() {
    const sleutel = `${Object.keys(houses).length}|${JSON.stringify(weights)}|${JSON.stringify(filters)}`;
    if (scoreCache && sleutel === cacheSleutel) return scoreCache;
    scoreCache = Object.values(houses).map((h) => {
      const res = FundaScore.totalScore(h, weights, null);
      return {
        huis: h,
        score: res.score,
        waarde: res.waarde,
        dekking: res.dekking,
        vlaggen: FundaScore.breekpunten(h, filters)
      };
    });
    cacheSleutel = sleutel;
    return scoreCache;
  }

  function sorteer(rijen, mode) {
    const num = (v, fallback) => (v === null || v === undefined ? fallback : v);
    const copy = rijen.slice();
    switch (mode) {
      case "score-asc":
        return copy.sort((a, b) => num(a.score, 99) - num(b.score, 99));
      case "waarde":
        return copy.sort((a, b) => num(b.waarde, -1) - num(a.waarde, -1));
      case "prijs":
        return copy.sort((a, b) => num(a.huis.prijs, Infinity) - num(b.huis.prijs, Infinity));
      case "prijsm2":
        return copy.sort(
          (a, b) => num(a.huis.prijsPerM2, Infinity) - num(b.huis.prijsPerM2, Infinity)
        );
      default:
        return copy.sort((a, b) => num(b.score, -1) - num(a.score, -1));
    }
  }

  function tekenLijst() {
    const doel = document.getElementById("lijst");
    const rijen = sorteer(berekend(), document.getElementById("sort").value);

    if (!rijen.length) {
      doel.innerHTML =
        '<p class="leeg">Nog geen huizen opgeslagen. Open een koopwoning op funda.nl en klik in het paneel rechtsonder op “Opslaan in ranglijst”.</p>';
      return;
    }

    doel.innerHTML = rijen
      .map((r, i) => {
        const h = r.huis;
        return `<article class="kaart">
          <div class="rang">${i + 1}</div>
          <a class="kaart-adres" href="${h.url}" target="_blank" rel="noreferrer">${h.adres}</a>
          <div class="kaart-score ${scoreClass(r.score)}">${r.score === null ? "—" : r.score.toFixed(1)
          }</div>
          <div class="kaart-cijfers">
            ${euro(h.prijs)} · ${h.woonopp ?? "—"} m² · ${euro(h.prijsPerM2)}/m² ·
            label ${h.energielabel || "—"} · ${h.slaapkamers ?? "—"} slk ·
            waarde ${r.waarde === null ? "—" : r.waarde.toFixed(2)}${r.dekking < 1 ? ` · dekking ${Math.round(r.dekking * 100)}%` : ""
          }
          </div>
          <div class="kaart-acties"><button type="button" data-url="${h.url}">Verwijder</button></div>
          ${r.vlaggen.length ? `<div class="kaart-vlag">Valt af op: ${r.vlaggen.join(", ")}</div>` : ""}
        </article>`;
      })
      .join("");

    doel.querySelectorAll(".kaart-acties button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        delete houses[btn.dataset.url];
        scoreCache = null;
        await FundaCommon.Store.verwijderHuis(btn.dataset.url);
        tekenLijst();
      });
    });
  }

  function tekenWegingen() {
    const doel = document.getElementById("weegvelden");
    doel.innerHTML = FundaScore.SCORE_METRICS.map(
      (k) => `<label class="weeg">${FundaScore.METRIC_LABELS[k]}
                  <input type="number" min="0" max="100" step="1" data-weeg="${k}" value="${weights[k]}" />
                </label>`
    ).join("");

    doel.querySelectorAll("input[data-weeg]").forEach((inp) => {
      inp.addEventListener("change", async () => {
        const v = Number.parseInt(inp.value, 10);
        weights[inp.dataset.weeg] = Number.isNaN(v) ? 0 : Math.max(0, v);
        scoreCache = null;
        await FundaCommon.schrijf({ weights });
        tekenWegingen();
        tekenLijst();
      });
    });

    // De overige kenmerken zijn niet weegbaar: de zoek-API levert ze niet, dus
    // ze zouden de score op de kaart en de detailpagina uit elkaar trekken.
    const info = document.getElementById("info-metrics");
    if (info)
      info.innerHTML = FundaScore.INFO_METRICS.map(
        (k) =>
          `<span class="weeg-info" style="display:inline-block;margin:2px 6px 2px 0;font-size:12px;opacity:.75">${FundaScore.METRIC_LABELS[k]}</span>`
      ).join("");
  }

  function vulBreekpunten() {
    document.getElementById("minSlaapkamers").value = filters.minSlaapkamers;
    document.getElementById("minWoonopp").value = filters.minWoonopp;
    document.getElementById("maxPrijs").value = filters.maxPrijs;
    document.getElementById("tuinVerplicht").checked = filters.tuinVerplicht;
    document.getElementById("bergingVerplicht").checked = filters.bergingVerplicht;
  }

  function csv() {
    const kolommen = [
      "adres",
      "url",
      "status",
      "opgeslagenOp",
      "prijs",
      "prijsPerM2",
      "buurtPrijsPerM2",
      "woonopp",
      "perceel",
      "inhoud",
      "kamersRaw",
      "slaapkamers",
      "bouwjaar",
      "energielabel",
      "woningtype",
      "isolatieRaw",
      "ketelJaar",
      "bergingRaw",
      "eigendom",
      "tuinM2",
      "liggingRaw"
    ];
    const rijen = sorteer(berekend(), document.getElementById("sort").value);
    const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const lines = [kolommen.concat(["score", "waarde-index", "breekpunten"]).join(";")];
    rijen.forEach((r) => {
      const score = esc(r.score === null ? "" : r.score.toFixed(2));
      const waarde = esc(r.waarde === null ? "" : r.waarde.toFixed(2));
      const vlaggen = esc(r.vlaggen.join(" / "));
      const cells = [...kolommen.map((k) => esc(r.huis[k])), score, waarde, vlaggen];
      lines.push(cells.join(";"));
    });
    const blob = new Blob(["\ufeff" + lines.join("\n")], {
      type: "text/csv;charset=utf-8"
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "funda-ranglijst.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function zoekAdres() {
    const q = document.getElementById("adres-q").value.trim();
    const uit = document.getElementById("adres-uit");
    if (!q) return;

    uit.innerHTML = '<p class="leeg">Bezig…</p>';
    const data = await FundaScore.fetchAdres(q);

    if (!data?.ok) {
      uit.innerHTML = `<p class="leeg">${(data && (data.error || data.adres)) || "geen resultaat"
        }</p>`;
      return;
    }

    const rij = (c) =>
      `<tr class="${(c.bron || "").toLowerCase() === "funda" ? "hist-funda" : ""}">
         <td>${c.datum || "—"}</td><td>${euro(c.prijs)}</td><td>${c.bron || "—"}</td>
       </tr>`;

    uit.innerHTML = `<p class="hist-kop">${data.adres} · ${data.prijsHistorie.length} events ·
        ${data.fundaEvents.length} van Funda</p>
      <table class="hist"><tbody>${data.prijsHistorie.map(rij).join("")}</tbody></table>`;
  }

  async function init() {
    const [bewaardHouses, bewaardWeights, bewaardFilters] = await Promise.all([
      FundaCommon.Store.houses(),
      FundaCommon.Store.weights(),
      FundaCommon.Store.filters()
    ]);
    houses = bewaardHouses;
    weights = { ...FundaScore.DEFAULT_WEIGHTS, ...bewaardWeights };
    filters = { ...FundaScore.DEFAULT_FILTERS, ...bewaardFilters };
    scoreCache = null;

    tekenWegingen();
    vulBreekpunten();
    tekenLijst();

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
        document.querySelectorAll(".panel").forEach((p) => p.classList.remove("is-active"));
        tab.classList.add("is-active");
        document.getElementById(tab.dataset.tab).classList.add("is-active");
      });
    });

    document.getElementById("adres-zoek").addEventListener("click", zoekAdres);
    document.getElementById("adres-q").addEventListener("keydown", (e) => {
      if (e.key === "Enter") zoekAdres();
    });

    document.getElementById("sort").addEventListener("change", tekenLijst);
    document.getElementById("export").addEventListener("click", csv);

    document.getElementById("reset-wegingen").addEventListener("click", async () => {
      weights = { ...FundaScore.DEFAULT_WEIGHTS };
      scoreCache = null;
      await FundaCommon.schrijf({ weights });
      tekenWegingen();
      tekenLijst();
    });

    const bind = (id, key, type) => {
      document.getElementById(id).addEventListener("change", async (e) => {
        if (type === "check") filters[key] = e.target.checked;
        else {
          const v = Number.parseInt(e.target.value, 10);
          filters[key] = Number.isNaN(v) ? 0 : Math.max(0, v);
        }
        scoreCache = null;
        await FundaCommon.schrijf({ filters });
        tekenLijst();
      });
    };

    bind("minSlaapkamers", "minSlaapkamers");
    bind("minWoonopp", "minWoonopp");
    bind("maxPrijs", "maxPrijs");
    bind("tuinVerplicht", "tuinVerplicht", "check");
    bind("bergingVerplicht", "bergingVerplicht", "check");
  }

  init();
})();
