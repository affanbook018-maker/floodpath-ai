"""Prefetch OpenStreetMap roads + candidate shelters for each demo scenario into data/<key>.json.
Run:  python scripts/fetch_data.py [key ...]
Public Overpass servers are slow/flaky, so the app ships these snapshots and only
falls back to live Overpass if a snapshot is missing. Data (c) OpenStreetMap contributors, ODbL."""
import json, re, sys, time, urllib.parse, urllib.request, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
             "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
ROAD_RE = "^(trunk|primary|secondary|tertiary|unclassified|residential|track|service|living_street)$"
SHELTER_RE = "^(school|hospital|clinic|community_centre|townhall|place_of_worship|college)$"

def scenarios():
    src = (ROOT / "scenarios.js").read_text(encoding="utf-8")
    out = {}
    for key in re.findall(r"^  (\w+): \{$", src, re.M):
        block = src[src.index(f"  {key}: {{"):]
        c = re.search(r"center: \[([\d.\-]+), ([\d.\-]+)\]", block)
        h = re.search(r"halfLat: ([\d.]+), halfLng: ([\d.]+)", block)
        out[key] = dict(lat=float(c[1]), lng=float(c[2]), hl=float(h[1]), hg=float(h[2]))
    return out

def overpass(q):
    last = None
    for attempt in range(3):
        for url in ENDPOINTS:
            try:
                req = urllib.request.Request(url, data=("data=" + urllib.parse.quote(q)).encode(),
                                             headers={"User-Agent": "floodpath-ai-hackathon-demo"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    return json.load(r)
            except Exception as e:
                last = e; print("  retry:", url, e)
        time.sleep(5)
    raise last

def main():
    sc = scenarios(); keys = sys.argv[1:] or list(sc)
    (ROOT / "data").mkdir(exist_ok=True)
    for k in keys:
        s = sc[k]; bb = f'{s["lat"]-s["hl"]},{s["lng"]-s["hg"]},{s["lat"]+s["hl"]},{s["lng"]+s["hg"]}'
        print("fetching", k, bb)
        roads = overpass(f'[out:json][timeout:90];way["highway"~"{ROAD_RE}"]({bb});out geom;')
        ways = [{"h": w["tags"]["highway"], "n": w["nodes"], "g": [[round(p["lat"], 6), round(p["lon"], 6)] for p in w["geometry"]]}
                for w in roads["elements"] if w["type"] == "way" and "geometry" in w]
        sh = overpass(f'[out:json][timeout:90];nwr["amenity"~"{SHELTER_RE}"]({bb});out center tags;')
        shelters = []
        for x in sh["elements"]:
            lat = x.get("lat") or x.get("center", {}).get("lat"); lng = x.get("lon") or x.get("center", {}).get("lon")
            if lat is None: continue
            t = x["tags"]
            shelters.append({"id": f'{x["type"]}{x["id"]}', "type": t["amenity"], "name": t.get("name") or t.get("name:en") or "", "lat": lat, "lng": lng})
        (ROOT / "data" / f"{k}.json").write_text(json.dumps({"ways": ways, "shelters": shelters}, separators=(",", ":")), encoding="utf-8")
        print(f"  {k}: {len(ways)} ways, {len(shelters)} shelters")

if __name__ == "__main__":
    main()
