/* FloodPath AI — flood-aware evacuation routing demo (no build step, plain JS + Leaflet) */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- routing costs ----------
  const COST = { ok: 1, unverified: 2.5, flooded: 40 };
  const UNPAVED = new Set(["track", "path", "service"]);
  const WALK_KMH = 4.5;
  const ROAD_RE = "^(trunk|primary|secondary|tertiary|unclassified|residential|track|service|living_street)$";
  const SHELTER_RE = "^(school|hospital|clinic|community_centre|townhall|place_of_worship|college)$";
  const SHELTER_ICON = { school: "🏫", college: "🏫", hospital: "🏥", clinic: "🏥", community_centre: "🏛️", townhall: "🏛️", place_of_worship: "🕌" };
  const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

  // ---------- state ----------
  const S = {
    key: null, scen: null,
    nodes: new Map(), edges: [], adj: new Map(),
    shelters: [], blobs: [], imported: [],
    spread: 1, origin: null, mode: "origin",
    ranked: [], selected: 0, synthetic: false,
  };

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true, preferCanvas: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  map.createPane("gibs").style.zIndex = 250;
  map.createPane("flood").style.zIndex = 300;
  map.createPane("roads").style.zIndex = 400;
  map.createPane("route").style.zIndex = 450;
  const gibs = L.tileLayer("", { pane: "gibs", maxNativeZoom: 9, maxZoom: 19, opacity: 0.7, attribution: "NASA GIBS / MODIS Terra" });
  const floodLayer = L.layerGroup().addTo(map);
  const roadLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const shelterLayer = L.layerGroup().addTo(map);
  let originMarker = null;
  const canvas = L.canvas({ padding: 0.3 });

  // ---------- geometry ----------
  const rad = Math.PI / 180;
  function hav(a, b) {
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(x));
  }
  function rng(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
  function makeBlob(b, scale) {
    const r = rng(b.seed), ph = [r() * 6.28, r() * 6.28, r() * 6.28], pts = [], n = 36;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const k = 1 + 0.26 * Math.sin(3 * a + ph[0]) + 0.16 * Math.sin(5 * a + ph[1]) + 0.1 * Math.sin(2 * a + ph[2]);
      const m = b.r * scale * k;
      pts.push([b.lat + (m * Math.cos(a)) / 111320, b.lng + (m * Math.sin(a)) / (111320 * Math.cos(b.lat * rad))]);
    }
    return pts;
  }
  function withBBox(pts) {
    let s = 90, n = -90, w = 180, e = -180;
    for (const [la, ln] of pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, ln); e = Math.max(e, ln); }
    return { pts, s, n, w, e };
  }
  function inPoly(p, lat, lng) {
    if (lat < p.s || lat > p.n || lng < p.w || lng > p.e) return false;
    let inside = false; const q = p.pts;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
      const [yi, xi] = q[i], [yj, xj] = q[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  let polys = [];
  const rebuildPolys = () => { polys = [...S.blobs.map((b) => withBBox(makeBlob(b, S.spread))), ...S.imported.map(withBBox)]; };
  const wet = (lat, lng) => polys.some((p) => inPoly(p, lat, lng));

  // ---------- data loading ----------
  async function overpass(q) {
    let lastErr;
    for (const url of OVERPASS) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
        const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q),
          headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl.signal });
        clearTimeout(t);
        if (r.ok) return await r.json();
        lastErr = new Error("HTTP " + r.status);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("Overpass unavailable");
  }

  function buildGraph(ways) {
    const nodes = new Map(), edges = [];
    for (const w of ways) {
      if (!w.geometry || !w.nodes) continue;
      for (let i = 0; i < w.nodes.length; i++)
        if (!nodes.has(w.nodes[i])) nodes.set(w.nodes[i], { id: w.nodes[i], lat: w.geometry[i].lat, lng: w.geometry[i].lon });
      for (let i = 0; i < w.nodes.length - 1; i++) {
        const a = nodes.get(w.nodes[i]), b = nodes.get(w.nodes[i + 1]);
        edges.push({ a: a.id, b: b.id, len: hav(a, b), hw: w.tags.highway, status: "ok" });
      }
    }
    return keepLargest(nodes, edges);
  }

  function keepLargest(nodes, edges) {
    const adj = new Map();
    edges.forEach((e, i) => {
      (adj.get(e.a) || adj.set(e.a, []).get(e.a)).push(i);
      (adj.get(e.b) || adj.set(e.b, []).get(e.b)).push(i);
    });
    const comp = new Map(); let best = [], c = 0;
    for (const id of adj.keys()) {
      if (comp.has(id)) continue;
      const stack = [id], members = []; comp.set(id, c);
      while (stack.length) {
        const u = stack.pop(); members.push(u);
        for (const ei of adj.get(u)) { const e = edges[ei], v = e.a === u ? e.b : e.a; if (!comp.has(v)) { comp.set(v, c); stack.push(v); } }
      }
      if (members.length > best.length) best = members;
      c++;
    }
    const keep = new Set(best), nn = new Map(), ee = [];
    best.forEach((id) => nn.set(id, nodes.get(id)));
    for (const e of edges) if (keep.has(e.a) && keep.has(e.b)) ee.push(e);
    const nadj = new Map();
    ee.forEach((e, i) => {
      (nadj.get(e.a) || nadj.set(e.a, []).get(e.a)).push(i);
      (nadj.get(e.b) || nadj.set(e.b, []).get(e.b)).push(i);
    });
    return { nodes: nn, edges: ee, adj: nadj };
  }

  // Fallback when OpenStreetMap is unreachable: a jittered street grid + demo shelters
  function syntheticNetwork(sc) {
    const r = rng(99), N = 16, nodes = new Map(), edges = [], id = (i, j) => i * 100 + j + 1;
    const dLat = (sc.halfLat * 2) / (N - 1), dLng = (sc.halfLng * 2) / (N - 1);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++)
      nodes.set(id(i, j), { id: id(i, j), lat: sc.center[0] - sc.halfLat + i * dLat + (r() - 0.5) * dLat * 0.4, lng: sc.center[1] - sc.halfLng + j * dLng + (r() - 0.5) * dLng * 0.4 });
    const add = (a, b, hw) => edges.push({ a, b, len: hav(nodes.get(a), nodes.get(b)), hw, status: "ok" });
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const main = i % 5 === 0 || j % 5 === 0;
      if (j + 1 < N && (main || r() > 0.25)) add(id(i, j), id(i, j + 1), main ? "secondary" : r() > 0.7 ? "track" : "residential");
      if (i + 1 < N && (main || r() > 0.25)) add(id(i, j), id(i + 1, j), main ? "secondary" : r() > 0.7 ? "track" : "residential");
    }
    const g = keepLargest(nodes, edges);
    const types = ["school", "hospital", "community_centre", "place_of_worship", "school", "community_centre"];
    const shelters = types.map((t, k) => {
      const ids = [...g.nodes.keys()], n = g.nodes.get(ids[Math.floor(r() * ids.length)]);
      return { id: "syn" + k, name: "Demo " + t.replace(/_/g, " ") + " " + (k + 1), type: t, lat: n.lat + 0.0006, lng: n.lng + 0.0006 };
    });
    return { ...g, shelters };
  }

  async function loadSnapshot(key) {
    const r = await fetch(`data/${key}.json`);
    if (!r.ok) throw new Error("no snapshot");
    const d = await r.json();
    const g = buildGraph(d.ways.map((w) => ({ nodes: w.n, geometry: w.g.map(([lat, lon]) => ({ lat, lon })), tags: { highway: w.h } })));
    if (g.edges.length < 20) throw new Error("snapshot too small");
    return { ...g, shelters: d.shelters.filter((x) => !/\b(pet|vet|veterinary|animal|dental)\b/i.test(x.name)).map((x) => ({ ...x, name: x.name || "Unnamed " + x.type.replace(/_/g, " ") })) };
  }

  async function loadNetwork(sc, key) {
    try { return await loadSnapshot(key); } catch (e) { console.info("No bundled snapshot, trying live OSM", e.message); }
    const s =sc.center[0] - sc.halfLat, n = sc.center[0] + sc.halfLat, w = sc.center[1] - sc.halfLng, e = sc.center[1] + sc.halfLng;
    const bb = `${s},${w},${n},${e}`;
    const roads = await overpass(`[out:json][timeout:25];way["highway"~"${ROAD_RE}"](${bb});out geom;`);
    const g = buildGraph(roads.elements.filter((x) => x.type === "way"));
    if (g.edges.length < 20) throw new Error("too few roads");
    let shelters = [];
    try {
      const sh = await overpass(`[out:json][timeout:25];nwr["amenity"~"${SHELTER_RE}"](${bb});out center tags;`);
      shelters = sh.elements.map((x) => ({
        id: x.type + x.id, type: x.tags.amenity,
        name: x.tags.name || x.tags["name:en"] || "Unnamed " + x.tags.amenity.replace(/_/g, " "),
        lat: x.lat ?? x.center?.lat, lng: x.lon ?? x.center?.lon,
      })).filter((x) => x.lat != null);
    } catch (_) { /* shelters optional */ }
    return { ...g, shelters };
  }

  // ---------- classification ----------
  function classify() {
    rebuildPolys();
    const wetNode = new Map();
    for (const n of S.nodes.values()) wetNode.set(n.id, wet(n.lat, n.lng));
    const floodedEnds = new Set();
    for (const e of S.edges) {
      const a = S.nodes.get(e.a), b = S.nodes.get(e.b);
      let w = wetNode.get(e.a) || wetNode.get(e.b);
      for (const t of [0.25, 0.5, 0.75]) if (!w) w = wet(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
      e.status = w ? "flooded" : UNPAVED.has(e.hw) ? "unverified" : "ok";
      if (w) { floodedEnds.add(e.a); floodedEnds.add(e.b); }
    }
    for (const e of S.edges) if (e.status === "ok" && (floodedEnds.has(e.a) || floodedEnds.has(e.b))) e.status = "unverified";
    for (const sh of S.shelters) sh.wet = wet(sh.lat, sh.lng);
  }

  // OSM often has no shelters mapped in rural flood zones. Rather than hide that gap, add clearly
  // labelled PLACEHOLDER sites on dry junctions (greedy farthest-point sampling) so routing can be shown.
  function addPlaceholderShelters(min) {
    const real = S.shelters.filter((s) => !s.wet).length;
    if (real >= min) return;
    const wetNodes = new Set(), deg = new Map();
    for (const e of S.edges) {
      for (const id of [e.a, e.b]) deg.set(id, (deg.get(id) || 0) + 1);
      if (e.status !== "ok") { wetNodes.add(e.a); wetNodes.add(e.b); }
    }
    const cands = [...S.nodes.values()].filter((n) => !wetNodes.has(n.id) && deg.get(n.id) >= 2);
    if (!cands.length) return;
    const r = rng(7), picks = [cands[Math.floor(r() * cands.length)]];
    while (picks.length < 5 && picks.length < cands.length) {
      let best = null, bd = -1;
      for (const c of cands) { const d = Math.min(...picks.map((p) => hav(p, c))); if (d > bd) { bd = d; best = c; } }
      picks.push(best);
    }
    picks.forEach((n, i) => S.shelters.push({ id: "ph" + i, type: "community_centre", name: `Placeholder shelter site ${i + 1} (none mapped in OSM)`, lat: n.lat, lng: n.lng, placeholder: true }));
    for (const sh of S.shelters) sh.wet = wet(sh.lat, sh.lng);
  }

  // ---------- routing ----------
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() { const a = this.a, t = a[0], l = a.pop(); if (a.length) { a[0] = l; let i = 0; for (;;) { let m = i; const L = 2 * i + 1, R = L + 1; if (L < a.length && a[L][0] < a[m][0]) m = L; if (R < a.length && a[R][0] < a[m][0]) m = R; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return t; }
  }
  function dijkstra(src, w) {
    const dist = new Map([[src, 0]]), prev = new Map(), done = new Set(), h = new Heap();
    h.push(0, src);
    while (h.size) {
      const [d, u] = h.pop(); if (done.has(u)) continue; done.add(u);
      for (const ei of S.adj.get(u) || []) {
        const e = S.edges[ei], v = e.a === u ? e.b : e.a, nd = d + w(e);
        if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, [u, ei]); h.push(nd, v); }
      }
    }
    return { dist, prev };
  }
  function pathTo(prev, src, dst) {
    const nodes = [dst], eds = []; let u = dst;
    while (u !== src) { const p = prev.get(u); if (!p) return null; eds.push(S.edges[p[1]]); u = p[0]; nodes.push(u); }
    return { nodes: nodes.reverse().map((id) => S.nodes.get(id)), edges: eds };
  }
  function stats(p) {
    const r = { total: 0, flooded: 0, unverified: 0 };
    for (const e of p.edges) { r.total += e.len; if (e.status === "flooded") r.flooded += e.len; else if (e.status === "unverified") r.unverified += e.len; }
    return r;
  }
  function nearestNode(lat, lng) {
    let best = null, bd = Infinity;
    for (const n of S.nodes.values()) { const d = (n.lat - lat) ** 2 + ((n.lng - lng) * Math.cos(lat * rad)) ** 2; if (d < bd) { bd = d; best = n; } }
    return best;
  }
  function verdict(st) {
    if (st.flooded > 30) return { cls: "bad", label: "Crosses flooded road", color: "#ef4444" };
    if (st.unverified > 30) return { cls: "warn", label: "Partly unverified", color: "#f59e0b" };
    return { cls: "ok", label: "Dry on flood layer", color: "#22c55e" };
  }
  const km = (m) => (m / 1000).toFixed(m < 10000 ? 2 : 1) + " km";
  const mins = (m) => Math.max(1, Math.round((m / 1000 / WALK_KMH) * 60)) + " min walk";

  function analyze() {
    routeLayer.clearLayers();
    if (!S.origin || !S.nodes.size) return;
    const src = nearestNode(S.origin.lat, S.origin.lng);
    const { dist, prev } = dijkstra(src.id, (e) => e.len * COST[e.status]);
    const list = [];
    for (const sh of S.shelters) {
      if (sh.wet) continue;
      if (!sh.node) sh.node = nearestNode(sh.lat, sh.lng).id;
      const c = dist.get(sh.node);
      if (c == null) continue;
      list.push({ sh, cost: c });
    }
    list.sort((a, b) => a.cost - b.cost);
    S.ranked = list.slice(0, 5).map((x) => {
      const path = pathTo(prev, src.id, x.sh.node);
      return { sh: x.sh, path, st: stats(path) };
    });
    S.src = src; S.dijkPrev = prev;
    S.selected = Math.min(S.selected, Math.max(0, S.ranked.length - 1));
    renderShelters(); renderResults(); drawRoute();
  }

  // ---------- drawing ----------
  function drawFlood() {
    floodLayer.clearLayers();
    for (const p of polys) L.polygon(p.pts, { pane: "flood", color: "#1d4ed8", weight: 1.5, fillColor: "#2563eb", fillOpacity: 0.38, interactive: false }).addTo(floodLayer);
  }
  function drawRoads() {
    roadLayer.clearLayers();
    const g = { ok: [], unverified: [], flooded: [] };
    for (const e of S.edges) { const a = S.nodes.get(e.a), b = S.nodes.get(e.b); g[e.status].push([[a.lat, a.lng], [b.lat, b.lng]]); }
    const st = { ok: { color: "#7b8794", weight: 1.5, opacity: 0.8 }, unverified: { color: "#f59e0b", weight: 3, opacity: 0.95 }, flooded: { color: "#ef4444", weight: 3, opacity: 0.95 } };
    for (const k of ["ok", "unverified", "flooded"]) if (g[k].length) L.polyline(g[k], { ...st[k], pane: "roads", renderer: canvas, interactive: false }).addTo(roadLayer);
  }
  function renderShelters() {
    shelterLayer.clearLayers();
    const best = S.ranked[S.selected]?.sh;
    const top = new Set(S.ranked.map((r) => r.sh));
    for (const sh of S.shelters) {
      const cls = "shelter" + (sh.wet ? " wet" : "") + (sh === best ? " best" : "");
      if (!top.has(sh) && S.shelters.length > 12) {
        L.circleMarker([sh.lat, sh.lng], { radius: 4, color: "#fff", weight: 1, fillColor: sh.wet ? "#ef4444" : "#16a34a", fillOpacity: 0.9 })
          .bindPopup(`<b>${esc(sh.name)}</b><br>${esc(sh.type.replace(/_/g, " "))}${sh.wet ? "<br><b style='color:#dc2626'>Inside flood zone — excluded</b>" : "<br>Candidate shelter (OSM)"}`).addTo(shelterLayer);
        continue;
      }
      const m = L.marker([sh.lat, sh.lng], { icon: L.divIcon({ className: "", html: `<div class="${cls}">${SHELTER_ICON[sh.type] || "⛺"}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }), zIndexOffset: sh === best ? 1000 : 0 });
      m.bindPopup(`<b>${esc(sh.name)}</b><br>${esc(sh.type.replace(/_/g, " "))}${sh.wet ? "<br><b style='color:#dc2626'>Inside flood zone — excluded</b>" : (sh.placeholder ? "<br><i>Placeholder site for the demo — OpenStreetMap has no shelters mapped here.</i>" : "<br>Candidate shelter (OSM) — capacity & safety unverified")}`);
      m.on("click", () => { const i = S.ranked.findIndex((r) => r.sh === sh); if (i >= 0) { S.selected = i; renderShelters(); renderResults(); drawRoute(); } });
      m.addTo(shelterLayer);
    }
  }
  function drawRoute() {
    routeLayer.clearLayers();
    const r = S.ranked[S.selected]; if (!r) return;
    const ll = (nodes) => nodes.map((n) => [n.lat, n.lng]);
    // shortest route ignoring floods, for comparison
    const d = dijkstra(S.src.id, (e) => e.len);
    const short = pathTo(d.prev, S.src.id, r.sh.node);
    r.short = short ? { path: short, st: stats(short) } : null;
    if (short) L.polyline(ll(short.nodes), { pane: "route", color: "#f87171", weight: 4, dashArray: "6 8", opacity: 0.9, interactive: false }).addTo(routeLayer);
    const v = verdict(r.st), line = ll(r.path.nodes);
    L.polyline(line, { pane: "route", color: "#fff", weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
    L.polyline(line, { pane: "route", color: v.color, weight: 5, interactive: false }).addTo(routeLayer);
    L.polyline([[S.origin.lat, S.origin.lng], line[0]], { pane: "route", color: v.color, weight: 2, dashArray: "2 6" }).addTo(routeLayer);
    L.polyline([line[line.length - 1], [r.sh.lat, r.sh.lng]], { pane: "route", color: v.color, weight: 2, dashArray: "2 6" }).addTo(routeLayer);
    renderResults();
  }
  function renderResults() {
    const el = $("results");
    if (!S.ranked.length) { el.innerHTML = `<div class="status warn">No reachable dry shelter found. Try moving your pin or lowering the water spread.</div>`; return; }
    el.innerHTML = S.ranked.map((r, i) => {
      const v = verdict(r.st);
      let extra = "";
      if (i === S.selected && r.short) {
        const sv = r.short.st;
        extra = `<div class="cmp">Shortest route <b>${km(sv.total)}</b> would cross <b>${km(sv.flooded)}</b> of flooded road. Recommended route crosses <b>${km(r.st.flooded)}</b>${r.st.unverified > 30 ? ` and has <b>${km(r.st.unverified)}</b> unverified` : ""}.</div>`;
      }
      return `<div class="card ${i === S.selected ? "sel" : ""}" data-i="${i}">
        <div class="top"><span class="name">${i + 1}. ${esc(r.sh.name)}</span><span class="badge ${v.cls}">${v.label}</span></div>
        <div class="meta">${esc(r.sh.type.replace(/_/g, " "))} · ${km(r.st.total)} · ${mins(r.st.total)}${r.st.flooded > 30 ? " · ⚠ wading" : ""}</div>${extra}</div>`;
    }).join("");
    el.querySelectorAll(".card").forEach((c) => c.addEventListener("click", () => { S.selected = +c.dataset.i; renderShelters(); drawRoute(); }));
  }
  function setStatus(msg, cls = "") { const s = $("status"); s.textContent = msg; s.className = "status " + cls; }

  function refreshAll() { classify(); drawFlood(); drawRoads(); analyze(); updateStatus(); }
  function updateStatus() {
    const f = S.edges.filter((e) => e.status === "flooded").length, u = S.edges.filter((e) => e.status === "unverified").length;
    const base = `${S.edges.length.toLocaleString()} road segments · ${f.toLocaleString()} flooded · ${u.toLocaleString()} unverified · ${S.shelters.filter((s) => !s.wet).length} usable shelters`;
    setStatus((S.synthetic ? "⚠ OpenStreetMap unreachable — using synthetic demo network. " : "") + base, S.synthetic ? "warn" : "");
  }

  // ---------- origin ----------
  function setOrigin(lat, lng, pan) {
    S.origin = { lat, lng };
    if (!originMarker) {
      originMarker = L.marker([lat, lng], { draggable: true, zIndexOffset: 2000, icon: L.divIcon({ className: "", html: '<div class="pin">📍</div>', iconSize: [28, 34], iconAnchor: [14, 32] }) }).addTo(map);
      originMarker.on("dragend", () => { const p = originMarker.getLatLng(); S.origin = { lat: p.lat, lng: p.lng }; S.selected = 0; analyze(); });
    } else originMarker.setLatLng([lat, lng]);
    if (pan) map.panTo([lat, lng]);
    S.selected = 0; analyze();
  }

  // ---------- scenario ----------
  async function loadScenario(key) {
    const sc = SCENARIOS[key]; S.key = key; S.scen = sc;
    S.blobs = sc.blobs.map((b) => ({ ...b })); S.imported = []; S.synthetic = false;
    S.nodes = new Map(); S.edges = []; S.adj = new Map(); S.shelters = []; S.ranked = [];
    routeLayer.clearLayers(); shelterLayer.clearLayers(); roadLayer.clearLayers(); $("results").innerHTML = "";
    $("village").innerHTML = sc.villages.map((v, i) => `<option value="${i}">${esc(v.name)}</option>`).join("");
    $("gibsDate").value = sc.dates.during; setGibs();
    map.setView(sc.center, sc.zoom);
    rebuildPolys(); drawFlood();
    $("loader").hidden = false; setStatus("Loading roads & shelters (OpenStreetMap)…");
    let net;
    try { net = await loadNetwork(sc, key); }
    catch (err) { console.warn("OSM load failed:", err); net = syntheticNetwork(sc); S.synthetic = true; }
    if (S.key !== key) return; // user switched scenario meanwhile
    S.nodes = net.nodes; S.edges = net.edges; S.adj = net.adj; S.shelters = net.shelters;
    $("loader").hidden = true;
    classify(); addPlaceholderShelters(4); drawFlood(); drawRoads();
    const v = sc.villages[0]; setOrigin(v.lat, v.lng, false); updateStatus();
  }

  function setGibs() {
    gibs.setUrl(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${$("gibsLayer").value}/default/${$("gibsDate").value}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`);
    if ($("gibsOn").checked) { if (!map.hasLayer(gibs)) gibs.addTo(map); } else map.removeLayer(gibs);
  }

  // ---------- UI wiring ----------
  $("scenario").innerHTML = Object.entries(SCENARIOS).map(([k, s]) => `<option value="${k}">${esc(s.name)}</option>`).join("");
  $("scenario").addEventListener("change", (e) => loadScenario(e.target.value));
  $("village").addEventListener("change", (e) => { const v = S.scen.villages[+e.target.value]; setOrigin(v.lat, v.lng, true); });
  let spreadTimer;
  $("spread").addEventListener("input", (e) => {
    $("spreadVal").textContent = e.target.value + "%"; S.spread = e.target.value / 100;
    clearTimeout(spreadTimer); spreadTimer = setTimeout(refreshAll, 120);
  });
  $("btnAddFlood").addEventListener("click", () => {
    S.mode = S.mode === "flood" ? "origin" : "flood";
    $("btnAddFlood").classList.toggle("active", S.mode === "flood");
    setStatus(S.mode === "flood" ? "Click the map to drop a flood zone (~1 km radius)." : "");
    if (S.mode !== "flood") updateStatus();
  });
  $("btnClearFlood").addEventListener("click", () => { S.blobs = S.scen.blobs.map((b) => ({ ...b })); S.imported = []; refreshAll(); });
  $("geojson").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const gj = JSON.parse(await f.text()), polysOut = [];
      const rings = (g) => { if (!g) return; if (g.type === "Polygon") polysOut.push(g.coordinates[0]); else if (g.type === "MultiPolygon") g.coordinates.forEach((p) => polysOut.push(p[0])); else if (g.type === "GeometryCollection") g.geometries.forEach(rings); };
      if (gj.type === "FeatureCollection") gj.features.forEach((ft) => rings(ft.geometry)); else if (gj.type === "Feature") rings(gj.geometry); else rings(gj);
      if (!polysOut.length) throw new Error("no polygons");
      S.imported.push(...polysOut.map((r) => r.map(([lng, lat]) => [lat, lng])));
      refreshAll(); setStatus(`Imported ${polysOut.length} flood polygon(s). ` + $("status").textContent);
    } catch (err) { setStatus("Could not read GeoJSON polygons from that file.", "err"); }
    e.target.value = "";
  });
  ["gibsOn", "gibsLayer", "gibsDate"].forEach((id) => $(id).addEventListener("change", setGibs));
  $("gibsOpacity").addEventListener("input", (e) => gibs.setOpacity(e.target.value / 100));
  $("btnBefore").addEventListener("click", () => { $("gibsDate").value = S.scen.dates.before; setGibs(); });
  $("btnDuring").addEventListener("click", () => { $("gibsDate").value = S.scen.dates.during; setGibs(); });
  map.on("click", (e) => {
    if (S.mode === "flood") {
      S.blobs.push({ lat: e.latlng.lat, lng: e.latlng.lng, r: 1000, seed: Math.floor(Math.random() * 1e6) });
      S.mode = "origin"; $("btnAddFlood").classList.remove("active"); refreshAll();
    } else setOrigin(e.latlng.lat, e.latlng.lng, false);
  });

  // exposed for debugging / automated checks
  window.FloodPath = { S, loadScenario, setOrigin };
  loadScenario("dadu");
})();
