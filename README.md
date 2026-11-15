# 🌊 FloodPath AI — Where Can People Escape?

**Flood-aware evacuation routing built on NASA Earth observation data.**
During floods, people often don't know which roads are under water or where the nearest usable shelter is. FloodPath AI combines satellite flood information with road networks and candidate shelters to suggest escape routes — and, just as importantly, **labels every route with an honest confidence level** so unverified paths are never presented as safe.

> 🔗 **Live demo:** https://affanbook018-maker.github.io/floodpath-ai/ · Source: https://github.com/affanbook018-maker/floodpath-ai

## What the demo does

1. **Pick a flood event** (Sindh/Indus 2022, Sylhet 2022, Kuttanad/Kerala 2018) and a flooded settlement.
2. **See NASA GIBS satellite imagery** (MODIS Terra true colour or bands 7-2-1 where water is dark) with a **Before / During** date toggle.
3. **Every road segment is classified** against the flood layer: ✅ dry · 🟧 unverified (unpaved, or touching flooded road) · 🟥 flooded.
4. **Nearby shelters are ranked** (schools, hospitals, community centres, places of worship from OpenStreetMap) by safest-route cost; shelters standing inside the flood are excluded.
5. **Compare routes**: the recommended route vs. the *shortest route that ignores flooding*, with the kilometres of flooded road each would cross.
6. **Interactive**: drag the 📍 pin, slide the *water spread* to simulate rising water, drop extra flood zones, or **import a real flood mask as GeoJSON**.

## How it works

| Step | Method |
|---|---|
| Satellite context | NASA GIBS WMTS tiles (MODIS Terra Corrected Reflectance) |
| Roads & shelters | OpenStreetMap (bundled snapshots in `data/`, refreshable with `scripts/fetch_data.py`) |
| Flood layer | Illustrative blobs for the built-in scenarios; any official flood polygon via GeoJSON import |
| Segment check | Ray-casting point-in-polygon on endpoints + 3 interior samples per segment |
| Routing | Dijkstra, cost multipliers: dry ×1 · unverified ×2.5 · flooded ×40 (so a "least bad" route still exists if people are already surrounded, but is flagged red) |
| Confidence label | *Dry on flood layer* / *Partly unverified* / *Crosses flooded road* |

## Honest limitations

- Built-in flood extents are **illustrative**, not observed inundation maps. For real use, import NASA Disasters / UNOSAT / Copernicus EMS / Sentinel-1 flood masks.
- GIBS MODIS tiles are ~250 m resolution and cloud-affected during monsoon — they give context, not road-level truth.
- Shelter capacity, access and safety are **not** known; OSM tags only mark candidates.
- Not for real emergency navigation.

## Run locally

No build step. Any static server works:

```bash
python -m http.server 8000
# open http://localhost:8000
```

Refresh the road/shelter snapshots (optional, uses public Overpass servers):

```bash
python scripts/fetch_data.py
```

## Roadmap

- Ingest NASA flood products automatically (e.g. Sentinel-1/VIIRS-derived flood extents, GPM rainfall forecasts)
- Elevation (SRTM/NASADEM) to prefer high ground and predict where water goes next
- Offline PWA + SMS/WhatsApp route sharing for low-connectivity villages
- Community reports to turn *unverified* roads into verified ones

## Credits & licences

- NASA GIBS / MODIS imagery — NASA EOSDIS (open data)
- Map data © OpenStreetMap contributors (ODbL) · Leaflet (BSD-2)
- Code: MIT
