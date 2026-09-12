/* Funda Scorer - popup */

(() => {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  let houses = {};
  let weights = Object.assign({}, FundaScore.DEFAULT_WEIGHTS);
  let filters = Object.assign({}, FundaScore.DEFAULT_FILTERS);

  const euro = (n) => (n === null || n === undefined ? "—" : "€ " + n.toLocaleString("nl-NL"));

  function scoreClass(s) {
    if (s === null) return "";
    if (s >= 7) return "goed";
    if (s >= 5) return "matig";
    return "slecht";
  }

  function berekend() {
    return Object.values(houses).map((h) => {
      const res = FundaScore.totalScore(h, weights);
      return {
        huis: h,
        score: res.score,
        waarde: res.waarde,
        vlaggen: FundaScore.breekpunten(h, filters)
      };
    });
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
          <div class="kaart-score ${scoreClass(r.score)}">${
          r.score === null ? "—" : r.score.toFixed(1)
        }</div>
          <div class="kaart-cijfers">
            ${euro(h.prijs)} · ${h.woonopp ?? "—"} m² · ${euro(h.prijsPerM2)}/m² ·
            label ${h.energielabel || "—"} · ${h.slaapkamers ?? "—"} slk ·
            waarde ${r.waarde === null ? "—" : r.waarde.toFixed(2)}
          </div>
          <div class="kaart-acties"><button type="button" data-url="${h.url}">Verwijder</button></div>
          ${r.vlaggen.length ? `<div class="kaart-vlag">Valt af op: ${r.vlaggen.join(", ")}</div>` : ""}
        </article>`;
      })
      .join("");

    doel.querySelectorAll(".kaart-acties button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        delete houses[btn.dataset.url];
        await api.storage.local.set({ houses });
        tekenLijst();
      });
    });
  }

  function tekenWegingen() {
    const doel = document.getElementById("weegvelden");
    doel.innerHTML = Object.keys(FundaScore.DEFAULT_WEIGHTS)
      .map(
        (k) => `<label class="weeg">${FundaScore.METRIC_LABELS[k]}
                  <input type="number" min="0" max="100" step="1" data-weeg="${k}" value="${weights[k]}" />
                </label>`
      )
      .join("");

    doel.querySelectorAll("input[data-weeg]").forEach((inp) => {
      inp.addEventListener("change", async () => {
        const v = parseInt(inp.value, 10);
        weights[inp.dataset.weeg] = Number.isNaN(v) ? 0 : Math.max(0, v);
        await api.storage.local.set({ weights });
        tekenLijst();
      });
    });
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
      "prijs",
      "woonopp",
      "prijsPerM2",
      "buurtPrijsPerM2",
      "perceel",
      "slaapkamers",
      "bouwjaar",
      "energielabel",
      "tuinM2",
      "liggingRaw",
      "ketelJaar"
    ];
    const rijen = sorteer(berekend(), document.getElementById("sort").value);
    const esc = (v) => `"${String(v === null || v === undefined ? "" : v).replace(/"/g, '""')}"`;
    const lines = [kolommen.concat(["score", "waarde-index", "breekpunten"]).join(";")];
    rijen.forEach((r) => {
      const cells = kolommen.map((k) => esc(r.huis[k]));
      cells.push(esc(r.score === null ? "" : r.score.toFixed(2)));
      cells.push(esc(r.waarde === null ? "" : r.waarde.toFixed(2)));
      cells.push(esc(r.vlaggen.join(" / ")));
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

    if (!data || !data.ok) {
      uit.innerHTML = `<p class="leeg">${
        (data && (data.error || data.adres)) || "geen resultaat"
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
    const store = await api.storage.local.get(["houses", "weights", "filters"]);
    houses = store.houses || {};
    weights = Object.assign({}, FundaScore.DEFAULT_WEIGHTS, store.weights || {});
    filters = Object.assign({}, FundaScore.DEFAULT_FILTERS, store.filters || {});

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
      weights = Object.assign({}, FundaScore.DEFAULT_WEIGHTS);
      await api.storage.local.set({ weights });
      tekenWegingen();
      tekenLijst();
    });

    const bind = (id, key, type) => {
      document.getElementById(id).addEventListener("change", async (e) => {
        if (type === "check") filters[key] = e.target.checked;
        else {
          const v = parseInt(e.target.value, 10);
          filters[key] = Number.isNaN(v) ? 0 : Math.max(0, v);
        }
        await api.storage.local.set({ filters });
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
