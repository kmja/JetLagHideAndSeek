#!/usr/bin/env node
/**
 * build-coverage-map.mjs
 *
 * One-shot script that hits /admin/list-cities, derives a lat/lng
 * centroid from each entry's `extent`, and writes a self-contained
 * HTML file you can open in any browser. Shows every city the cache
 * is currently warming as a dot on a dark world map; unresolved
 * candidate names (still in bulk-city-names.json with no Photon
 * resolution yet) are listed in a sidebar so it's clear what's
 * missing without dragging the map around.
 *
 * Usage:
 *   node scripts/build-coverage-map.mjs \
 *     --worker https://jlhs-overpass-cache.<sub>.workers.dev \
 *     --secret <ADMIN_SECRET> \
 *     [--out coverage.html]
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
if (!args.worker || !args.secret) {
    console.error(
        "usage: --worker URL --secret SECRET [--out coverage.html]",
    );
    process.exit(1);
}
const WORKER = args.worker.replace(/\/+$/, "");
const SECRET = args.secret;
const OUT = args.out ?? "coverage.html";

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;
        const k = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            out[k] = true;
        } else {
            out[k] = next;
            i++;
        }
    }
    return out;
}

async function listCities() {
    const resp = await fetch(`${WORKER}/admin/list-cities`, {
        headers: { Authorization: `Bearer ${SECRET}` },
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`list-cities failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    return data.cities ?? [];
}

function centroidFromExtent(extent) {
    // Photon shape: [maxLat, minLng, minLat, maxLng].
    if (!Array.isArray(extent) || extent.length !== 4) return null;
    const [maxLat, minLng, minLat, maxLng] = extent;
    if (![maxLat, minLng, minLat, maxLng].every(Number.isFinite)) return null;
    return [(maxLat + minLat) / 2, (minLng + maxLng) / 2];
}

async function main() {
    console.log(`fetching cities from ${WORKER}/admin/list-cities …`);
    const cities = await listCities();
    console.log(`got ${cities.length} cities`);

    // Read the full candidate list to compute what's STILL missing.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidatesPath = path.join(here, "..", "bulk-city-names.json");
    const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
    const knownHeads = new Set(
        cities.map((c) => c.name.split(",")[0].trim().toLowerCase()),
    );
    const unresolved = candidates.filter(
        (raw) =>
            !knownHeads.has(raw.split(",")[0].trim().toLowerCase()),
    );

    // Compute markers — only cities with usable extent appear on the
    // map. Entries without extent (legacy / not yet backfilled) get
    // counted separately so the legend reflects reality.
    const markers = [];
    let withoutExtent = 0;
    for (const c of cities) {
        const ll = centroidFromExtent(c.extent);
        if (!ll) {
            withoutExtent++;
            continue;
        }
        markers.push({ name: c.name, lat: ll[0], lng: ll[1], r: c.relationId });
    }

    console.log(
        `plotting ${markers.length} markers; ${withoutExtent} resolved cities have no extent yet; ${unresolved.length} candidates still unresolved`,
    );

    const html = renderHtml({
        markers,
        unresolved,
        withoutExtent,
        candidatesTotal: candidates.length,
        resolvedTotal: cities.length,
        generatedAt: new Date().toISOString(),
        workerUrl: WORKER,
    });

    await writeFile(OUT, html, "utf8");
    console.log(`wrote ${OUT}`);
}

function renderHtml({
    markers,
    unresolved,
    withoutExtent,
    candidatesTotal,
    resolvedTotal,
    generatedAt,
    workerUrl,
}) {
    // Embed everything inline so the file works offline once Leaflet's
    // CDN script + tile fetches have been allowed once.
    const data = JSON.stringify(markers);
    const unresolvedList = JSON.stringify(unresolved);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>JetLag Hide+Seek — Cache Coverage</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0f172a; color: #e2e8f0;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  #map { position: absolute; inset: 0; }
  .panel {
    position: absolute; top: 12px; left: 12px; z-index: 1000;
    background: rgba(15, 23, 42, 0.92); border: 1px solid #334155;
    padding: 12px 14px; border-radius: 8px; max-width: 280px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .panel h1 { margin: 0 0 4px 0; font-size: 14px; font-weight: 700; }
  .panel .meta { color: #94a3b8; font-size: 11px; }
  .panel .stat { display: flex; justify-content: space-between; padding: 2px 0; }
  .panel .stat b { color: #f1f5f9; }
  .panel .sub { color: #94a3b8; font-size: 11px; margin-top: 6px; }
  details { margin-top: 10px; }
  details summary { cursor: pointer; color: #f59e0b; font-weight: 600; user-select: none; }
  details > div {
    max-height: 240px; overflow-y: auto; margin-top: 6px;
    background: rgba(0,0,0,0.3); padding: 6px 8px; border-radius: 4px;
    font-size: 11px; font-family: ui-monospace, Menlo, monospace; color: #cbd5e1;
  }
  .leaflet-container { background: #1e293b; }
  .leaflet-control-attribution { background: rgba(15, 23, 42, 0.7) !important; color: #94a3b8; }
  .leaflet-control-attribution a { color: #f59e0b; }
</style>
</head>
<body>
<div id="map"></div>
<div class="panel">
  <h1>Cache coverage</h1>
  <div class="meta">${escapeHtml(workerUrl)}</div>
  <div class="meta">generated ${escapeHtml(generatedAt)}</div>
  <hr style="border: 0; border-top: 1px solid #334155; margin: 8px 0;">
  <div class="stat"><span>On map</span><b>${markers.length}</b></div>
  <div class="stat"><span>Resolved (total)</span><b>${resolvedTotal}</b></div>
  <div class="stat"><span>Candidates (target)</span><b>${candidatesTotal}</b></div>
  <div class="stat" style="color:#94a3b8"><span>Resolved w/o extent</span><span>${withoutExtent}</span></div>
  <div class="sub">Each dot is a city we're warming boundary + reference data for. Click for name.</div>
  <details>
    <summary>${unresolved.length} unresolved candidates</summary>
    <div id="unresolved"></div>
  </details>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin></script>
<script>
  const markers = ${data};
  const unresolved = ${unresolvedList};
  const map = L.map('map', { worldCopyJump: true }).setView([20, 0], 2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap © CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  for (const m of markers) {
    L.circleMarker([m.lat, m.lng], {
      radius: 3,
      color: '#f97316',
      weight: 0,
      fillColor: '#f97316',
      fillOpacity: 0.7,
    }).bindTooltip(m.name + ' (r' + m.r + ')', { direction: 'top', offset: [0, -2] })
      .addTo(layer);
  }
  document.getElementById('unresolved').innerHTML =
    unresolved.map(n => '<div>' + n.replace(/</g,'&lt;') + '</div>').join('') || '<i>none — full coverage</i>';
</script>
</body>
</html>
`;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
});
