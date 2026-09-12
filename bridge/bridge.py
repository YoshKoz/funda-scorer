"""Local HTTP bridge: pyfunda data for the Funda Scorer Chrome extension."""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

from funda import Funda
from funda.listing import Address, Listing, Urls

VERSION = "1.3.1"
HOST = "127.0.0.1"
# Poort instelbaar: op de laptop bezet de claudecodebrowser-MCP al 8765.
PORT = int(os.environ.get("FUNDA_BRIDGE_PORT", "8765"))
ORIGIN = "https://www.funda.nl"

_client = Funda()
_lock = threading.Lock()
_cache: dict[str, dict] = {}


PDOK = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free"
# Walter kent de woning op adres+postcode; de url moet alleen cijfers bevatten,
# de inhoud ervan wordt niet gecontroleerd. Zo werken ook verdwenen listings.
SYNTH_URL = "https://www.funda.nl/detail/koop/{city}/huis-{slug}/99999999/"


def _slug(text: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in text.lower()).strip("-")


def _geocode(query: str) -> dict | None:
    params = urlencode(
        {
            "q": query,
            "rows": 1,
            "fq": "type:adres",
            "fl": "weergavenaam,postcode,straatnaam,huis_nlt,woonplaatsnaam",
        }
    )
    with urllib.request.urlopen(f"{PDOK}?{params}", timeout=15) as response:
        docs = json.load(response).get("response", {}).get("docs", [])
    return docs[0] if docs else None


def _title_variants(street: str, number: str) -> list[str]:
    # PDOK schrijft "132A", Funda/Walter "132-A"; alleen de exacte spelling geeft een hit.
    forms = [number]
    match = re.fullmatch(r"(\d+)[\s-]?([A-Za-z]+)", number)
    if match:
        digits, suffix = match.groups()
        forms += [f"{digits}-{suffix}", f"{digits} {suffix}", f"{digits}{suffix}"]
    seen = []
    for form in forms:
        title = f"{street} {form}"
        if title not in seen:
            seen.append(title)
    return seen


def _address_history(query: str) -> dict:
    doc = _geocode(query)
    if not doc:
        return {"ok": False, "error": f"geen adres gevonden voor {query!r}"}

    city = doc["woonplaatsnaam"]
    postcode = (doc.get("postcode") or "").replace(" ", "")

    history = None
    title = None
    last_error = None
    for candidate in _title_variants(doc["straatnaam"], str(doc["huis_nlt"])):
        listing = Listing(
            address=Address(title=candidate, postcode=postcode, city=city),
            urls=Urls(full=SYNTH_URL.format(city=_slug(city), slug=_slug(candidate))),
        )
        try:
            with _lock:
                history = _client.price_history(listing)
            title = candidate
            break
        except Exception as exc:
            last_error = exc

    if history is None:
        return {
            "ok": False,
            "adres": doc.get("weergavenaam"),
            "error": f"geen Walter-historie: {last_error}",
        }

    changes = [
        {"datum": c.date, "prijs": c.price, "status": c.status, "bron": c.source}
        for c in history.changes
    ]
    return {
        "ok": True,
        "adres": doc.get("weergavenaam") or title,
        "fundaTitel": title,
        "postcode": postcode,
        "stad": city,
        "prijsHistorie": changes,
        "fundaEvents": [c for c in changes if (c["bron"] or "").lower() == "funda"],
        "wozEvents": [c for c in changes if (c["bron"] or "").lower() == "woz"],
    }


def _per_m2(price, area):
    if not price or not area:
        return None
    return round(price / area)


