# Uploading a z15 regional Protomaps basemap to R2

This extends `upload-pmtiles.md` (the worldwide z13 recipe) to a
**higher-detail z15 build limited to the regions we actually play in**:
Europe, North America, and a ~25 km box around every city in the
worker's curated list. z15 is Protomaps' source ceiling — the deepest
real vector data the planet build contains — so this gives building
footprints + the sharpest geometry the basemap offers, without the
~127 GB cost of a worldwide z15 extract.

## Why region-limited instead of worldwide z15

- Worldwide z15 ≈ 127 GB. Europe + North America + ~230 city boxes at
  z15 ≈ **45-55 GB** (~$0.70-0.85/month on R2). Same street-level
  detail where games actually happen, a third of the storage.
- `pmtiles extract --region <file>.geojson` pulls only the tiles whose
  bbox intersects the region polygons, via many small range requests —
  robust and far smaller than a full download.

## What the region file contains

One GeoJSON `FeatureCollection`:
1. A rectangle for **Europe** (`-25,34,46,72`).
2. A rectangle for **North America** (`-170,15,-50,75`).
3. A **~25 km box around each city** the worker's `/admin/list-cities`
   returns whose centroid falls *outside* both rectangles (Tokyo,
   Sydney, São Paulo, …). Cities inside EU/NA are already covered by
   the rectangles, so we don't double-box them.

City centroids come from the city's `extent` when the worker carries
one, else from a Nominatim `lookup` of its OSM relation id (batched 50
at a time, 1.1 s apart per Nominatim's usage policy).

## The recipe (Windows PowerShell)

Fill in the 3 R2 token values + the worker admin secret, paste the
block, walk away. Self-installs `pmtiles.exe` + `rclone.exe`, builds
the region file, extracts z15, uploads, verifies. Plan it overnight —
extract is ~30-60 min, upload depends on your upstream (45-55 GB).

```powershell
$R2_ACCESS_KEY = "<ACCESS_KEY_ID>"
$R2_SECRET     = "<SECRET_ACCESS_KEY>"
$R2_ACCOUNT_ID = "<ACCOUNT_ID>"
$ADMIN_SECRET  = "<WORKER_ADMIN_SECRET>"
$BUILD_DATE    = "20260614"   # https://build.protomaps.com/YYYYMMDD.pmtiles
$MAXZOOM       = 15           # Protomaps source ceiling
$WORKER        = "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev"
$CITY_BOX_DEG  = 0.30         # ~33 km half-box around each outlier city

# Fail fast if any value is still a placeholder — otherwise you get a
# confusing wall of 401 + DNS errors far below.
foreach ($pair in @(
    @("R2_ACCESS_KEY", $R2_ACCESS_KEY), @("R2_SECRET", $R2_SECRET),
    @("R2_ACCOUNT_ID", $R2_ACCOUNT_ID), @("ADMIN_SECRET", $ADMIN_SECRET)
)) {
    if ($pair[1] -match '^<.*>$' -or [string]::IsNullOrWhiteSpace($pair[1])) {
        throw "Fill in `$$($pair[0]) before running — it's still the placeholder."
    }
}

$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$work = "$env:USERPROFILE\jlhs-pmtiles"
New-Item -ItemType Directory -Force -Path $work | Out-Null; Set-Location $work

function Get-Tool($url, $zip, $exe) {
    if (Test-Path "$work\$exe") { return }
    Invoke-WebRequest $url -OutFile "$work\$zip"
    Expand-Archive "$work\$zip" -DestinationPath "$work\$($exe)-x" -Force
    Copy-Item (Get-ChildItem "$work\$($exe)-x" -Recurse -Filter $exe |
               Select-Object -First 1).FullName "$work\$exe" -Force
}
Get-Tool "https://github.com/protomaps/go-pmtiles/releases/download/v1.30.3/go-pmtiles_1.30.3_Windows_x86_64.zip" "pm.zip" "pmtiles.exe"
Get-Tool "https://downloads.rclone.org/rclone-current-windows-amd64.zip" "rc.zip" "rclone.exe"

# ── 1. Build region.geojson ───────────────────────────────────────
# EU + NA rectangles, plus a box around each city centroid outside them.
$UA = "jlhs-region-builder/1.0 (https://github.com/kmja/jetlaghideandseek)"

function New-RectPolygon($w, $s, $e, $n) {
    return @(,@(
        @($w, $s), @($e, $s), @($e, $n), @($w, $n), @($w, $s)
    ))
}
function Test-InRect($lng, $lat, $w, $s, $e, $n) {
    return ($lng -ge $w -and $lng -le $e -and $lat -ge $s -and $lat -le $n)
}

$EU = @{ w = -25; s = 34; e = 46; n = 72 }
$NA = @{ w = -170; s = 15; e = -50; n = 75 }

$features = New-Object System.Collections.ArrayList
[void]$features.Add(@{ type = "Feature"; properties = @{ name = "Europe" };
    geometry = @{ type = "Polygon"; coordinates = (New-RectPolygon $EU.w $EU.s $EU.e $EU.n) } })
[void]$features.Add(@{ type = "Feature"; properties = @{ name = "North America" };
    geometry = @{ type = "Polygon"; coordinates = (New-RectPolygon $NA.w $NA.s $NA.e $NA.n) } })

