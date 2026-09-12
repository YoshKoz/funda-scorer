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

```bash
./tests/smoke.sh 8767                 # brug + echte woning
./tests/extension-live.cjs            # extensie in Chromium op een echte Funda-pagina
REQUIRE_BRIDGE=1 ./tests/extension-live.cjs
SCREENSHOT=/tmp/paneel.png ./tests/extension-live.cjs
```

Voor `extension-live.cjs` is Playwright nodig. Zonder installatie kun je de
kopie uit de npx-cache gebruiken:

```bash
NODE_PATH="$HOME/.npm/_npx/9833c18b2d85bc59/node_modules" node tests/extension-live.cjs
```

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

## Verschil met de desktop-versie

- `bridge/bridge.py`: poort komt uit `FUNDA_BRIDGE_PORT` in plaats van hardcoded 8765.
- `extension/scoring.js` + `content.js`: `resolveBridgeUrl()` zoekt de poort,
  onthoudt hem in `chrome.storage.local` en valt terug op DOM-only als de brug
  uit staat. `BRIDGE_URL` blijft de default.
- `extension/manifest.json`: `host_permissions` uitgebreid met poorten 8767-8770.

Verder is de code gelijk, inclusief de verouderde padverwijzing in de
Claude-memory op de desktop (`C:\Development\funda-bridge`); het echte pad is
`C:\Development\projects\web-scraping\funda-bridge`.
