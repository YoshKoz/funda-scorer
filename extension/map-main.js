/* Funda Scorer - kaartlaag, draait in de MAIN world.
   Leest de marker-aggregaties uit de Pinia-store van Funda, stuurt ze naar de
   content script (isolated world) en tekent de gekleurde ringen terug over de
   deck.gl-canvas heen. */

(() => {
  "use strict";

  const MSG_CELLS = "fundascorer:cells";
  const MSG_COLORS = "fundascorer:colors";
  const MSG_LOAD = "fundascorer:load";
  const MSG_STATUS = "fundascorer:status";

  let map = null;
  let canvas = null;
  let knop = null;
  let cells = [];
  let colors = {};
  let signature = "";

  // Funda haalt de Map-klasse via importLibrary op, dus de constructor zelf
  // vervangen helpt niet: de prototypes zijn wel gedeeld. Elke instantie die
  // langs een van deze methoden komt, is de kaart die we zoeken.
  const MAP_METHODS = [
    "setCenter",
    "setZoom",
    "panTo",
    "panBy",
    "fitBounds",
    "setOptions",
    "getBounds",
    "getCenter",
    "getZoom",
    "getDiv"
  ];

  // De loader vervangt google.maps na het laden van de echte API, dus de vlag
  // hoort op het prototype dat we net gepatcht hebben, niet op de namespace.
  function patchPrototype(proto, patch) {
    if (!proto || proto.__fundascorer) return;
    proto.__fundascorer = true;
    patch(proto);
  }

  function patchMaps(maps) {
    if (!maps || !maps.Map) return false;

    patchPrototype(maps.Map.prototype, (proto) => {
      for (const name of MAP_METHODS) {
        const original = proto[name];
        if (typeof original !== "function") continue;
        proto[name] = function (...args) {
          onMap(this);
          return original.apply(this, args);
        };
      }
    });

    for (const naam of ["OverlayView", "WebGLOverlayView"]) {
      const klasse = maps[naam];
      if (!klasse) continue;
      patchPrototype(klasse.prototype, (proto) => {
        const setMap = proto.setMap;
        proto.setMap = function (target) {
          if (target && typeof target.getDiv === "function") onMap(target);
          return setMap.call(this, target);
        };
      });
    }

    return Boolean(map);
  }

  function onMap(instance) {
    if (map) return;
    map = instance;
    // niet midden in een setMap-aanroep van Funda zelf de laag toevoegen
    setTimeout(() => attach(), 0);
  }

  function attach() {
    canvas = document.createElement("canvas");
    canvas.id = "fundascorer-rings";
    canvas.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;z-index:2000";
    map.getDiv().appendChild(canvas);

    knop = document.createElement("button");
    knop.id = "fundascorer-load";
    knop.type = "button";
    knop.textContent = "Laad huizen";
    knop.style.cssText =
      "position:absolute;left:12px;top:12px;z-index:2001;padding:8px 12px;border:0;" +
      "border-radius:4px;background:#0071b3;color:#fff;font:600 13px system-ui,sans-serif;" +
      "cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35)";
    knop.addEventListener("click", () => {
      window.postMessage({ source: MSG_LOAD, cells: zichtbareCellen() }, location.origin);
    });
    map.getDiv().appendChild(knop);

    window.google.maps.event.addListener(map, "bounds_changed", render);
    window.google.maps.event.addListener(map, "idle", render);
    render();
  }

  // alleen de cellen die nu in beeld staan: de brug haalt per woning detail op
  function zichtbareCellen() {
    const bounds = map.getBounds();
    if (!bounds) return cells;
    return cells.filter((cell) =>
      bounds.contains(new window.google.maps.LatLng(cell.lat, cell.lon))
    );
  }

  function render() {
    if (!canvas || !map) return;
    // OverlayView levert hier geen onAdd op (Funda's kaart tekent via deck.gl),
    // dus zelf projecteren: wereldpunt -> pixels rond het midden.
    const projection = map.getProjection();
    const center = map.getCenter();
    const zoom = map.getZoom();
    if (!projection || !center || zoom === undefined) return;
    const scale = Math.pow(2, zoom);
    const centerPoint = projection.fromLatLngToPoint(center);

    const div = map.getDiv();
    const width = div.clientWidth;
    const height = div.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 2;

    for (const cell of cells) {
      const paint = colors[cell.key];
      if (!paint) continue;
      const world = projection.fromLatLngToPoint(
        new window.google.maps.LatLng(cell.lat, cell.lon)
      );
      if (!world) continue;
      const x = (world.x - centerPoint.x) * scale + width / 2;
      const y = (world.y - centerPoint.y) * scale + height / 2;
      if (x < -40 || y < -40 || x > width + 40 || y > height + 40) continue;
      ctx.beginPath();
      ctx.arc(x, y, cell.count > 1 ? 12 : 8, 0, Math.PI * 2);
      ctx.strokeStyle = paint.color;
      ctx.stroke();
    }
  }

  function readCells() {
    let state;
    try {
      state = window.useNuxtApp().$pinia.state.value.search;
    } catch (e) {
      return null;
    }
    const aggs = state && state.mapAggregations;
    if (!Array.isArray(aggs) || !aggs.length) return null;

    return aggs
      .map((agg) => {
        const location = agg.centroid && agg.centroid.location;
        const hits = (agg.global_ids && agg.global_ids.hits && agg.global_ids.hits.hits) || [];
        return {
          key: String(agg.key),
          lat: location ? location.lat : null,
          lon: location ? location.lon : null,
          count: agg.doc_count,
          ids: hits.map((hit) => Number(hit._id)).filter(Boolean)
        };
      })
      .filter((cell) => cell.lat !== null && cell.lon !== null);
  }

  function poll() {
    const fresh = readCells();
    if (!fresh) return;
    const next = `${fresh.length}|${fresh[0].key}|${fresh[fresh.length - 1].key}`;
    if (next === signature) return;
    signature = next;
    cells = fresh;
    render();
    window.postMessage({ source: MSG_CELLS, cells }, location.origin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;
    if (data.source === MSG_STATUS) {
      if (knop) {
        knop.textContent = data.tekst;
        knop.disabled = Boolean(data.bezig);
      }
      return;
    }
    if (data.source !== MSG_COLORS) return;
    colors = Object.assign({}, colors, data.colors || {});
    render();
  });

  // blijven pollen tot we een kaart hebben: de loader hangt de echte klassen
  // pas later in google.maps, en vervangt de stub die er eerst stond.
  const patchTimer = setInterval(() => {
    if (patchMaps(window.google && window.google.maps)) clearInterval(patchTimer);
  }, 50);
  patchMaps(window.google && window.google.maps);
  setInterval(poll, 1000);
})();