def _enrich(url: str) -> dict:
    with _lock:
        listing = _client.listing(url)

    d = listing.property_details
    out = {
        "ok": True,
        "id": listing.id,
        "url": listing.url,
        "adres": listing.title,
        "buurt": listing.address.neighbourhood,
        "stad": listing.city,
        "status": d.status,
        "prijs": listing.price.amount,
        "prijsPerM2": _per_m2(listing.price.amount, listing.living_area),
        "woonopp": listing.living_area,
        "perceel": listing.plot_area,
        "inhoud": listing.areas.volume,
        "buitenruimte": listing.areas.building_bound_outdoor,
        "berging": listing.areas.external_storage,
        "slaapkamers": listing.bedrooms,
        "kamers": listing.rooms_count,
        "bouwjaar": d.construction_year,
        "energielabel": d.energy_label,
        "woningtype": d.house_type or d.object_type,
        "publicatiedatum": listing.publication_date,
        "kenmerken": {
            sec.title: {
                item.label: item.value
                for root in sec.items
                for item in root.walk()
                if item.label and item.value is not None
            }
            for sec in listing.characteristics
            if sec.title
        },
    }

    if listing.insights:
        out["bekeken"] = listing.insights.views
        out["bewaard"] = listing.insights.saves

    try:
        with _lock:
            market = _client.market_insights(listing)
        out["buurtPrijsPerM2"] = market.get("avg_asking_price_per_m2")
        out["buurtInwoners"] = market.get("inhabitants")
    except Exception as exc:
        out["buurtFout"] = str(exc)

    try:
        with _lock:
            history = _client.price_history(listing)
        out["prijsHistorie"] = [
            {"datum": c.date, "prijs": c.price, "status": c.status, "bron": c.source}
            for c in history.changes
        ]
    except Exception as exc:
        out["prijsHistorieFout"] = str(exc)

    return out


def _buurt_prijzen(listings: list) -> dict:
    pairs = sorted(
        {
            (listing.city, listing.address.neighbourhood)
            for listing in listings
            if listing.city and listing.address.neighbourhood
        }
    )

    def insight(client, pair):
        try:
            return client.market_insights(*pair).get("avg_asking_price_per_m2")
        except Exception:
            return None

    with _lock:
        waarden = _client._parallel(insight, pairs, workers=8)
    return {pair: waarde for pair, waarde in zip(pairs, waarden) if waarde}


AREA_FILTERS = {
    "min_price": int,
    "max_price": int,
    "min_area": int,
    "max_area": int,
    "min_plot": int,
    "max_plot": int,
    "min_rooms": int,
    "max_rooms": int,
    "min_bedrooms": int,
    "max_bedrooms": int,
    "energy_label": str,
}


def _area_filters(query: dict) -> dict:
    filters = {}
    for naam, cast in AREA_FILTERS.items():
        waarde = (query.get(naam) or [""])[0].strip()
        if not waarde:
            continue
        if cast is int:
            filters[naam] = int(waarde)
        else:
            filters[naam] = [deel for deel in waarde.split(",") if deel]
    return filters


def _area_listings(area: str, max_pages: int, filters: dict) -> dict:
    with _lock:
        listings = list(
            _client.iter_search(area, max_pages=max_pages, workers=8, category="buy", **filters)
        )

    buurten = _buurt_prijzen(listings)

    out = [_kort(listing, buurten) for listing in listings if listing.global_id is not None]
    return {
        "ok": True,
        "area": area,
        "filters": filters,
        "count": len(out),
        "listings": out,
    }


def _kort(listing, buurten: dict) -> dict:
    return {
        "id": listing.global_id,
        "url": listing.url,
        "adres": listing.title,
        "buurt": listing.address.neighbourhood,
        "buurtPrijsPerM2": buurten.get((listing.city, listing.address.neighbourhood)),
        "status": listing.property_details.status,
        "prijs": listing.price.amount,
        "prijsPerM2": _per_m2(listing.price.amount, listing.living_area),
        "woonopp": listing.living_area,
        "perceel": listing.plot_area,
        "slaapkamers": listing.bedrooms,
        "energielabel": listing.energy_label,
    }


MAX_IDS = 500