# Fetch the worker's merged city list.
$cities = (Invoke-RestMethod -Uri "$WORKER/admin/list-cities" `
    -Headers @{ Authorization = "Bearer $ADMIN_SECRET" } -UserAgent $UA).cities
Write-Host "Got $($cities.Count) cities from the worker."

# Resolve centroids: use the city's extent when present, else batch
# Nominatim lookups (50 ids / request, 1.1 s apart).
$needLookup = New-Object System.Collections.ArrayList
$centroids = @{}
foreach ($c in $cities) {
    if ($c.extent -and $c.extent.Count -eq 4) {
        # extent = [maxLat, minLng, minLat, maxLng]
        $centroids[$c.relationId] = @{
            lat = ($c.extent[0] + $c.extent[2]) / 2
            lng = ($c.extent[1] + $c.extent[3]) / 2
        }
    } else {
        [void]$needLookup.Add($c.relationId)
    }
}
for ($i = 0; $i -lt $needLookup.Count; $i += 50) {
    $batch = $needLookup[$i..([Math]::Min($i + 49, $needLookup.Count - 1))]
    $ids = ($batch | ForEach-Object { "R$_" }) -join ","
    try {
        $res = Invoke-RestMethod -Uri "https://nominatim.openstreetmap.org/lookup?osm_ids=$ids&format=json" `
            -UserAgent $UA
        foreach ($r in $res) {
            $centroids[[int]$r.osm_id] = @{ lat = [double]$r.lat; lng = [double]$r.lon }
        }
    } catch {
        Write-Warning "Nominatim batch at $i failed: $_"
    }
    Start-Sleep -Milliseconds 1100
}

# Box every city whose centroid is outside both rectangles.
$boxed = 0
foreach ($c in $cities) {
    $ctr = $centroids[$c.relationId]
    if (-not $ctr) { continue }
    if ((Test-InRect $ctr.lng $ctr.lat $EU.w $EU.s $EU.e $EU.n) -or
        (Test-InRect $ctr.lng $ctr.lat $NA.w $NA.s $NA.e $NA.n)) { continue }
    $latPad = $CITY_BOX_DEG
    $lngPad = $CITY_BOX_DEG / [Math]::Cos($ctr.lat * [Math]::PI / 180)
    [void]$features.Add(@{ type = "Feature"; properties = @{ name = $c.name };
        geometry = @{ type = "Polygon"; coordinates =
            (New-RectPolygon ($ctr.lng - $lngPad) ($ctr.lat - $latPad) `
                             ($ctr.lng + $lngPad) ($ctr.lat + $latPad)) } })
    $boxed++
}
Write-Host "Added $boxed city boxes outside EU/NA."

$region = @{ type = "FeatureCollection"; features = $features.ToArray() }
$json = $region | ConvertTo-Json -Depth 10 -Compress
# Write BOM-less UTF-8. Windows PowerShell 5.1's `Set-Content -Encoding
# utf8` prepends a UTF-8 BOM (EF BB BF), and go-pmtiles' JSON parser
# rejects it with "invalid character 'ï' looking for beginning of
# value". WriteAllText with a UTF8Encoding($false) writes no BOM on
# both PS 5.1 and 7.
[System.IO.File]::WriteAllText("$work\region.geojson", $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Wrote region.geojson with $($features.Count) features."

# ── 2. Extract z15 limited to the region ──────────────────────────
& "$work\pmtiles.exe" extract "https://build.protomaps.com/$BUILD_DATE.pmtiles" `
    "$work\basemap.pmtiles" "--maxzoom=$MAXZOOM" "--region=$work\region.geojson" `
    "--download-threads=8"

# ── 3. Upload to R2 under the key the app reads ───────────────────
$env:RCLONE_CONFIG_R2_TYPE = "s3"
$env:RCLONE_CONFIG_R2_PROVIDER = "Cloudflare"
$env:RCLONE_CONFIG_R2_ACCESS_KEY_ID = $R2_ACCESS_KEY
$env:RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = $R2_SECRET
$env:RCLONE_CONFIG_R2_ENDPOINT = "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
& "$work\rclone.exe" copyto "$work\basemap.pmtiles" "r2:jlhs-tiles/basemap.pmtiles" `
    --s3-no-check-bucket --s3-chunk-size=256M --s3-upload-concurrency=8 `
    --retries=20 --low-level-retries=40 --progress

curl.exe -I "$WORKER/tiles/basemap.pmtiles"
```

## Verify

The final `curl -I` should show `HTTP/1.1 200`, `Accept-Ranges:
bytes`, and a `Content-Length` of ~45-55 GB. Once it's 200, the app's
probe (`src/lib/protomapsStyle.ts`) stops falling back to the demo
bucket on the next page load.

## Notes

- **Outside the covered regions** (e.g. someone plays in rural Africa
  or central Asia not in the city list) the map renders nothing — the
  PMTiles file simply has no tiles there. The v241 fallback catches
  this: a tile-load error flips that session to the Protomaps demo
  bucket so the map still works, just at the demo's detail. If you
  expect to play somewhere new, add its city to the worker list first
  (it'll get a box on the next region build) or fall back to the
  worldwide z13 recipe.
- **Adjust the regions** by editing the `$EU` / `$NA` rectangles or
  `$CITY_BOX_DEG`. Bigger boxes cover sprawling metros but cost more.
- **Refresh cadence**: re-run monthly against a newer `$BUILD_DATE` to
  pick up OSM edits. The filename is stable (`basemap.pmtiles`) so the
  app picks up the new file with no code change — but note tiles are
  served with a 1-year immutable cache header, so to force clients onto
  a fresh file either bump the filename (and `DEFAULT_PMTILES_URL` in
  `src/maps/api/constants.ts`) or purge the Cloudflare cache.
