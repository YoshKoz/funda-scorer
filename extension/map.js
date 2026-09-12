/* Funda Scorer - kaartlaag, isolated world.
   Krijgt de marker-cellen van map-main.js, haalt de woningen van de brug en
   stuurt per cel een kleur terug. Brug uit = geen ringen. */

(() => {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const MSG_CELLS = "fundascorer:cells";
  const MSG_COLORS = "fundascorer:colors";
  const MSG_LOAD = "fundascorer:load";
  const MSG_STATUS = "fundascorer:status";
  const BATCH = 100;

  let area = null;
  let listings = null;
  let bezig = false;
  // na een extensie-reload draait deze pagina op een dode context: alle
  // chrome.*-aanroepen gooien dan "Extension context invalidated".
  let dood = false;

  function areaSlug() {
    const raw = new URLSearchParams(location.search).get("selected_area") || "";
    const first = raw.replace(/[[\]"]/g, "").split(",")[0].trim().toLowerCase();
    return /^[a-z0-9-]{2,60}$/.test(first) ? first : null;
  }

  // Funda zet bereikfilters als "min-max" in de url, met lege kant als open eind
  const BEREIK_FILTERS = {
    price: ["min_price", "max_price"],
    floor_area: ["min_area", "max_area"],
    plot_area: ["min_plot", "max_plot"],
    rooms: ["min_rooms", "max_rooms"],
    bedrooms: ["min_bedrooms", "max_bedrooms"]
  };

  function filterQuery() {
    const params = new URLSearchParams(location.search);
    const uit = new URLSearchParams();

    for (const [naam, [minSleutel, maxSleutel]] of Object.entries(BEREIK_FILTERS)) {
      const waarde = params.get(naam);
      if (!waarde) continue;
      const [min, max] = waarde.split("-");
      if (min && Number(min) > 0) uit.set(minSleutel, min);
      if (max) uit.set(maxSleutel, max);
    }

    const label = params.get("energy_label");
    if (label) uit.set("energy_label", label);

    return uit.toString();
  }

  async function loadArea(slug) {
    let data;
    const extra = filterQuery();
    try {
      const res = await fetch(
        `${FundaScore.BRIDGE_URL}/area?area=${encodeURIComponent(slug)}${extra ? "&" + extra : ""}`
      );
      if (!res.ok) return null;
      data = await res.json();
    } catch (e) {
      return null;
    }
    if (!data || !data.ok) return null;

    const map = {};
    for (const item of data.listings) {
      // beperkt: de zoek-API kent geen tuin/berging, die metrieken moeten
      // ontbreken in plaats van als 0 te tellen.
      map[item.id] = Object.assign({ beperkt: true }, item);
    }
    return map;
  }

  async function handle(cells) {
    if (bezig || dood) return;
    bezig = true;
    try {
      const slug = areaSlug();
      if (!slug) return;
      const sleutel = `${slug}|${filterQuery()}`;
      if (sleutel !== area || !listings) {
        const loaded = await loadArea(slug);
        if (!loaded) return;
        listings = loaded;
        area = sleutel;
      }

      const weights = await gewichten();
      if (!weights) return;
      stuurKleuren(cells, weights);
    } finally {
      bezig = false;
    }
  }

  async function gewichten() {
    if (!api.runtime || !api.runtime.id) {
      dood = true;
      return null;
    }
    try {
      const store = await api.storage.local.get("weights");
      return store.weights || FundaScore.DEFAULT_WEIGHTS;
    } catch (e) {
      dood = true;
      return null;
    }
  }

  // score 2 of lager = rood, 8 of hoger = groen; daartussen lineair
  const tint = (score) => Math.min(1, Math.max(0, (score - 2) / 6));

  function stuurKleuren(cells, weights) {
    FundaScore.setReferentie(Object.values(listings || {}));

    const colors = {};
    for (const cell of cells) {
      const scores = [];
      for (const id of cell.ids) {
        const huis = listings && listings[id];
        if (!huis) continue;
        const res = FundaScore.totalScore(huis, weights);
        if (res.score !== null) scores.push(res.score);
      }
      if (!scores.length) continue;
      const score = scores.reduce((a, b) => a + b, 0) / scores.length;
      colors[cell.key] = {
        score: Math.round(score * 10) / 10,
        color: `hsl(${Math.round(tint(score) * 120)}, 75%, 45%)`
      };
    }
    window.postMessage({ source: MSG_COLORS, colors }, location.origin);
  }

  function status(tekst, bezigNu) {
    window.postMessage({ source: MSG_STATUS, tekst, bezig: bezigNu }, location.origin);
  }

  // Knop: haalt de woningen op die nu op de kaart staan, per id. Werkt dus ook
  // als er geen gebied is gekozen (heel Nederland).
  async function laadZichtbaar(cells) {
    if (bezig || dood) return;
    bezig = true;
    try {
      const weights = await gewichten();
      if (!weights) return;
      if (!listings) listings = {};

      const ids = [];
      for (const cell of cells) {
        for (const id of cell.ids) {
          if (!listings[id] && !ids.includes(id)) ids.push(id);
        }
      }
      if (!ids.length) {
        status("Laad huizen", false);
        stuurKleuren(cells, weights);
        return;
      }

      for (let i = 0; i < ids.length; i += BATCH) {
        const deel = ids.slice(i, i + BATCH);
        status(`Laden ${Math.min(i + deel.length, ids.length)}/${ids.length}`, true);
        let data;
        try {
          const res = await fetch(
            `${FundaScore.BRIDGE_URL}/listings?ids=${deel.join(",")}`
          );
          data = res.ok ? await res.json() : null;
        } catch (e) {
          data = null;
        }
        if (!data || !data.ok) {
          status("Brug onbereikbaar", false);
          return;
        }
        for (const item of data.listings) {
          listings[item.id] = Object.assign({ beperkt: true }, item);
        }
        stuurKleuren(cells, weights);
      }

      status("Laad huizen", false);
    } finally {
      bezig = false;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || !Array.isArray(data.cells)) return;
    if (data.source === MSG_LOAD) {
      laadZichtbaar(data.cells).catch(() => {
        bezig = false;
        status("Laden mislukt", false);
      });
      return;
    }
    if (data.source !== MSG_CELLS) return;
    handle(data.cells).catch(() => {
      dood = true;
    });
  });
})();
