# funda-scorer (lokale dev-kopie)

Chrome-extensie die een Funda-koopwoning leest, de kenmerken scoort op
instelbare wegingen en in een ranglijst zet. Een lokale Python-brug verrijkt de
pagina-tekst met Funda's eigen API via [pyfunda](https://github.com/0xMH/pyfunda).

Deze map staat op de laptop op `~/code/funda-scorer` en is een kopie van de
extensie die op de desktop-PC in
`C:\Program Files (x86)\Chromextensions\funda-scorer-chrome` staat. Daar is het
geen git-repo; hier staat alles bij elkaar zodat er op de laptop getest kan
worden.

Let op: dit is geen `git clone`. Er is geen upstream-repo — `YoshKoz/funda-scorer`
bestaat niet op GitHub (`git ls-remote` geeft "Repository not found", de API geeft
404). De bestanden komen van de desktop. De enige echte git-repo in deze map is
`pyfunda/`, met origin `0xMH/pyfunda`.

## Wat zit waar

| Pad                | Wat                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `extension/`       | De Chrome-extensie (MV3). `scoring.js` doet het parsen/scoren, `content.js` zet het paneel op de pagina. |
| `bridge/bridge.py` | Lokale HTTP-server die pyfunda-data als JSON levert.                                                     |
| `bridge/.venv/`    | Virtualenv voor de brug (niet in git).                                                                   |
| `pyfunda/`         | Kloon van de Funda-API-client (AGPL-3.0), als editable dependency geïnstalleerd.                         |
| `run-bridge.sh`    | Start de brug op een vrije poort.                                                                        |
| `tests/`           | Rooktest voor de brug en een browser-test voor de extensie.                                              |

## Eenmalig opzetten

```bash
git clone https://github.com/0xMH/pyfunda   # staat niet in deze repo, zie onder
python3 -m venv bridge/.venv
bridge/.venv/bin/pip install -e ./pyfunda
```

`pyfunda` vereist Python >= 3.14.

## Versiebeheer

Deze map is een git-repo op branch `main`. `pyfunda/` staat in `.gitignore`:
dat is een losse third-party clone (AGPL-3.0) met een eigen `.git` en lokale
wijzigingen, dus die wordt niet meegecommit. Een verse checkout haalt hem apart
op (zie hierboven).

Er is nog geen remote. Om te pushen:

```bash
git remote add origin git@github.com:YoshKoz/funda-scorer.git
git push -u origin main
```

Let op: `~` (`/home/yoshkoz`) is zelf ook een git-repo, dus deze map is daarbinnen
een geneste repo. Doe geen `git add .` vanuit je home.

## Draaien

```bash
./run-bridge.sh          # print bijv. http://127.0.0.1:8767
```

De brug kiest de eerste vrije poort uit `8765, 8767-8770`. Poort **8765 is op
deze laptop bezet** door de claudecodebrowser-MCP (`~/.claudecodebrowser`), dus
in de praktijk wordt het 8767. De extensie zoekt zelf een werkende poort via
`/health`, dus je hoeft niets in te stellen. Zet `FUNDA_BRIDGE_PORT` om een
poort te forceren.

De extensie laden:

1. `chrome://extensions`
2. Development mode aan
3. **Load unpacked** -> kies `extension/`

`google-chrome-stable` (152) negeert `--load-extension` op de command line, ook
met `--enable-unsafe-extension-debugging` of
`--disable-features=DisableLoadExtensionCommandLineSwitch`. Handmatig laden via
`chrome://extensions` is de enige route voor je dagelijkse Chrome. Voor
geautomatiseerd testen wordt de Chromium van Playwright gebruikt, die de flag
wél respecteert.

## Endpoints

