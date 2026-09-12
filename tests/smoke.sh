#!/usr/bin/env bash
# Rooktest voor de funda-bridge tegen de echte Funda-API.
#
#   ./tests/smoke.sh [poort] [funda-url]
#
# Draait de bridge niet? Start hem eerst met ./run-bridge.sh
set -euo pipefail

poort="${1:-8767}"
url="${2:-https://www.funda.nl/detail/koop/utrecht/appartement-bataviastraat-42/44592608/}"
basis="http://127.0.0.1:$poort"
uit="/tmp/funda-smoke.json"

echo "== /health =="
curl -fsS --max-time 10 "$basis/health" || { echo "bridge niet bereikbaar op $basis"; exit 1; }
echo

echo "== /listing =="
enc="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$url")"
code="$(curl -sS --max-time 120 "$basis/listing?url=$enc" -o "$uit" -w '%{http_code}')"
echo "http=$code"

python3 - "$code" <<'PY'
import json, sys

code = sys.argv[1]
data = json.load(open('/tmp/funda-smoke.json'))
if not data.get('ok'):
    print('  MISLUKT:', data.get('error'))
    sys.exit(1)

print(f"  {data.get('adres')} | {data.get('stad')} - {data.get('buurt')}")
print(f"  prijs EUR {data.get('prijs')} | {data.get('woonopp')} m2 | EUR {data.get('prijsPerM2')}/m2")
print(f"  label {data.get('energielabel')} | bouwjaar {data.get('bouwjaar')} | {data.get('woningtype')}")
print(f"  bekeken {data.get('bekeken')} | bewaard {data.get('bewaard')} | "
      f"historie {len(data.get('prijsHistorie') or [])} mutaties")
secties = list((data.get('kenmerken') or {}).keys())
print(f"  kenmerken: {len(secties)} secties")

verwacht = ['prijs', 'woonopp', 'energielabel', 'bouwjaar']
ontbreekt = [v for v in verwacht if data.get(v) in (None, '')]
if ontbreekt:
    print('  MISLUKT: velden ontbreken:', ', '.join(ontbreekt))
    sys.exit(1)

if data.get('buurtFout'):
    print('  let op: buurtgemiddelde niet opgehaald -', data['buurtFout'])
if data.get('prijsHistorieFout'):
    print('  let op: prijshistorie niet opgehaald -', data['prijsHistorieFout'])
print('  OK')
PY