def _listings_by_id(ids: list[int]) -> dict:
    vers = [nummer for nummer in ids if f"id:{nummer}" not in _cache]
    if vers:
        with _lock:
            opgehaald = _client.listings(vers, workers=8)
        buurten = _buurt_prijzen(opgehaald)
        for listing in opgehaald:
            if listing.global_id is not None:
                _cache[f"id:{listing.global_id}"] = _kort(listing, buurten)

    out = [_cache[f"id:{nummer}"] for nummer in ids if f"id:{nummer}" in _cache]
    return {"ok": True, "count": len(out), "listings": out}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, body: dict) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def _origin(self) -> str:
        # popup.html draait op chrome-extension://<id>, content.js op funda.nl
        origin = self.headers.get("Origin") or ""
        return origin if origin.startswith("chrome-extension://") else ORIGIN

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", self._origin())
        # Chrome's Local Network Access: een pagina op een publiek adres
        # (funda.nl) mag 127.0.0.1 alleen benaderen als de server dat expliciet
        # toestaat. Zonder deze header blokkeert Chrome de fetch met
        # "Permission was denied for this request to access the loopback
        # address space".
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send(200, {"ok": True, "port": PORT, "version": VERSION})
            return
        if parsed.path == "/adres":
            query = (parse_qs(parsed.query).get("q") or [""])[0].strip()
            if not query:
                self._send(400, {"ok": False, "error": "q ontbreekt"})
                return
            if query in _cache:
                self._send(200, _cache[query])
                return
            try:
                data = _address_history(query)
            except Exception as exc:
                self._send(502, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
                return
            if data.get("ok"):
                _cache[query] = data
            self._send(200 if data.get("ok") else 404, data)
            return

        if parsed.path == "/listings":
            ruw = (parse_qs(parsed.query).get("ids") or [""])[0]
            try:
                ids = [int(deel) for deel in ruw.split(",") if deel.strip()]
            except ValueError:
                self._send(400, {"ok": False, "error": "ids moeten getallen zijn"})
                return
            if not ids:
                self._send(400, {"ok": False, "error": "ids ontbreekt"})
                return
            if len(ids) > MAX_IDS:
                self._send(400, {"ok": False, "error": f"maximaal {MAX_IDS} ids per aanroep"})
                return
            try:
                data = _listings_by_id(ids)
            except Exception as exc:
                self._send(502, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
                return
            self._send(200, data)
            return

        if parsed.path == "/area":
            query = parse_qs(parsed.query)
            area = (query.get("area") or [""])[0].strip().lower()
            if not re.fullmatch(r"[a-z0-9-]{2,60}", area):
                self._send(400, {"ok": False, "error": "area ontbreekt of ongeldig"})
                return
            max_pages = int((query.get("max_pages") or ["60"])[0])
            try:
                filters = _area_filters(query)
            except ValueError as exc:
                self._send(400, {"ok": False, "error": f"ongeldig filter: {exc}"})
                return
            key = f"area:{area}:{max_pages}:{sorted(filters.items())}"
            if key in _cache:
                self._send(200, _cache[key])
                return
            try:
                data = _area_listings(area, max_pages, filters)
            except Exception as exc:
                self._send(502, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
                return
            _cache[key] = data
            self._send(200, data)
            return

        if parsed.path != "/listing":
            self._send(404, {"ok": False, "error": "unknown endpoint"})
            return

        url = (parse_qs(parsed.query).get("url") or [""])[0]
        if not url.startswith("https://www.funda.nl/"):
            self._send(400, {"ok": False, "error": "url must be a funda.nl detail url"})
            return

        if url in _cache:
            self._send(200, _cache[url])
            return

        try:
            data = _enrich(url)
        except Exception as exc:
            self._send(502, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            return

        _cache[url] = data
        self._send(200, data)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"funda-bridge on http://{HOST}:{PORT}  (/listing?url=..., /area?area=..., /health)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        _client.close()


if __name__ == "__main__":
    main()