| Endpoint                          | Doet                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/health`                         | `{"ok": true, "port": ..., "version": ...}` — hierop detecteert de extensie de poort.             |
| `/listing?url=<funda-detail-url>` | Alle kenmerken, prijs/m², buurtgemiddelde, prijshistorie, views/saves.                            |
| `/adres?q=<adres postcode>`       | Prijshistorie via Walter op adres+postcode; werkt ook voor listings die van Funda verdwenen zijn. |
| `/listings?ids=1,2,3`             | Compacte records voor een lijst global-id's (max 500).                                            |
| `/area?area=<stad>&...`           | Zoekresultaten van een stad. **Werkt momenteel niet**, zie hieronder.                             |

## Testen

Alles behalve `extension-live.cjs` draait headless: er gaat geen browservenster
open en er is geen verbinding met funda.nl nodig.

```bash
node tests/scoring.test.cjs            # pure scorelogica, geen browser of netwerk
./tests/smoke.sh 8767                  # brug tegen een echte woning
node tests/parse-fixtures.cjs          # parser op bewaarde Funda-pagina's
node tests/extension-offline.cjs       # extensie + paneel + brug, headless
node tests/extension-offline.cjs huis.html
REQUIRE_BRIDGE=1 node tests/extension-offline.cjs
SCREENSHOT=/tmp/paneel.png node tests/extension-offline.cjs
```

`extension-offline.cjs` onderschept de navigatie naar `www.funda.nl` en bedient
die uit `tests/fixtures`, zodat de content script wél matcht maar er niets over
het netwerk gaat. Alleen de brug op `127.0.0.1` wordt echt aangeroepen. Die
browser krijgt `--disable-features=LocalNetworkAccessChecks`: Chrome ziet een
geserveerde pagina als "publiek" en weigert anders de fetch naar loopback. Op
een echte funda.nl-pagina speelt dat niet.

`capture-fixtures.cjs` haalt eenmalig echte detailpagina's op naar
`tests/fixtures/` (staat in `.gitignore`, het is third-party HTML):

```bash
node tests/capture-fixtures.cjs
```

`extension-live.cjs` test tegen de echte site en opent wél een venster: headless
krijgt Funda's botbeveiliging te zien. Gebruik hem als canary:

```bash
REQUIRE_BRIDGE=1 node tests/extension-live.cjs
```

Voor de browsertests is Playwright nodig. Zonder installatie kun je de kopie uit
de npx-cache gebruiken:

```bash
NODE_PATH="$HOME/.npm/_npx/9833c18b2d85bc59/node_modules" node tests/extension-offline.cjs
```

## Opbouw

- **`extension/common.js`** — de enige plek waar `chrome`/`browser`, de opslag en
  de opmaak geregeld worden. `Store` is de opslaglaag: naast `houses` beheert
  hij een lichte `houseIndex`, zodat de detailpagina niet de hele ranglijst
  hoeft te lezen om te weten of een huis al opgeslagen is.
- **`extension/scoring.js`** — puur: `metricScores(huis, ref)` en
  `totalScore(huis, weights, ref)` krijgen de referentie mee als argument. Er is
  geen verborgen staat meer, dus dezelfde invoer geeft altijd dezelfde score en
  de functies zijn los te testen (`tests/scoring.test.cjs`).
- **`SCORE_METRICS` vs `INFO_METRICS`** — alleen de vier metrieken die de
  zoek-API ook levert zijn weegbaar; daardoor is de score op de detailpagina
  hetzelfde getal als de ring op de kaart. De andere acht kenmerken worden wel
  getoond, maar tellen niet mee en zijn niet instelbaar.
- **Ontbrekend is onbekend** — een veld dat niet op de pagina staat levert
  `null` op en telt niet mee. `totalScore` geeft `dekking` terug: welk deel van
  het gewicht echt meetelde. Onder de 100% meldt het paneel dat.
- **Parser** — werkt op `body.innerText`. Een lege rij in de kenmerken-tabel
  liet de volgende kopregel als waarde doorgaan; `afterLabel` weigert nu
  kopregels. Labels worden genormaliseerd (non-breaking spaces, dubbele spaties).

## Bekende problemen

**Zoeken (`/area`) is stuk.** `listing-search-wonen.funda.io/_msearch/template`
antwoordt nu met HTTP 200 en een fout in de body:
`Search failed (status 401): no token provided`. Funda is daar blijkbaar een
token gaan eisen; pyfunda 3.1.4 stuurt er geen mee. Gevolg in de extensie: de
referentieset uit `aanbod()` blijft leeg, dus de percentiel-scores en de
metriek "Prijs t.o.v. aanbod" vallen terug op de absolute schaal en het paneel
meldt "Geen buurtgemiddelde". `/listing`, `/adres` en `/listings` werken wel.

**Buurtgemiddelde bij samengestelde buurtnamen.** `market_insights` faalt als de
buurtnaam een komma of punten bevat, bijvoorbeeld
`"Laan van Nieuw-Guinea, Spinozaweg e.o."`. pyfunda's slug laat die tekens
staan (`%2C`, `.`) en de API geeft dan niets terug. Voor gewone buurtnamen
werkt het wel. In dat geval toont het paneel het buurtgemiddelde van de pagina
zelf.

**Poort 8765 is bezet** door de claudecodebrowser-MCP. Daarom is de poort van de
brug instelbaar (`FUNDA_BRIDGE_PORT`) en zoekt de extensie hem zelf op. De
extensie controleert daarbij op `ok === true` in `/health`, want die andere
server antwoordt op dezelfde poort met een ander formaat.

**Chrome negeert `--load-extension`** (zie boven). Playwright's Chromium werkt
wel.

**Kaartlaag blijft fragiel.** De marker-aggregaties komen uit Funda's interne
Nuxt/Pinia-store. Een echte DOM-fallback is niet mogelijk: de markers staan op
een deck.gl-canvas zonder DOM-coördinaten. De code leest nu wel meerdere paden
en meldt op de knop "Kaartlaag: Funda-indeling onbekend" in plaats van stil
niets te doen.

**Energielabel uit de API heeft een andere notatie.** Funda's API schrijft `A3`
waar de pagina `A+++` zet. `energieLabel()` trekt die gelijk, en waarden die niet
te lezen zijn overschrijven de paginatekst niet meer.

**Chrome's Local Network Access.** Een pagina op een publiek adres mag
`127.0.0.1` alleen benaderen als de server dat toestaat. `bridge.py` stuurt
daarom `Access-Control-Allow-Private-Network: true` mee.

**Geen `icons` in het manifest.** Ontbreekt nog; Chrome toont een
standaardpictogram.

## Verschil met de desktop-versie

De desktop-versie is 1.3.0, deze kopie 1.4.0.

- `bridge/bridge.py`: poort komt uit `FUNDA_BRIDGE_PORT` in plaats van hardcoded
  8765; `Access-Control-Allow-Private-Network: true` in de CORS-headers (1.3.1).
- `extension/common.js`: nieuw — gedeelde api/opslag/opmaak.
- `extension/scoring.js`: referentie is een argument in plaats van verborgen
  staat; ontbrekende velden scoren `null` in plaats van 0; `dekking` in het
  resultaat; kopregel-beveiliging in de parser; één implementatie voor
  tuinoppervlak in plaats van twee; `woonopp` zonder referentie gebruikt een band
  per woningtype; energielabel uit de API (`A3`) wordt gelijkgetrokken met de
  paginanotatie (`A+++`); `typeHint` leidt het woningtype uit url en titel af
  omdat het label "Soort woonhuis" bij appartementen ontbreekt.
- `extension/content.js` + `popup.js`: gebruiken `common.js`; de popup toont
  alleen nog weegbare metrieken als invoerveld; opslaan gaat via `Store`.
- `extension/map.js`: gebruikt `resolveBridgeUrl()` in plaats van de hardcoded
  `BRIDGE_URL` (op deze machine staat de brug op 8767, dus de kaartlaag deed
  hiervoor niets); `Set` in plaats van `ids.includes()`; het referentieaanbod
  wordt één keer opgebouwd per set in plaats van bij elke kaartbeweging.
- `extension/map-main.js`: leest de Pinia-store via meerdere paden en meldt het
  als geen ervan werkt; volledige vingerafdruk van de cellen; pollen slaat over
  als het tabblad verborgen is; stopt met zoeken naar de kaart na een minuut.
- `extension/manifest.json`: `common.js` in de content scripts,
  `unlimitedStorage`, en `browser_specific_settings` voor Firefox.
  `world: "MAIN"` vereist Firefox ≥ 128.

De verouderde padverwijzing in de Claude-memory op de desktop
(`C:\Development\funda-bridge`) klopt nog steeds niet; het echte pad is
`C:\Development\projects\web-scraping\funda-bridge`.
