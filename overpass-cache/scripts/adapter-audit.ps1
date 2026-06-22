# Adapter Audit Sweep — run from PowerShell on your machine.
#
# Probes each keyless regional adapter two ways:
#   1. The worker's /api/travel/plan?debug=1 to see what the live build does.
#   2. The upstream directly, so you can see whether the endpoint itself is
#      alive and what shape it returns (the same method that nailed
#      Switzerland/Denmark/Austria last round).
#
# Paste the output back; from the `result` field + the raw upstream
# status I can pinpoint each adapter that needs a fix.

function Probe-Worker($region, $origin, $dest, $name) {
  Write-Host "`n===== [$region] worker /api/travel/plan?debug=1 ====="
  $body = @{
    origin      = $origin
    destination = @{ lat = $dest.lat; lng = $dest.lng; name = $name }
  } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Method Post -TimeoutSec 25 `
      -Uri "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/api/travel/plan?debug=1" `
      -ContentType "application/json" -Body $body
    # Print only the adapter rows that were SELECTED, plus a one-line
    # summary — keeps the output reviewable for many regions.
    $sel = $r.adapters | Where-Object { $_.selected -eq $true }
    foreach ($a in $sel) {
      $extra = if ($a.result -eq "journey") { " ($($a.durationMin) min, $($a.transfers) transfers)" } else { "" }
      Write-Host ("  {0,-20} key={1,-8} result={2}{3}  {4} ms" -f $a.id, $a.key, $a.result, $extra, $a.ms)
    }
  } catch {
    Write-Host "  worker ERROR: $($_.Exception.Message)"
  }
}

function Probe-Upstream($label, $url, $method = "GET", $body = $null, $headers = @{}) {
  Write-Host "`n----- $label -----"
  Write-Host "  $method $url"
  try {
    $t0 = Get-Date
    $args = @{
      Uri = $url; Method = $method; TimeoutSec = 12
      Headers = $headers; ErrorAction = "Stop"
      # Use Invoke-WebRequest so we can see status code AND a body snippet.
      MaximumRedirection = 0
    }
    if ($body) { $args.Body = $body; $args.ContentType = "application/json" }
    $resp = Invoke-WebRequest @args
    $ms = [int]((Get-Date) - $t0).TotalMilliseconds
    $ct = $resp.Headers["Content-Type"]
    $snippet = $resp.Content.Substring(0, [Math]::Min(220, $resp.Content.Length))
    Write-Host "  HTTP $($resp.StatusCode) in $ms ms ; Content-Type: $ct"
    Write-Host "  body[0..220]: $snippet"
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { "n/a" }
    Write-Host "  HTTP $code  $($_.Exception.Message)"
  }
}

# ─────────────────────── 1. Worker dispatch summary ───────────────────────
# Quick "does it work end-to-end?" check for each keyless region.

Probe-Worker "Oslo (NO)"     @{lat=59.9139;lng=10.7522} @{lat=59.9442;lng=10.7185} "Bygdoy"
Probe-Worker "Tallinn (EE)"  @{lat=59.4370;lng=24.7536} @{lat=59.3933;lng=24.6647} "Estonian Open Air Museum"
Probe-Worker "Dublin (IE)"   @{lat=53.3498;lng=-6.2603} @{lat=53.3477;lng=-6.2520} "Trinity College"
Probe-Worker "London (UK)"   @{lat=51.5074;lng=-0.1278} @{lat=51.5187;lng=-0.1262} "Kings Cross"

# ─────────────────────── 2. Direct upstream probes ───────────────────────
# Confirm each upstream is alive and what shape it returns. If the worker
# reported `result: "null"` above, the upstream output below tells me why.

# Entur GraphQL (POST)
$enturQuery = @{
  query     = 'query($from:Location!,$to:Location!,$dt:DateTime!){trip(from:$from,to:$to,dateTime:$dt,numTripPatterns:1){tripPatterns{duration legs{mode}}}}'
  variables = @{
    from = @{ coordinates = @{ latitude = 59.9139; longitude = 10.7522 } }
    to   = @{ coordinates = @{ latitude = 59.9442; longitude = 10.7185 } }
    dt   = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
  }
} | ConvertTo-Json -Depth 6 -Compress
Probe-Upstream "Entur GraphQL (Oslo)" "https://api.entur.io/journey-planner/v3/graphql" "POST" $enturQuery `
  @{ "ET-Client-Name" = "jetlaghideandseek-audit"; "Accept" = "application/json" }

# Estonia peatus.ee OTP
$now = Get-Date
$d = $now.ToString("yyyy-MM-dd"); $t = $now.ToString("HH:mm:ss")
Probe-Upstream "peatus.ee OTP (Tallinn)" `
  "https://api.peatus.ee/routing/v1/routers/estonia/plan?fromPlace=59.4370,24.7536&toPlace=59.3933,24.6647&date=$d&time=$t&numItineraries=1&mode=TRANSIT,WALK"

# Ireland TFI EFA
$dEfa = $now.ToString("yyyyMMdd"); $tEfa = $now.ToString("HHmm")
$ie = "https://journeyplanner.transportforireland.ie/nta/XSLT_TRIP_REQUEST2?outputFormat=rapidJSON&coordOutputFormat=WGS84%5BDD.ddddd%5D&type_origin=coord&name_origin=-6.2603:53.3498:WGS84%5BDD.ddddd%5D&type_destination=coord&name_destination=-6.2520:53.3477:WGS84%5BDD.ddddd%5D&itdDate=$dEfa&itdTime=$tEfa&itdTripDateTimeDepArr=dep&calcNumberOfTrips=1"
Probe-Upstream "TFI EFA (Dublin)" $ie

# TfL (London) JourneyResults — works keyless at lower rate limit
$dTfl = $now.ToString("yyyyMMdd"); $tTfl = $now.ToString("HHmm")
$tfl = "https://api.tfl.gov.uk/Journey/JourneyResults/51.5074,-0.1278/to/51.5187,-0.1262?date=$dTfl&time=$tTfl&timeIs=Departing"
Probe-Upstream "TfL JourneyResults (London)" $tfl

Write-Host "`n===== DONE =====`n"
