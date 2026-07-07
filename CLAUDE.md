# JetLag Hide and Seek — Seeker's Companion App

## Project overview

This is Kalle's fork of [taibeled/JetLagHideAndSeek](https://github.com/taibeled/JetLagHideAndSeek), a seeker's map-elimination companion for the Jet Lag: The Game board game. The fork's **primary URL is https://hideandseek.game** (a Cloudflare custom domain on the frontend Worker; also reachable at the original `https://jetlaghideandseek.karl-mj-andersson.workers.dev` origin, and `jetlaghideandseek.com` is being brought up as a second custom domain). It's deployed as a Cloudflare **Worker serving static assets** (Workers Builds auto-deploys on push to master, 2–3 min build — see the "Deploy mechanism" section below; NOT Cloudflare Pages, NOT GitHub Actions).

GitHub: **github.com/kmja/JetLagHideAndSeek**

Stack: **Vite SPA + React + React Router + TypeScript + Tailwind + shadcn/ui + Lucide + nanostores**. Maps via **MapLibre GL** (`react-map-gl/maplibre`). Fonts: Poppins + Oxygen.

**Colour tokens (v591 consolidation):** semantic STATE tokens `--success` / `--warning` / `--info` (each with `-foreground`, light+dark pairs, brightened in dark like `--destructive`) live alongside `--destructive` and are registered in `tailwind.config` → use `text-success` / `bg-warning/15` / `border-info/30`. The brand accents `--accent-yellow|orange|red|peach|purple` are registered too now (so `bg-accent-yellow` works — no more `bg-[hsl(var(--accent-*))]`). There is **one brand red**: `--primary` = `--accent-red` = `PLAY_AREA_COLOR` = `.bg-jetlag-red` = `hsl(5 69% 55%)` (the boundary was nudged hue 2→5 to match). Category colours have a single source — `CATEGORIES` in `src/lib/categories.ts` (import it; don't re-hardcode the hexes). Curated multi-colour palettes (`CardTile` tier meter, curse colour list, legacy Leaflet `ICON_COLORS`) are deliberately their own thing.

**Theming (v546):** NOT hardcoded dark anymore. `src/lib/theme.ts` is a three-state preference (`system | light | dark`, persisted `jlhs:theme`, default **system** via `prefers-color-scheme`, live-reacts to OS changes); `installTheme()` (main.tsx) + the no-flash inline script in `index.html` apply `class="light"`/`"dark"` to `<html>`. Tailwind `darkMode: "class"` + shadcn `:root,.light` / `.dark` variable sets resolve from there. **Caveat for per-subtree theming** (e.g. the overlay gallery previewing both modes at once): a Tailwind `dark:` variant matches ANY `.dark` ancestor and can't be undone by a nested `.light`, so components that must theme by their *nearest* wrapper use CSS-variable indirection instead of `dark:` (see `--overlay-card*` / `--cat-label` in `globals.css`).

> The app was **originally Astro + React islands** and migrated to a plain Vite SPA — see the migration note at the top of `vite.config.ts`. Any reference below to `.astro` pages, `client:load`/`client:only` directives, or Leaflet is **historical**; the current entry is `src/main.tsx` → `src/App.tsx` (React Router), the build is `vite build` → static `dist/` served as Cloudflare Worker Static Assets with SPA fallback to `index.html`.

## Six question types

| Category (id) | Color | Icon | Label |
|---|---|---|---|
| matching | `#7d8087` grey | `Equal` | Matching |
| measuring | `#9dc99e` green | `Ruler` | Measuring |
| radius | `#f5a888` peach | `Radar` | **Radar** |
| thermometer | `#f5d268` yellow | `Thermometer` | Thermometer |
| tentacles | `#b09cd5` purple | `BrainCircuit` | Tentacles |
| photo | `#7fbcd6` blue | `Camera` | Photo |

Defined in `src/lib/categories.ts` (keys match schema `id`s). Note the `radius` category's user-facing label is **"Radar"** (rulebook name) — the internal id stays `radius` for save-game compat. One brand color: `bg-jetlag #1F2F3F`.

## ~~Critical: SSR import constraints~~ (obsolete — no SSR anymore)

**Historical.** This whole constraint belonged to the Astro era and **no longer applies.** The app is now a client-only Vite SPA: nothing renders server-side, so there is no `window is not defined` build trap and **no restriction on importing map libraries statically.** Components import `react-map-gl/maplibre` / `maplibre-gl` directly at the top of the file (see `Map.tsx`, `HiderBackgroundMap.tsx`) with no `React.lazy` ceremony required for SSR reasons. (Lazy-loading is still used where it pays off as a *bundle-size* optimization — e.g. `MapPickerDialog` — just not as an SSR workaround.)

The map renderer is **MapLibre GL** via `react-map-gl`, not Leaflet. The old Leaflet renderer and its sibling overlay components were deleted in the migration; overlays are now `Source`/`Layer` pairs inside the map component.

## Z-index ladder

```
MapLibre map tiles         ~100
MapLibre controls          ~400
Left sidebar               1030–1040
Bottom nav                 1040
Sheet overlay              1050
Sheet content              1051
Dialog overlay/content     1050
Lobby drawer (vaul)        1050/1055
AlertDialog overlay        1055
AlertDialog content        1060
```

The **lobby drawer** (`GameLobbyDialog`, a vaul Drawer) sits at content `z-[1055]`. A plain Radix `Dialog` launched from *inside* it (e.g. `RotateHiderDialog`, opened from the lobby's round-end section) defaults to `z-[1050]` and would open BEHIND the lobby — such dialogs pass `className="… z-[1060]" overlayClassName="z-[1060]"` to clear it.

All popups/dialogs/drawers portal to `<body>`. (The `#map-modal-dialog-container-leaflet` id still exists in `SeekerPage.tsx` as a legacy name, but it's just a positioned wrapper now, not a Leaflet stacking context.) If content appears behind the dark overlay, it's a z-index mismatch — check that overlay and content are both set explicitly.

## Portal patterns

All of these use the **default Radix/vaul portal** (→ `document.body`); none pass an explicit `container`. (The old Leaflet `#map-modal-dialog-container-leaflet` stacking-context problem that originally motivated explicit body-portaling is gone — the app isn't Leaflet anymore.)

- **Dialog, AlertDialog, Select**: default Radix `Portal` → body.
- **Sheet**: overlay `z-[1050]`, content `z-[1051]` (raised from shadcn default `z-50`, which was hidden behind the overlay).
- **Drawer (vaul)**: `VaulDrawer.Portal` → body; overlay + content both `z-[1040]`.

If a Sheet, Dialog, or Select isn't visible (dark overlay shows but no content), check z-index on both overlay and content layers.

## Key architecture

### State management (nanostores + localStorage)
All state in `src/lib/context.ts` (question state, map state) and `src/lib/gameSetup.ts` (game session state). Uses `@nanostores/persistent` for localStorage persistence. Pattern:
```ts
export const myStore = persistentAtom<T>("key", defaultValue, {
    encode: JSON.stringify, decode: JSON.parse,
});
```

### Share links
Stateless URL encoding via `src/lib/shareLinks.ts`. Route `/h?q=<encoded>` for hider, `/?a=<encoded>` for seeker. Question `key` field is the stable identifier.

### Geocoding
Photon (https://photon.komoot.io/) for both reverse and forward geocoding in `src/maps/api/geocode.ts`. Module-level cache by 4-decimal coords. **Play-area search ranking (v681):** `rankPlayAreaResults` sorts on TWO keys — **seed membership first** (is the relation one of the bundled top-N biggest cities, from `/api/seed-cities` via `seedCities.ts`'s `seedCityIds` atom — the immediate, non-sparse signal, NOT the fully-cached star), then the existing `scorePlayAreaResult` heuristic (`PLACE_TYPE_SCORE` + area + exact-name + famous-country bonuses) as the tiebreaker/fallback for the long tail the seed doesn't cover. So a same-named major city always outranks a village, and the scoring still disambiguates everything else. The generator (`build-world-cities.mjs`) picks each seed id via a **verbatim port of this same ranking**, so the baked id is the one search returns — one coupling to keep in sync, no override list.

### Trip planning (transit travel times + journeys)
Three distinct server capabilities in the `overpass-cache` worker, all Trafiklab-secret-shielded with the R2 + edge-cache pattern:
- **Reach** (`POST /api/journey/arrivals`, `overpass-cache/src/journey.ts`): anchor + many stops → earliest arrival at each (ResRobot `passlist=0`, keeps only the final timestamp). The seeker's `TravelTimesOverlay.tsx` renders stations reachable before `hidingPeriodEndsAt` as map labels, anchored at `gameStartPosition`. The hider's "which zones can I reach" overlay (M2) is the mirror image — same endpoint, anchored at live GPS.
- **Plan** (`POST /api/travel/plan`, `overpass-cache/src/travel/`): single origin→destination journey **with legs** (lines, transfers, walking segments) for trip-detail cards. An **adapter dispatcher** (`router.ts`) tries region-specific adapters in specificity order. Shipped adapters, in three dispatch tiers:
1. **Free country/region** (mostly disjoint bboxes): `denmark.ts` (Rejseplanen HAFAS, keyless), `trafiklab.ts` (SE ResRobot, keyed), `entur.ts` (NO GraphQL, keyless), `digitransit.ts` (FI GraphQL, keyed), `estonia.ts` (peatus.ee OTP, keyless), `tfl.ts` (London, optional key), `swiss.ts` (CH transport.opendata.ch, keyless), `germany.ts` (DE `v6.db.transport.rest` FPTF, keyless — exports `planViaFptf`), `austria.ts` (ÖBB `v6.oebb.transport.rest`, keyless — reuses `planViaFptf`), `ireland.ts` (TFI/NTA EFA, keyless — reuses NSW `parseEfaTrip`), `barcelona.ts` (TMB OTP, keyed `app_id`/`app_key`), `netherlands.ts` (NS Trips, keyed, rail-centric), `nsw.ts` (Sydney TfNSW EFA, keyed), `korea.ts` (ODsay Seoul/Busan, keyed). Shared helpers: `otp.ts` (`planViaOtp`/`parseOtpPlan` — used by Estonia + Barcelona), `germany.ts:planViaFptf` (Germany + Austria), `nsw.ts:parseEfaTrip` (NSW + Ireland). Where two overlap (DK/SE Øresund, DACH borders) the more-specific is first and `dispatchPlan` falls through on null (the regional HAFAS/OTP instances cover their neighbours too).
2. **Broad fallbacks**: `navitia.ts` (Europe, free key) → `motisSelfHosted.ts` (operator's OWN MOTIS box via `MOTIS_SELF_HOSTED_URL` — license-clean, reuses `transitous:planViaMotis`) → `transitous.ts` (public MOTIS over the **Mobility Database**, free+keyless but ⚠️ **flagged non-commercial** — see its header; kept as backstop, revisit before monetising).
3. `walking.ts` — unconditional haversine×circuity backstop, so a journey is *always* produced.
- **Departures** (`POST /api/journey/departures`, `overpass-cache/src/departures/`, v644): a live stationboard — "what leaves THIS stop next?" — the hider reads to adapt on the fly (tap a zone → `StationTransitCard` → "Next departures" list). Mirrors the Plan dispatcher's **regional-first → MOTIS-fallback** model (`dispatcher.ts`), reusing the trip planner's `canServe` boxes so a stop's board comes from the SAME source that would plan a trip there. Shipped board adapters (a SUBSET of the planner's — not every backend exposes a clean board): `trafiklab.ts` (SE ResRobot `location.nearbystops` → `departureBoard`, keyed), `entur.ts` (NO, keyless GraphQL `nearest` → `estimatedCalls`, one query), `swiss.ts` (CH transport.opendata.ch `/locations` → `/stationboard`, keyless), `germany.ts` (DE DB `transport.rest` FPTF `/locations/nearby` → `/stops/{id}/departures`, keyless; shared `fetchViaFptf`), `austria.ts` (AT ÖBB `transport.rest`, reuses `fetchViaFptf`, defers cleanly if the ÖBB box is down), and `transitous.ts` (MOTIS `reverse-geocode` → `stoptimes`, universal keyless fallback, reused for a self-hosted box). Regions **without** a dedicated board yet (FI/Digitransit, Estonia, London/TfL, Barcelona, NSW, Korea, Netherlands, France) fall through to MOTIS (which covers them via GTFS) — add one `fetchBoard` above MOTIS to give them a native board, exactly like the Plan tier grew one `plan` at a time. Each adapter does a **two-step coord→board** (resolve nearest stop, then fetch its board; Entur fuses both into one GraphQL call). Same R2 + edge-cache pattern but SHORTER TTLs (2-min `when` bucket, 5-min R2, 2-min edge) since departures are time-sensitive. Wire types duplicated per side (`departures/types.ts` ↔ `src/lib/journey/departures.ts`). Parsers fixture-tested in `tests/departures.test.ts` (17 cases; the untestable upstream shapes are modeled from each API's docs and degrade to an empty board on mismatch).

**Cost constraint: every provider is genuinely free** — keyless or free-key-no-billing. Paid/billing-required providers (Google Directions, HERE) were tried and **removed**. Do NOT re-add a provider that needs billing. ⚠️ **navitia.io** appears to have closed its free self-service tier (Hove/Kisio now gate it commercially) — `navitia.ts` is kept (works with a key, defers cleanly without) but new free keys may be unobtainable; **Paris uses `france.ts` (IDFM PRIM)** instead, a separate free marketplace key. **Transitous caveat:** the public instance is non-commercial; if the app is ever monetised — OR to get license-clean global coverage now — run a **self-hosted MOTIS box** and set `MOTIS_SELF_HOSTED_URL` (it's ordered ahead of public Transitous). MOTIS is MIT-licensed; the non-commercial string is only transitous.org's hosted-API policy. Full deployment recipe + cost sizing: **`overpass-cache/SELF_HOSTING_MOTIS.md`** (regional ≈ €7–17/mo Hetzner; planet ≈ €50/mo).

**Coverage reality (updated post-v415 audit):** Transitous's *actual* coverage is far broader than this doc once claimed — its [feeds catalogue](https://github.com/public-transport/transitous/tree/main/feeds) has 131+ regions, including per-state US (NY/CA/IL/WA/OR/FL/TX/NJ/PA/GA), Canada (BC/ON/QC), Japan (575 sources, world-class), Singapore, Hong Kong, every Australian state, and most NZ regions. So the "GTFS-only world" gap is reliably covered by the existing `transitous` adapter; adding more regional adapters there is a *latency* / *commercial-license* win, not a *coverage* win. **The genuine no-free-coord-API holes are narrow:** Taiwan TDX is feeds-only, mainland China is paid-only, Russia/Belarus is regional-only, and several smaller markets (Egypt, Vietnam, Indonesia) publish nothing free.

**Verified-dead in the 2026 audit:** Rejseplanen API 1.0 (`xmlopen.rejseplanen.dk`) shut down 2024-12-04; `denmark.ts` is gated behind a future `REJSEPLANEN_API_KEY` so it defers cleanly to Transitous (which routes Denmark's GTFS feed daily). The ÖBB transport.rest instance (`v6.oebb.transport.rest`) 404s for Austria; `austria.ts` defers immediately rather than burn the 8 s upstream timeout (DB HAFAS doesn't carry Austrian-local data). For `?debug=1` diagnostics + raw upstream probes against every keyless adapter, see `overpass-cache/scripts/adapter-audit.ps1`. The departures endpoint has the same diagnostic mode (post-v662): `POST /api/journey/departures?debug=1` runs every candidate board adapter for the stop and reports selection/key/result/timing per adapter.

**Latest additions (post-v415):** `australia.ts` — La Trobe University's keyless OTP instance covering VIC/QLD/SA/WA/TAS/NT/ACT (ordered after the official `nsw.ts` so Sydney still hits TfNSW first). `hungary.ts` — BKK FUTÁR's OTP for Budapest, gated behind `BKK_FUTAR_KEY` (free signup at opendata.bkk.hu).

**Future-work shortlist (researched, not yet shipped):**
- **Singapore OneMap** — free email/password key → 3-day JWT → OTP-shaped JSON. Coord→coord. Best APAC gap-filler. Needs token-cache infra.
- **Île-de-France PRIM (Paris)** — free key, 20k/day, Navitia-shaped. Can reuse the navitia parser; just adds a separate quota pool for Paris.
- **VAO-Start (Austria)** — official multimodal AT, free with manual email contract + 100/day cap. Heavy onboarding, low quota.
- **Rejseplanen API 2.0 (Denmark)** — free with email-approved key, 50k/month. Worth doing if real-time disruption data matters; otherwise Transitous + the daily Rejseplanen GTFS feed already covers DK.

Skip-list (researched and explicitly NOT worth an adapter): NYC MTA, BART, WMATA, Chicago CTA, Boston MBTA, NJ Transit, all GTFS-only US agencies; TransLink Vancouver, TTC, STM; PTV Victoria, TransLink QLD, Adelaide Metro, Transperth, Auckland Transport, Metlink Wellington; ODPT Japan; LTA DataMall Singapore; HKeMobility Hong Kong; TDX Taiwan; Mappls India; ATAC Roma; Renfe; CP Comboios; STIB-MIVB; De Lijn. All publish GTFS + RT but no hosted journey planner — Transitous covers them via the Mobility Database.

Adding a country = one adapter file + one entry in `ADAPTERS`; dispatcher, cache and client are untouched.

Wire types are duplicated per side (worker `travel/types.ts` ↔ client `src/lib/journey/plan.ts`), NOT shared via `protocol/` — that mirrors how `journey.ts` already works and avoids cross-worker-root bundling. Pure logic (dispatch selection + every adapter's leg parser) is unit-tested in `tests/travelPlan.test.ts` (40 cases). With the free Transitous universal tier, coverage is effectively global wherever the Mobility Database has GTFS feeds (and grows as feeds are added). Transitous IS the "self-hosted GTFS raptor over the Mobility Database" idea (the old deferred M5) — except the community already hosts it for free, so there's nothing to self-host. The **Mobility Database** (mobilitydatabase.org) is the GTFS-feed catalog Transitous routes over.

**Hider hiding-zones overlay** (`HiderReachOverlay.tsx` + `hiderReachFC` shadow atom): the hider's counterpart to the seeker's hiding-zones station field. Uses `fetchAreaStations` (capped at 180 stops; **v661: play-area-keyed, not GPS-keyed** — it rides the seeker's `hidingZoneFiltersFor(allowedTransit)` → `findPlacesInZone` path with the exact ZoneSidebar argument shape, so the Overpass query is **byte-identical to the seeker's** and shares its R2 entry; the old `around:GPS` clauses made every position a unique query → guaranteed cache miss → live-Overpass rate limits even for starred cities, the same one-producer lesson as v640. GPS is only the client-side distance-sort anchor, so there's no re-fetch-on-movement deadband anymore) and paints the results via `HiderBackgroundMap` as name-labeled dots styled **identically to the seeker's `hiding-zones-*` layers** (single brand-red zoom-scaled dot + `Noto Sans` name label + invisible tap-target circle) PLUS a single **`safeUnion`-ed extent fill** (v650) — the union of every candidate zone's hiding-radius circle, painted once at a faint uniform opacity + dashed envelope, matching the seeker's `hiding-zones-fill`/`-line` (the point layers are geometry-filtered so the union polygon only feeds the fill/line). **The union runs OFF the main thread (v652)** in a Web Worker (`src/workers/hidingZonesUnion.worker.ts`, driven by `src/lib/journey/hidingZonesUnion.ts`): unioning hundreds of overlapping circles in a dense metro (Chicago's ~180 bus-stop circles) is a seconds-long `turf.union`, and doing it inline froze the whole app while the overlay loaded (v651 merely *bounded* it — still on-thread). So the union runs in the worker (no app-wide hitch), and the overlay reveals in **ONE update — dots + circles together after a single loading period, never staggered** (v653; the interim v652 painted dots first then dropped the fill in, which read as two loads). The worker builds **smooth 64-step circles + only a gentle `simplify`** (v660, matching the seeker's look — the interim 16-step + heavy simplify made blocky angular arcs) and unions ALL the stations (cap raised to 220, effectively no cap since `fetchAreaStations` maxes at 180); requests are id-tagged + `AbortSignal`-cancelled so a stale result (hider moved / toggled off) is ignored; it degrades to dots-only where Workers aren't available or the union fails. (This is the repo's first Web Worker — Vite bundles it via the `new Worker(new URL(...), {type:"module"})` pattern.) The tapped-zone gets the seeker's **selected-zone highlight** (v660 — `hider-selected-zone-*` layers: white ring + fill + dot from `selectedMapStation` + `hidingRadius`, parity with the seeker map's `selected-zone-*`). Toggle in `HiderMapDisplayControls` ("Hiding zones"). Auto-disables once a zone is committed. **v643: reachability was REMOVED from the overlay** — it used to fan out a per-station `/api/journey/arrivals` call to colour-code reachable-vs-out-of-reach (green/red/amber), but that round-trip made the overlay slow + flaky ("hiding zones don't work well"). Whether a SINGLE tapped zone is reachable before the whistle is now an **on-demand, one-zone-at-a-time check in `StationTransitCard`**: it already plans the trip from live GPS to the tapped station, so it compares `journey.arriveAt` against `hidingPeriodEndsAt` and shows a colour-coded "Reachable in time / Out of reach" banner (with the arrival clock + minutes of slack) whenever the hiding period is still running. The card also shows a **live "Next departures" board** for the tapped stop (v644 — `fetchDepartures` → `/api/journey/departures`), so the hider can adapt on the fly; it's a separate stop-only fetch (independent of GPS). **Card layout (v648, v650):** progressive disclosure — the drawer opens compact (title + reachability banner + any seeker endgame action) and a **"Route & departures" expander** (tap toggle) reveals the full detail: a **Trip | Departures tab switcher** (trip = `JourneyCard`; departures = the board, using the shared `TRANSIT_ICONS` mode glyphs instead of text labels, with an upcoming-count badge on the tab). (A vaul snap-point / drag-to-expand version was tried in v650 but caused a hard UI freeze on some devices, so v651 reverted to the tap toggle; **v666 added a freeze-proof swipe-up gesture** — a plain touch-delta check on the card that expands on a ≥40 px upward flick, no vaul snap points. Down-drag stays vaul's dismiss.) **The card stays open on outside taps (v666)** — `onPointerDownOutside`/`onInteractOutside` preventDefault on the Content, so tapping another zone on the (non-modal) map behind it switches the selection in place instead of Radix dismissing the card. The planned trip is drawn on the map behind the (non-modal) card via the shared `tripRouteFC` overlay (`TripRouteLayers`, mounted on both maps). **`tripRouteFC` writes are ownership-tracked (v666, `useOwnedTripRoute`)** — three components write the atom, and the old unconditional `set(null)` on unmount/null-journey let any of them wipe a route another had just drawn (a "route never shows" bug); each writer now only clears the atom if it still holds its own FC. `journeyToRouteFC` also drops legs with non-finite or (0,0) endpoints so a parser's Null-Island default can't drag the route/fit across the globe. `HiderBackgroundMap` **fits the map to the route with a LIVE bottom inset** (v666): `StationTransitCard` publishes its measured drawer height to `stationCardInsetPx` (ResizeObserver), and the fit re-runs per (route, inset-bucket) with bottom padding = card height (clamped to 75% of the viewport) + the CURRENT GPS folded into the bounds — so the GPS dot + zone stay in the visible strip as the card opens/expands/collapses. A redundant **trailing access-walk leg is trimmed** (`trimTrailingAccessWalk`, v650) when the last transit leg already alights within ~350 m of the tapped station — planners append a "walk to the exact pin" that added fake travel time + a bogus final step. `JourneyCard` leg rows were enlarged (bigger icons + text). (Departure *line geometry* isn't overlaid — the departures API returns line names + times but no route shapes.)

**Hider trip-plan card** (`HiderTripPlanCard.tsx`): rendered inside `HiderHome`'s `hiding`/`grace` branches under the zone picker once `hidingZone` is set — calls `/api/travel/plan` from live GPS to the committed station, renders via the shared `JourneyCard`. **Plan-once + manual Refresh (v620):** both trip planners (hider card + seeker sheet) plan ONCE when a GPS fix first arrives and re-plan only on zone/destination change, mode change, or the `JourneyCard` **Refresh** button (which reads the current GPS via `lastKnownPosition.get()` at plan time). GPS coordinate changes are deliberately excluded from the plan effect's deps/signature (only a `hasGps` boolean drives the initial plan) — the earlier `useStableGpsOrigin` 150 m-threshold approach still re-planned constantly in dense cities where a stationary fix routinely jumps >150 m (urban multipath, reported in a Bucharest game). (`useStableGpsOrigin` was deleted in v662 — recover from git history if the threshold approach is ever wanted back.)

**Seeker trip planner** (`SeekerTripPlannerSheet.tsx`): Vaul drawer, text input → `forwardGeocodeOne` (or `lat,lng` paste) → `JourneyCard` for the journey from live GPS. Open state in `seekerTripPlannerOpen`. **v617: the "Search place" launcher pill was removed** (it sat top-right of the map) — the sheet stays mounted but currently has no in-app entry point; re-add a launcher if trip search is wanted back.

### Subtype picker (matching/measuring/tentacles)
`src/lib/subtypes.ts` defines `SUBTYPES` with `validSizes: GameSize[]` per entry. `-full` suffixed types (e.g. `aquarium-full`) are Small+Medium only — not available in Large games. Use `isSubtypeAllowed(value, size)` to filter dropdowns, `getSubtypes(categoryId, size)` for the step-2 picker tiles. Use `cleanDescription(desc)` to strip `" Question"` and `" (Small+Medium Games)"` suffixes from schema descriptions.

**Reference families + prewarm/cron (v625).** Matching/measuring reference POIs come from a "family" system: `STANDARD_REFERENCE_FAMILIES` (`playAreaPrefetch.ts`) is the canonical list warmed on play-area load, and it MUST stay byte-identical to the worker cron's `REFERENCE_FAMILY_FILTERS` (`overpass-cache/src/index.ts`) — the combined bbox query's hash is the shared R2 key. To add a family: update `FamilyKey`, `STANDARD_REFERENCE_FAMILIES`, `filterForFamily`, `elementMatchesFamily`, `cacheableFamilyForType` (client) AND `REFERENCE_FAMILY_FILTERS` (worker) with the SAME filter string. Two families of note:
- **`rail-station`** (`["railway"="station"]`) backs the three station-property matching types, all **eliminated seeker-side** via one shared helper `matchingStationBoundary` (`matching.ts`, v625–v626): it Voronoi-partitions ALL stations and unions the cells of every station matching the seeker's nearest on the relevant property, so the map cut agrees with the hider's answer. **`same-train-line`** uses `trainLineNodeFinder` (same call the hider grades with); **`same-first-letter-station`** matches the first letter of the `name:en`/`name`; **`same-length-station`** is 3-way (`lengthComparison` equal/shorter/longer) — its boundary encodes the answer so `adjustPerMatching` always KEEPS the region (memo key includes `lengthComparison`). `same-first-letter-station`'s elimination is implemented but it is **not** in the subtype picker (v627) — it isn't a rulebook question (the rulebook only has "Station Name's Length"), and the picker mirrors the rulebook exactly. **Rulebook parity (v627): the app offers exactly the rulebook's questions — no more, no less** (Matching 20, Measuring 20, Radar 9 presets + Choose, Thermometer 1/5/15/75 by size, Photo 6/+8/+4 by size, Tentacles 4/+4 by size).
- **`body-of-water`** (`["natural"="water"]["name"]`) replaced the old Natural Earth 1:50m lakes bundle (v625) — that had ~411 major lakes and no rivers, so it found nothing at city scale. **NOT in the combined prewarm (v632):** `natural=water` matches huge multipolygon geometry (the Seine, canals, thousands of named ponds), so bundling it into the shared combined reference query timed the WHOLE reference set out upstream for dense metros — which broke the Paris cron prewarm and tripped Overpass rate limits on every Paris play-area pick. So `body-of-water` is deliberately **excluded from `STANDARD_REFERENCE_FAMILIES` + `REFERENCE_FAMILY_FILTERS`** and fetched LAZILY in isolation: `prefetchCategory` routes any family not in `STANDARD_FAMILY_SET` through `runSingleFamilyBboxFetch` (its own bbox query), so a heavy water scan can only slow its own on-demand fetch, never the shared prewarm. The isolated fetch holds `natural=water` centroids for the nearest-reference preview; the measuring ELIMINATION (`measuring.ts`) fetches full geometry (`natural=water` areas + named `waterway=river/canal` lines via `out geom`) so the seeker-distance buffer reflects real shore/bank distance. Rulebook p11: "any named body of water … excluding pools" (the `["name"]` filter enforces both).

**Availability gating (v564):** `useSubtypeAvailability` (`src/lib/subtypeAvailability.ts`) greys out subtype tiles whose reference type has too few instances *inside the play area* to make a meaningful question — matching/tentacles need ≥2 (with one, everyone shares it), measuring needs ≥1. It counts via `countInPlayArea(family)` (`playAreaPrefetch.ts`, polygon-filtered cached features) for countable POI families only (airport, rail-station, `api:*` from `LOCATION_FIRST_TAG`); non-countable subtypes (admin divisions/borders, coastline, transit-line/name-length, metro, landmass, photo) and unknown/cold counts always stay enabled, so nothing valid is wrongly hidden. Relatedly, the **nearest-reference** lookup (`NearestReferencePreview.tsx`) filters every Overpass `around:`-radius fallback to the play-area polygon (`pointInPlayArea`) so an out-of-bounds instance can't win over a valid in-area one (rulebook p17).

**Self-hosting fetch paths (v639) — toward zero-Overpass for prewarmed cities.** Three changes closed the wizard/lobby-preview leaks the audit found: (1) **Boundary fetch is worker-first, CACHE-ONLY** — `doFetchRawBoundaryPolygon` (`polygonsOsmFr.ts`) tries the worker's R2 `relation(N);out geom;` (`fetchPolygonViaCacheWorker`, which passes **`?cacheOnly=1`**) BEFORE polygons.osm.fr, so a curated city's primary + neighbour boundaries paint from R2. **`cacheOnly=1` (v640) returns an edge/R2 hit (fresh or stale) or an instant empty `{elements:[]}` MISS — it NEVER goes upstream.** This is load-bearing: without it, worker-first sent every un-prewarmed neighbour's boundary to a LIVE Overpass query (the Madrid wizard fired ~14 `relation(N);out geom;` at overpass-api.de → 504s, and Cloudflare then 500'd the overloaded worker without CORS headers). With `cacheOnly`, an un-prewarmed area misses fast and the client falls to polygons.osm.fr (not Overpass); prewarmed neighbours self-warm only via the cron/laptop, not client traffic. (2) **Neighbour boundaries are prewarmed** — the cron's `prewarmAdjacentSearchForCity` (`overpass-cache/src/index.ts`) reads the topological + admin-band results it just stored, extracts up to `MAX_NEIGHBOUR_BOUNDARIES` (14) admin-boundary relation ids, and prewarms each via `singleRelationQuery` (byte-identical to the client's worker fetch). (3) **Adjacency `around:` centroid is relation-ID-keyed (v640), not client-derived** — the client fetches the ONE canonical extent from `GET /api/relation-extent/<id>` (`RELATION_EXTENT_BASE`; worker `handleRelationExtent` returns the stored `city.extent` via `getPopularCities`, the exact value `prewarmAdjacentSearchForCity`'s queries use, or a live `bboxFromRelation` for uncurated), and both sides take `((maxLat+minLat)/2, (minLng+maxLng)/2)` of that single value. This is the **v359 `/api/refs/<id>` pattern applied to adjacency**: one producer of the coordinate instead of two (client-bbox vs cron-bbox), so the `around:` string matches byte-for-byte with **no rounding** — replacing the earlier v639 3-dp-rounding band-aid (rounding two independently-derived numbers is the same anti-pattern v356/v359 killed for references). The builders in `playAreaExtensions.ts` ↔ `index.ts` are back to raw `${lat},${lng}` and kept byte-identical. **Transition caveat:** the query strings changed (rounded → raw), so existing prewarmed adjacency entries go stale and the cron re-warms under the new keys; until it catches up, adjacency cold-misses and falls through live (silently). **Laptop extent backfill (v640):** adjacency warming (cron *and* laptop) is gated on a city having a stored `city.extent`, which was previously cron-only (`upsertDiscoveredCity`, ~5 relations/tick). `POST /admin/store-city-extent {name, relationId}` (`handleAdminStoreCityExtent`, admin-secret) now derives it server-side via `bboxFromRelation` and upserts it, so `laptop-prewarm.mjs` (`ensureCityExtent`, called at the top of `processCity`) can fully bootstrap a brand-new city — extent → adjacency → references → boundaries → neighbours — in one run with no cron wait. The laptop's adjacency warm now keys off `city.extent` (the canonical value, matching the cron + client) rather than its boundary-geometry extent. **As of v665 the list of position-keyed live Overpass queries is EMPTY** — the last two (the hider map-tap `findNearestStation` fallback and `NearbyStationsPicker`'s 500 m `around:GPS` scan) now resolve against the game's own candidate-zone set via `findZonesNearPoint`/`findZoneAtPoint` (`src/lib/journey/stations.ts`): the shared play-area-keyed station fetch (byte-identical to the seeker's hiding-zones query, one R2 entry per game, in-module memoised + in-flight-coalesced) filtered client-side to the zones whose hiding-radius circle contains the point. Semantics improved too: a station of a disallowed mode or outside the play area is not a legal zone and no longer resolves; the picker header reads "Zones you're in". (Satellite tiles came off the external list in v664 — see the tile-overlays section.)

**Hiding-zone station prewarm (v668) — the last un-prewarmed hiding-zones surface.** The hider's "Hiding zones" overlay + the zone-containment lookups (`findZonesNearPoint`/`findZoneAtPoint`) fetch the candidate STATION field, which is a distinct Overpass query from anything the prewarm warmed: `hidingZoneFiltersFor(allowed)` is a multi-mode union of STOP selectors (`railway=station`, `highway=bus_stop`, `railway=tram_stop`, ferry, …) — NOT the reference-family `rail-station` (`["railway"="station"]`) nor the transit-ROUTE shards. So it only ever cached ON-DEMAND after a first live fetch — and that first fetch is the heaviest possible query (`bus_stop` across a whole metro), which is exactly what soft-timed-out for Chicago. Now it's prewarmed by the SAME relation-ID-keyed pattern as `/api/refs`: **`GET /api/area-stations/<relationId>`** (`handleAreaStationsByRelation`) derives the boundary-geometry extent (`canonicalReferenceExtent`, the identical drift-free extent references use), rebuilds the ONE combined all-mode station bbox query (`buildAreaStationsBboxQuery`, `AREA_STATION_FILTERS`, 2 km pad, `[timeout:180]`), and serves the R2 entry — so the client never builds a byte-fragile query (zero cross-codebase drift). Warmed per-city by the cron (**Phase 2b**, `prewarmAreaStationsForCity`, isolated NOT batched — the bus clause is too heavy to bundle, same lesson as `body-of-water` v632; opt-out `AREA_STATIONS_PREWARM_ENABLED="false"`), the laptop (`areaStationsQuery` in `laptop-prewarm.mjs`, byte-identical to the worker builder), and on-demand via `?warm=1` (`warmRelationAreaStations`, boundary-ensure → derive extent → abort-guarded store). Client: `fetchRawAreaStations` (`stations.ts`) tries the prewarm endpoint FIRST (all modes → filtered client-side to the allowed set), falling back to the live poly `findPlacesInZone` query on miss (and firing `requestStationWarm` so the next load is warm). All warm/prewarm paths refuse to store an abort-remark body (v667). **The SEEKER's `ZoneSidebar` is routed through it too (v669)** — `fetchPrewarmedHidingZoneStations(options)` serves the endpoint when `$displayHidingZonesOptions` map EXACTLY to a whole-mode subset (`modesForExactOptions` — the common auto-tracking case; any partial-mode or custom/non-mode pick declines to the live poly query), returning an Overpass-shaped `{elements}` fed straight to `osmtogeojson`. **Added adjacent areas are first-class on the fast path (v670):** the endpoint is FANNED over EVERY play-area relation id (primary + each added adjacent area — `playAreaRelationIdsAll`, mirroring `playAreaRelationIds().all`) and UNIONed (`fetchPrewarmedStationsUnion`), so an added area is prewarmed/served just like the primary. Each per-relation entry is a 2 km-PADDED bbox superset, so the union is culled to the combined play-area polygon (`cullElementsToPlayArea`, matching the poly query's clipping — no out-of-area stations). The endpoint is used ONLY when EVERY area is warm (miss detected via the endpoint's `cache` marker, distinct from a warmed-but-empty area); any cold area is `?warm=1`-background-warmed and the whole set falls to the live poly query (built from the combined polygon, so it covers the union). The live poly path keeps the v667 all-mirrors-failed detection; the endpoint path can't fail that way (it never touches Overpass). Not-yet-prewarmed added areas rely on the on-demand `?warm=1` (`warmRelationAreaStations` warms any relation id), the same as references.

**Overpass soft-failure ("abort remark") handling (v667).** Overpass soft-fails: on a server-side time/memory limit it returns **HTTP 200** whose JSON carries `remark: "runtime error: Query timed out …"` with `elements` empty or silently truncated. Pre-v667 nothing checked `remark`, so one bad upstream moment got cached as a success — in the worker's R2 (30-day TTL) AND the browser Cache API — and every retry re-served "no stations in Chicago" (the "hiding zones say loaded but the map is empty" bug). Defences, all keyed on the same sniff (remark sits at the END of the JSON, so a cheap tail check gates the full parse): **worker** (`isAbortedOverpassText`, `overpass-cache/src/index.ts`) — the write path (`streamCompressIntoR2`) peeks bodies ≤256 KB and returns an aborted one to the client **uncached** (`Cache-Control: no-store`, `X-Cache: *_UNCACHED_ABORT`); the read path sniffs R2 hits ≤64 KB compressed and **deletes a poisoned entry + treats it as a miss** (self-heal for pre-fix entries; a clean small body is re-served from the decoded text since the sniff consumes the one-shot stream); the cron prewarms (`prewarmRelation`/`prewarmQuery`/HSR) refuse to store an aborted body (`upstream-aborted`). **Client** (`src/maps/api/overpassAbort.ts`, unit-tested in `tests/overpassAbort.test.ts`) — `getOverpassData` sniffs every racer's 200 body INSIDE the mirror race, so an aborted body (poisoned worker entry or live mirror timeout) counts as a per-mirror miss and fails over to the next tier, purging any Cache-API copy; the cache-first short-circuit self-heals the same way. **Consumers** — `fetchRawAreaStations` (`stations.ts`) and the seeker's `ZoneSidebar` compute use the `overpassFailureCount` before/after snapshot to tell a FAILED empty from a genuinely-empty result: failure now **throws** (→ error toast; and the ZoneSidebar signature cache is not recorded, so re-toggling retries), while `HiderReachOverlay` shows a deduped `toast.error` + null FC on failure vs. a `toast.info` + empty FC on a true zero.

**One prewarm list (v680).** The three-source sprawl (hand-curated array + `bulk-cities.json` + name-discovery R2 doc) collapsed into **TWO clean roles**: a static bundled **seed** — `overpass-cache/world-cities.json`, the top-N biggest cities worldwide (`{name, relationId, extent?, population?}`), regenerated by `overpass-cache/scripts/build-world-cities.mjs` (Wikidata population + OSM relation id, Photon-reconciled so ids match in-app search; run it on a machine that can reach Wikidata/Photon — CI egress blocks them) — PLUS the R2 **growth/state doc** (`loadDiscoveredCities`), which now holds only (a) organic player-added areas and (b) per-city curation state (`extent`, `adjacentsCuratedAt`, `fullyCuratedAt`). `getPopularCities = mergeUnique(growth, SEED_CITIES)` (growth first so runtime state/extent wins; `mergeUnique` field-fills missing `extent`/stamps across duplicates, killing the old "extentless seed shadows an extent-bearing dup" bug). **No hand-correction/override layer** (v681): the generator resolves each city through the app's EXACT play-area ranking (a verbatim port of `geocode.ts`'s `rankPlayAreaResults` — MUST stay in sync), so every relation id is the one in-app search returns by construction; fix a wrong city at the source (regenerate), not with a parallel list. The legacy speculative name-discovery cron pass is **OFF by default** (`NAME_DISCOVERY_ENABLED="true"` to re-enable; `/admin/discover` still works manually). **Runtime growth:** when a player picks a play area not already in the set, the client `POST`s `/api/register-area {relationId, name}` (`REGISTER_AREA_URL`, fired from `playAreaPrefetch.ts`'s warm-on-add hook for the primary + every added adjacent); the worker (`handleRegisterArea`, public, guardrailed: idempotent, `bboxFromRelation`-validated, capped at `REGISTER_AREA_MAX_GROWTH`) derives the extent and upserts into the growth doc, so the cron then caches it (+ adjacents) and it eventually earns a star. That's how "the list grows as players use the app."

**Warm-city star (v642, star-meaning tightened v679).** The play-area search (`PlayAreaStep` in `GameSetupDialog.tsx`) stars results that are **fully cached** so users can spot Overpass-free regions (v645: the star also shows on the SELECTED play-area summary card, not just the search-results list). The star is the one prewarm list's truthful "done" subset. **v679: a star means "fully cached, including adjacent areas"** — the worker (`handleWarmCities`) reports only cities the cron has stamped `fullyCuratedAt` (the PRIMARY's boundary+refs+stations AND every adjacent area all present in R2), NOT merely "has a backfilled `extent`" (the pre-v679 meaning). Escape hatch: `WARM_STAR_LENIENT="true"` reverts to the extent-only star (broader, appears sooner, but not a full-cache guarantee) without a code change — intended only if the strict star is too sparse before the cron/laptop backfill catches up. The set is fetched once + cached in the `warmCityIds` atom (`src/maps/api/warmCities.ts`, `ensureWarmCitiesLoaded`/`isWarmCity`); CDN/browser-cached 1 h. The operator's laptop-prewarm `--cold-only` (v641) warms the un-starred tail.

**Adjacent-area full curation + star gate (v676).** A curated city's adjacent municipalities are now curated as first-class play-area members, not just outlined: the cron's Phase-4 `prewarmAdjacentSearchForCity` (`overpass-cache/src/index.ts`) warms each neighbour relation's **boundary + references + hiding-zone stations** (via the existing `warmRelationReferences` + `warmRelationAreaStations`, keyed on the same canonical relation-id keys the client reads via `/api/refs/<id>` and `/api/area-stations/<id>`) — so an "added adjacent area" loads Overpass-free exactly like the primary. Opt-OUT via `ADJACENT_CURATION_ENABLED="false"` (reverts to boundary-only, pre-v676). Once every neighbour is verified fully curated (a read-only `relationFullyCurated` R2-HEAD check on boundary+refs+stations; a no-neighbour city passes vacuously), the caller stamps `adjacentsCuratedAt` on the city's discovered-doc entry (`CityEntry`, `cities.ts`) — written only on state change, cleared on regression. This feeds the star: the Phase-4 caller also verifies the PRIMARY itself (`relationFullyCurated(city.relationId)`) and stamps `fullyCuratedAt` = primary + adjacents all cached (v679). `handleWarmCities` reports a city as warm (starred) only once `fullyCuratedAt` is stamped — the star means "fully cached, including adjacent areas". This is STRICT BY DEFAULT (the old v676 `WARM_REQUIRE_ADJACENTS` opt-in flag was replaced by the `WARM_STAR_LENIENT="true"` opt-OUT, which reverts to the extent-only star). Note the consequence: right after the v679 deploy the star is sparse (only cities the cron has re-stamped under the new rule) and re-populates as the cron/laptop fully-caches each city. The laptop-prewarm's one-ring pass already fully curates neighbours offline, so the cron's verification passes fast for laptop-warmed cities. The neighbour set is derived ONCE by a shared read-only `deriveAdjacentNeighbourIds` (v677 — reads the cached topological+admin-band results) so the cron gate and the status readout below can't drift. **Progress readout: `GET /admin/adjacent-curation-status?secret=…&scope=seed|all|top&top=N&limit=M`** (v677, extended v679/v680; `scope=seed` = the top-N biggest seed cities) runs the exact server-side `relationFullyCurated` check (real boundary/refs/stations R2 keys — immune to the metadata-attribution gaps in `/admin/prewarmed-cities`) per curated city, on BOTH the primary and every adjacent, and reports `{scope, starMeaning, targets, probed, fullyCached, stampedFully, adjacencyUnknown, cities:[{name, relationId, hasExtent, primaryCached, adjacencyKnown, neighboursTotal, neighboursCurated, adjacentsCurated, fullyCached, stampedAdjacents, stampedFully}]}`. `fullyCached` (live) = `primaryCached && adjacentsCurated` — exactly the star gate; `stampedFully` = the `fullyCuratedAt` stamp actually written. `limit` caps the probe (default 60, max 200) to bound R2-op cost. **This is the authoritative "how many cities are star-eligible under the gate" number** — `/admin/prewarmed-cities` under-reports because `batched` references and on-demand (`warmRelation*`) warms carry no `sourceName` (they surface as `name:null` rows) and aren't attributed to their city.

### Game setup state (src/lib/gameSetup.ts)
- `setupCompleted` — drives first-load wizard auto-open
- `playArea` — `{ displayName, lat, lng }` for chosen play region
- `allowedTransit: TransitMode[]` — `"bus"|"tram"|"train"|"subway"|"ferry"` (walking implicit, always on)
- `gameSize: "small"|"medium"|"large"` — maps to hiding period 30/60/180 min
- `hidingPeriodEndsAt: number|null` — Unix ms, persisted so reload survives
- `satelliteView`, `showTransitLines` — boolean toggles for map overlays
- `setupDialogOpen` — volatile, not persisted

### Map tile overlays (Map.tsx)
Two conditional overlays on top of base tile layer:
- **Satellite**: Esri World Imagery, **proxied + R2-cached via the worker** (`SAT_TILE_BASE = ${JLHS_WORKER_BASE}/api/sattile/{z}/{y}/{x}`, v664 — note Esri's y-before-x order; was a direct `server.arcgisonline.com` hit, the last unproxied external map dependency). Free, no API key; 90-day R2 TTL, stale-if-upstream-down. One shared `SATELLITE_SOURCE` in `src/lib/mapStyle.ts` + the two inline copies (HiderBackgroundMap, InlineLocationPicker) all point at the proxy
- **Transit lines**: OpenRailwayMap, **proxied + R2-cached via the worker** (`RAIL_TILE_BASE = ${JLHS_WORKER_BASE}/api/railtile`, v351 — not the direct `tiles.openrailwaymap.org` host) — semi-transparent, best in Europe

### Thermometer question lifecycle
The schema (`src/maps/schema.ts`) has four extra fields on thermometer:
- `status: "started"|"finished"` (optional, defaults `"finished"` for backward compat)
- `distance: string` (preset signature like `"500m"`, stamped on finish)
- `startedAt: number` (Unix ms timestamp)
- `targetSig: string` (v339 — the target-distance preset the seeker picks **up front**; drives a single-target progress UI; usually equals `distance` at finish)

Flow (v339+): Tapping thermometer in AddQuestionDialog opens **`ThermometerConfigureDialog`** — the seeker picks a target distance and confirms Start, which creates the question with `status:"started"`, `targetSig` set, `latA/lngA` = **the seeker's live GPS at Start** (NOT the map centre — rulebook p31), `latB/lngB` mirror. The card/overlay show live GPS distance vs. the target. **The tracked distance is the straight-line displacement from the start point (`distance(A, currentGPS)`), NOT cumulative path length** — you can't lap the block to satisfy it. Uniqueness: each preset (`500m/1km/2km/5km/10km`) can only be finished once per game. `ThermometerOverlay` (mounted in `SeekerPage`) renders the in-progress tracker while a thermometer is `started` — v606 rebuilt it on the shared `QuestionOverlayCard` chrome (solid category icon block + big live-distance label + Target readout) with the progress bar + "End thermometer & send question" attached beneath. v607 moved it to the **top-of-map** overlay slot (matching the pending-answer card; it sets `pendingOverlayActive` so the top-right controls dodge — safe because a `started` thermometer is excluded from `PendingAnswerOverlay`, so the two never share the slot). **Finishing is the real "send"** (`endThermometer` in the overlay, and the card's `onFinish`): it stamps `createdAt` (starting the hider's answer window) AND `seekerResendQuestion`s the finished question — without this the hider never received the finished thermometer to answer and the seeker's `PendingAnswerOverlay` stayed stuck in the "not sent" state (the v606 bug fix). A `started` thermometer is excluded from `PendingAnswerOverlay` (the bottom tracker owns that phase); once `finished` it flows through the normal pending→answered overlay like every other type.

## Layout: SeekerPage.tsx

The seeker route is a React component (`src/pages/SeekerPage.tsx`), gated on `hidingPeriodEndsAt` (pre-game = lobby only; in-game = full shell). No `client:*` directives — it's a plain SPA tree. Hider route is the sibling `src/pages/HiderPage.tsx`. Approx in-game tree:

```tsx
<SidebarProviderL>
  <SidebarProviderR defaultOpen={false}>
    <QuestionSidebar />
    <main>
      <div> {/* map container */}
        <SidebarTriggerL />                  {/* top-left, desktop only */}
        <MapDisplayControls />               {/* bottom-left (v616); pushed up above HiderTimer during hiding */}
        <HiderTimer />                       {/* bottom-left (hiding) / bottom-right (seeking), raised off the bottom so the basemap attribution stays visible */}
        <PendingAnswerOverlay />             {/* TOP-center: the show-style pending-answer card (v559) */}
        <ThermometerOverlay /> <TravelTimesOverlay />
        <Map />                              {/* MapLibre via react-map-gl */}
      </div>
    </main>
    <ZoneSidebar />
    <BottomNav />
    <SeekerTripPlannerSheet /> <GameSetupDialog /> ...
  </SidebarProviderR>
</SidebarProviderL>
```

## Bottom nav (mobile only)

`BottomNav.tsx` — four slots (v629): **Questions** (`List`) | **New question** (`Plus`, primary CTA) | **Map** (`Map` icon) | **Lobby** (`Users`, rightmost).

- Questions → opens QuestionSidebar (left drawer); badge = questions added.
- New question → opens AddQuestionDialog; disabled while `hiding`, a previous question is still unanswered, OR a curse fully blocks asking.
- Map → opens the `MapOptionsDrawer` via `mapOptionsDrawerOpen` (roomy basemap/overlays/transit toggles); badge = active-overlay count. Replaces the floating bottom-left Map-options chip on mobile (the chip stays on desktop, which has no bottom nav).
- Lobby → opens `GameLobbyDialog` via `lobbyManualOpen`; badge = online participant count. (Moved to the header in v623, back in the nav in v628, swapped rightmost with Map in v629.)

**Settings lives in the app header** (`SeekerTopBar`): left cluster = debug launcher; right cluster = **Settings** (`Settings`, `moreSheetOpen` → `AppSettingsDrawer`) + Notifications. `GameLobbyDialog` is mounted in `SeekerPage`; `AppSettingsDrawer` + `MapOptionsDrawer` are mounted in `BottomNav`. The hiding-period countdown is **not** in the nav — it lives on the map's `HiderTimer` card.

**Hider nav parity (v632):** `HiderBottomNav.tsx` mirrors the seeker layout — four slots **Questions** (`List`, inbox badge) | **Zone** (`Tent`, the hider's primary action → `HiderHomeContent` drawer) | **Map** (`Map` icon → `HiderMapOptionsDrawer`, active-overlay badge) | **Lobby** (`Users`, rightmost). **Settings moved to the `HiderTopBar`** right cluster (`moreSheetOpen`, same `AppSettingsDrawer`), matching `SeekerTopBar`'s `[debug] — wordmark — [Settings · Notifications]`. The hider's map options (`HiderMapDisplayControls.tsx`, now exporting the shared `HiderMapOptionsPanel` + `HiderMapOptionsDrawer` + `useHiderMapOptionsActiveCount`) are a trimmed set — Basemap, **Hiding zones** (v643; was "Reachable zones"), transit overlays (no Travel-times/Export, which would leak seeker deduction shape). The old floating top-right `Layers` popover on `HiderBackgroundMap` was **removed** — the hider nav shows on every viewport, so the nav "Map" slot is the single entry point (no desktop-chip split like the seeker). Both surfaces reuse the shared `mapOptionsDrawerOpen` atom (seeker + hider views never coexist).

**Hider map timer + Zone-drawer declutter (v633):** the hider's phase/countdown moved OFF the old `HiderTimeHeader` flow-row (deleted) onto a **floating `HiderMapTimer` card** on `HiderBackgroundMap`, matching the seeker's `HiderTimer` visual + layout exactly — golden "HIDING TIME REMAINING" box bottom-LEFT while hiding, white "HIDDEN FOR" box + red accent + gold "time to beat" row bottom-RIGHT while seeking (endgame swaps the eyebrow/accent to yellow; grace = red pulse box; forfeit/pre-game variants). It self-positions and the hider's `MapNavControls` dodge to the OPPOSITE corner (a one-shot `setTimeout` on `hidingPeriodEndsAt` in `HiderBackgroundMap` flips `seekingStarted`, no per-second tick). The hider-only **"Mark spot"** popover (inside-committed-zone gate) moved onto the card, stacked above it. The **Zone drawer** (`HiderHomeContent`) is now stage-gated to only what the hider needs: **hiding** = timer + one-line rule + allowed modes + zone picker (the trip-plan card + scouted-spots notebook were dropped from this stage); **seeking** = zone info + **seekers' ETA card** + scouted spots (the elapsed banner, live seeker positions, question log, hand panel, and dice were removed — they live on the map / the "Questions" nav drawer / the hand fan); the spot-lockdown section surfaces only once the seekers claim the endgame (`endgameStartedAt !== null`); **endgame** = locked-spot map + scouted spots. Zone-drawer subheader updated to match. `SeekerETACard` (v634) now renders a quiet "waiting for a seeker to share their location…" placeholder instead of `null` when there's a committed zone but no fresh seeker broadcast, so the ETA slot is visible during seeking rather than silently absent (it fills in live once a seeker shares GPS).

**Hider follow-ups (v635):** (1) The on-map `HiderMapTimer` hiding box now carries an **"End hiding · Start seeking"** button, shown only once a zone is committed (`hidingZone !== null`) — same gate applied to the drawer's copy of that button. (2) **Seeker-proximity notifications:** `SeekerProximityWatcher.tsx` (always mounted on `HiderPage` during seeking) owns the seeker→zone arrivals fetch, publishes to the new `seekerEta` atom (`journey/state.ts`), and fires an OS `notify()` when the seekers cross into a **closer colour band** (comfortable → heads-up → imminent → arrived; monotonic-max rank so each threshold alerts once per round, no boundary spam; plain `setInterval` so it fires while backgrounded). `SeekerETACard` is now a pure renderer of `seekerEta` (no own fetch). (3) **Hider-map parity:** added the `AttributionControl` (top-left, was missing entirely — also a license requirement) and made the reach-overlay labels basemap-brightness-aware (dark text on the light base), matching the seeker map's v616/v622 treatment. The question overlay was already the shared `QuestionOverlayCard`; the elimination flash stays **seeker-only** (the hider must not see the seeker's deduction shape). (4) The hider's **"Reachable zones"** overlay was renamed **"Hiding zones"** and colour-coded green/red/amber by reachability. **(Superseded in v643** — the per-station arrivals fan-out was slow, so the overlay reverted to a plain seeker-style station field and reachability moved on-demand into `StationTransitCard`; see the "Hider hiding-zones overlay" section above.)

## Map display controls (bottom-nav "Map" on mobile / bottom-left chip on desktop, v622)

`MapDisplayControls.tsx` exports one shared **`MapOptionsPanel`** (`roomy` prop for bigger touch targets) rendered on two surfaces:
- **Mobile** — the bottom-nav **"Map"** slot opens **`MapOptionsDrawer`** (a vaul bottom sheet, `mapOptionsDrawerOpen` atom) with the roomy panel.
- **Desktop** — the floating **"Map options" chip** (`Layers`, `h-14/w-14`, active-count badge) opens a `Popover` (`side="top" align="start"`) with the compact panel. `SeekerPage` wraps it `hidden md:block` (mobile uses the nav).

Panel sections: **Basemap** (Map/Satellite), **Overlays** (Hiding zones + Travel times), **Export** (Save image), **Transit overlays** (per-mode rail/subway/bus/ferry/train/tram, gated on `allowedTransit`). The active-overlay count comes from the exported `useMapOptionsActiveCount()` hook (used by both the desktop chip badge and the nav "Map" badge).

**Loading affordances (v654):** every async map overlay surfaces its load in TWO places — a `Loader2` spinner on its map-options toggle button AND a small "Loading …" pill at the top of the map (`MapOverlayLoadingToasts`, mounted on both the seeker `Map` and hider `HiderBackgroundMap`). Per-overlay loading flags: seeker hiding zones = `isLoading` (`context.ts`, `ZoneSidebar`, gated on `displayHidingZones` for the toaster since its compute isn't abortable), hider hiding zones = `hiderReachLoading`, travel times = `travelTimesLoading` (both `journey/state.ts`), transit lines = `transitRoutesLoading` (per-mode, `gameSetup.ts`). The toaster reads them all and shows one pill per active overlay; the two hiding-zones producers (seeker/hider) both map to "Loading hiding zones…" and only one is ever live (one map mounted at a time). Basemap/satellite tile loads aren't tracked (effectively instant toggles).

**Positions (v622):** the desktop chip sits `bottom-3` while seeking and is **pushed UP to `bottom-28`** during the hiding period so it clears the `HiderTimer` (bottom-LEFT during hiding, bottom-RIGHT while seeking). `inHidingPeriod` is computed in both `SeekerPage` and `Map.tsx` via a one-shot `setTimeout` on `hidingPeriodEndsAt` (no per-second tick). `MapNavControls` (follow-me + reset) sits `left-3 bottom-2` on mobile (nothing below it now) / `md:bottom-[76px]` on desktop (rides above the chip), dodging to `right-3` during hiding. The old `ScaleControl` ruler was removed in v616. **Margins trimmed (v622):** the corner clusters (curse pills top-right, `HiderTimer` + nav controls bottom) dropped their old raised offsets — those cleared the bottom-right basemap attribution, which moved to **top-left** in v616, leaving dead vertical space.

**Map label contrast (v622):** station-name (`hiding-zones-labels`) + arrival-time (`travel-times-labels`) text follows the BASEMAP brightness, not the UI theme — white-on-dark over satellite / dark Protomaps, but **dark text + light halo on the light basemap** (`darkBasemap = $satellite || $theme === "dark"` in `Map.tsx`), since white washed out on light tiles.

**Attribution (v616):** the MapLibre `AttributionControl` moved to **`position="top-left"`** (out of the way of the bottom controls). In **dark mode** the default bright-white attribution pill + "i" toggle are re-skinned to a translucent dark chip with muted text (`.dark .maplibregl-ctrl-attrib*` rules in `globals.css`; the collapsed toggle uses `filter: invert(1)`). License-clean: OSM's "© OpenStreetMap contributors" and Protomaps' "Protomaps © OpenStreetMap" credits only require presence + legibility, not a colour.

**Hiding-zones toggle caching (v630):** the `ZoneSidebar` compute effect (Overpass fetch → per-station circles → remaining-area filter → per-question station filters) now records a signature of its inputs (`$displayHidingZonesOptions`, radius+units, custom-stations config, `mergeDuplicates`, planning mode, a compact per-question key, and the `questionFinishedMapData` reference). Toggling the overlay OFF then ON with nothing changed **skips the whole pipeline** — `trainStations` still holds the circles, so the render effect repaints instantly. Only a real input change busts the cache and recomputes.

**Travel-times overlay (v630):** it labels the *hiding-zone* stations, so it needs the Hiding-zones overlay on — enabling **Travel times** now also enables **Hiding zones** (`MapOptionsPanel`). It still requires `gameStartPosition` (GPS at game start) + an active journey provider; those failure cases used to `travelTimesFC.set(null)` silently ("does nothing") and now surface a deduped toast explaining why (`TravelTimesOverlay.tsx`).

(The hider's sibling `HiderMapDisplayControls` is a trimmed version of the same popover + a "Hiding zones" toggle; see the Trip-planning section.)

**Hiding-zone overlay rendering** (`ZoneSidebar.tsx` → `hidingZonesGeoJSON` atom → `Map.tsx` `hiding-zones-*` layers; **the heavy geometry runs in the seeker-zones Web Worker since v663** — `src/lib/zonePipeline.ts` holds the pure pipeline (`prepareZoneCircles` = 512-step circles + remaining-area simplify/union + per-circle intersect cull; `styleZoneStations` = the per-style unions, moved verbatim from the old in-file `styleStations`), `src/workers/seekerZones.worker.ts` wraps it, and `src/lib/seekerZones.ts` is the manager that falls back to a main-thread call where Workers are unavailable; the render effect styles asynchronously with a cancellation guard. Unit-tested in `tests/zonePipeline.test.ts`. The cheap "zones"/"no-display" styles skip the worker round-trip): in the default **stations** style the overlay ships the centre POINTS (dots `hiding-zones-points` + name labels `hiding-zones-labels`, a symbol layer reading `name`, `minzoom 11`, overlap-culled, font MUST be a glyph-proxy fontstack = `Noto Sans Regular`) PLUS a single **`safeUnion`-ed** extent polygon (faint `hiding-zones-fill` + envelope `hiding-zones-line`) — unioning avoids the opacity COMPOUNDING that turned 4+ overlapping per-circle fills into an opaque wash. The **zones** style keeps individual circles (per-zone fill/outline). The tapped/selected zone gets a prominent gold highlight (`selected-zone-*` layers: ring + fill + dot, drawn from `selectedMapStation` + `hidingRadius`). Tapping a station opens `StationTransitCard`, which shows its aggregated **transit modes** (subway/tram/train/bus/ferry — inferred per merged OSM node by `inferStationMode` and unioned into `properties.modes`, threaded via `selectedMapStation.modes`). On the **seeker** surface (`allowEndgame` prop, passed only by `SeekerPage`) the card also offers a **"Start endgame here"** action once the hiding period is over and before the endgame is armed/the hider is found — the natural place to declare the seekers have entered the hider's zone (rulebook p43: the endgame begins when seekers reach the zone and are off transit). It calls the same `seekerStartEndgame()` as the `HiderTimer` button. Station de-duplication (`mergeDuplicateStation`, `stationManipulations.ts`, default-on via `mergeDuplicates` — persisted under key `mergeDuplicateStations`; the old `removeDuplicates` key was abandoned because long-time browsers had it stuck `false`) is union-find clustering keyed ONLY on a NORMALISED name (diacritics/brackets/mode-&-direction words stripped, so "Schous plass [Trikk]" ≡ "Schous plass") + nearness (`max(hidingRadius, 800 m)`, so a hub's spread-out same-named nodes like Oslo's Nationaltheatret still collapse). It is deliberately NOT proximity-alone: two differently-named stations that sit close (a train station and a separate bus stop) stay distinct so neither is hidden from selection.

## Endgame trigger (seeker claim → hider confirm/refute, v618–v619)

Per rulebook p43 the endgame begins when the seekers are physically inside the hider's **actual** zone and off transit; the hider then locks to a final hiding spot and can't move. The tabletop rules leave the signalling implicit (co-located players just talk), so the app models it as an explicit **claim → response** handshake — because seekers might go to the **wrong** station, and a remote seeker shouldn't be left guessing what the hider's silence means. Two timestamps in `SetupState` drive it: `endgameStartedAt` (seeker's claim) and `endgameConfirmedAt` (hider's positive confirmation). Both are persistent atoms (`gameSetup.ts`) + ride the welcome snapshot for late joiners; both reset per round (`roundActions` `startNewRound`/`startNewGame`, the worker's round-rotate, and `store.ts` `applyRoundStarted`).

- **Seeker declares** via `seekerStartEndgame()` (`multiplayer/store.ts`) — from the `StationTransitCard` "Start endgame here" action (`allowEndgame`, seeker surface only; tap a zone on the map). v624 removed the separate `HiderTimer` "Trigger endgame" button — the endgame is triggered from the map zone now; once armed, `HiderTimer` shows the "Awaiting hider" / "In the zone" badge + "Mark hider found". Stamps `endgameStartedAt` (and clears `endgameConfirmedAt`), sends `{t:"startEndgame", at}`. Server (`GameRoom.handleStartEndgame`) idempotently stamps it, broadcasts `setupChanged`, **and Web-Pushes the offline hide team** (`pushEndgameToOfflineHideTeam` → the shared `pushToOfflineHideTeam`, mirrors the curse push) so a backgrounded hider on a train still gets the signal. (**New questions push to the offline hide team the same way** — `handleAddQuestion`, added post-v662; a `status:"started"` thermometer doesn't push until its started→finished re-add, and a network-blip re-add never re-pushes. See MULTIPLAYER.md.) While claimed-but-unconfirmed the seeker's `HiderTimer` badge shows **"Awaiting hider"** (yellow).
- **Hider confirms** via `hiderConfirmEndgame()` → `{t:"confirmEndgame"}` (hide-team only; requires an active claim). Server stamps `endgameConfirmedAt`; the seeker client (`setupChanged` handler, null→number) notifies "you're in the right zone — find them" and the `HiderTimer` badge flips to **green "In the zone"**.
- **Hider refutes** a wrong claim via `hiderCancelEndgame()` → `{t:"cancelEndgame"}`. Server resets both stamps + re-broadcasts; the seeker client detects the `endgameStartedAt` number→null mid-round transition (gated on `hidingPeriodEndsAt !== null` so new-round resets don't trip it) and notifies "the hider says you haven't reached their zone yet."
- The `HiderHome` endgame banner shows both **"They're here — lock down"** (confirm) and **"They're not in my zone"** (refute) while unconfirmed (each behind an `appConfirm`); once confirmed it switches to a static "locked down" state and the hider commits a final spot via the existing `commitSpot` flow (phase flips to `endgame` once `hidingSpot` is set). Move powerup stays blocked while `endgameStartedAt !== null` (`roundActions.playMovePowerup`). Demo mode handles all three messages in `demoBroker.ts`.

## End-of-round dialog (v631)

`EndOfRoundDialog.tsx` is the celebratory round-end moment, auto-opened on BOTH roles the instant the round ends. Driven by the volatile `endOfRoundDialogOpen` atom (`gameSetup.ts`), set at the two source points — the seeker's `HiderTimer.handleMarkFound` and the hider's inbound `ended` handler (`multiplayer/store.ts`) — and cleared by `roundActions` (`startNewRound`/`startNewGame`). Atom-driven (not an internal watcher) so it can stay lazy-loaded without racing the transition. Content: a confetti burst (reuses the `jlConfettiPop` keyframe + the `CastCurseDialog` piece pattern), the round's hidden time (same scoring formula as `RoundEndSection`), a **leaderboard** recap (past `roundLog` rounds + the just-finished round computed live, ranked by time hidden) shown only once >1 round exists, and three actions: **New round** (opens `RotateHiderDialog` in multiplayer with ≥2 players, else confirm → `startNewRound`), **Settings** (`setupDialogOpen`), **Leave** (`returnToLandingPage`), plus a "Dismiss — stay on the map". Mounted lazily in both `SeekerPage` + `HiderPage` in-game trees. The older lobby `RoundEndSection` (`FoundSummary`) + hider `FinalScoreBanner` stay as the persistent re-openable surfaces.

## AddQuestionDialog flow

Steps 1–2 (the pickers) are **vaul Drawers** (bottom sheets, `shouldScaleBackground={false}`, from `ui/drawer`); step 3 (configure) is a centered **Dialog** (v405 — reverted from a drawer because the configure step often embeds a map/popovers that fight a drawer's drag-to-dismiss). Dialogs themselves were restyled `rounded-2xl` (all breakpoints) in v405 to match the drawers/toasts' soft corners.

1. Pick category (CategoryTile grid) — **drawer 1**
   - **Radar (radius)** → opens configure **dialog** (preset buttons + Other popover)
   - **Thermometer** → opens `ThermometerConfigureDialog` (target-distance picker + Start confirm; v339)
   - **Matching/Measuring/Tentacles** → opens subtype picker (drawer 2)
2. Subtype picker (**drawer 2**) — header + scrollable flex-col body, dark sidebar background, "back to categories" button
3. Configure **dialog** (pending question from `promoteLastQuestion`) — header / scroll body / footer (Cancel + Send), centered Dialog

Thermometer is blocked if any other thermometer is already `status:"started"`.

**Configure-dialog cleanup (v611):** the matching/measuring configure cards no longer render the subtype **dropdown** (it's already chosen in the picker step + named in the header/reference box) nor measuring's "Reference didn't load? Set it on the map manually." fallback. The shared map picker (`LatLngPicker` → `InlineLocationPicker`) dropped the "LOCATION — near X" reverse-geocoded header. The closer/further (and same/different) **impact overlay** is now computed against the post-elimination **remaining** area (`questionImpact.ts` reads `questionFinishedMapData`, not the full play area) so it doesn't spill into already-ruled-out regions, and its pattern fills were lightened (≈0.4/0.55) with a crisp boundary line so the basemap stays readable. **Unified loading (`AddQuestionDialog`):** for picker-using types the whole configure body is held under ONE skeleton (content mounts underneath at `opacity-0` so the picker can load) until `pickerReady` flips via `ConfigureDialogContext`, then it reveals at once; a 6 s timeout backstop reveals anyway so a GPS-denied dialog (manual place-search lives under the veil) never deadlocks.

## Preset pattern (radius + thermometer)

```ts
const PRIMARY_PRESETS = [
    { label: "500m", radius: 500, unit: "meters", sig: "500m" },
    { label: "1km", radius: 1, unit: "kilometers", sig: "1km" },
    { label: "2km", ... },
    { label: "5km", ... },
    { label: "10km", radius: 10, unit: "kilometers", sig: "10km" },
];
```

Always render in `grid grid-cols-5` (not flex-wrap) so all 5 fit one row. Used sigs (e.g. already-asked radius questions) are disabled. Currently-selected sig stays enabled for re-selection.

## Map-based location picker (InlineLocationPicker)

A lazily-loaded (`React.lazy` in `LatLngPicker`) **MapLibre** inline map embedded in the configure dialog (the old standalone `MapPickerDialog.tsx` was deleted). Tap to place pin, "Use my GPS" button, "Set location" confirms. Uses the same base tiles as the main map (OSM raster / Protomaps vector — NOT cartocdn, which was dropped in v225 as adblocker-blocked). The lazy load is now purely a bundle-size optimization, not an SSR workaround.

## Card base (cards/base.tsx)

Expand/collapse uses the **grid-rows `0fr`→`1fr` trick** (`duration-300`,
animates to the real content height — smoother than the old max-h guess);
the body stays mounted through the close transition then unmounts
(`bodyMounted`) so a collapsed card holds no live MapLibre instance.

**Collapsed look (v585):** every question card's collapsed header IS the
shared `QuestionOverlayCard` chrome — the same Jet-Lag-show lower-third
the pending-answer / hider-unanswered overlays use (solid category-colour
square icon block on the left, big bold uppercase `summarizeQuestion`
label in the deepened category colour, live status on the right). The
detail line under the label shows the overlay's generic prompt while a
question is awaiting/draft, then swaps to the hider's **resolved answer**
once answered ("Inside the radius", "Hider is closer", "Warmer after the
move", "Nearest: …", …) via `answeredDetail()` in `cards/base.tsx`. The
card adopts the on-map overlay's treatment (v588): **sharp corners, a
subtle NEUTRAL `border-sidebar-border` outline (not category-tinted), a
`shadow-lg` lift, and a `bg-sidebar-accent` surface only a hair above the
drawer background** — so the shadow/border separate it, not a contrasting
block. The card owns no margin; the list (`QuestionSidebar`'s
`SidebarContent`, `px-6 pt-4 gap-5`) insets it so its left edge lines up
with the header and spaces the rows. The status is an **eyebrow line
INSIDE the card** above the big label (v593): a question only reaches the
list once answered in most cases, so for answered cards it's just the
relative time (`10m ago`, muted); in-flight states show the answer
countdown / `Not sent` / `Vetoed` etc. in their colour. The card's right
slot is just a **big `ChevronDown`** (rotates on expand) — no small left
chevron. The `QuestionOverlayCard` content has roomy `px-5` horizontal
padding (v593). The vaul drawer handles are `bg-foreground/25` (visible in
both themes; the old `bg-muted` was near-invisible in light mode). **No
delete/trash button at all** — sent questions are
never deletable (it would desync the hider); discarding an
un-sent draft is the configure dialog's Cancel button's job.
`forceExpanded` (the configure dialog) renders the header static (no
chevron, no collapse).

**Expanded look (v585):** below the header, a static non-interactive
`QuestionOutcomeMap` (`QuestionOutcomeMap.tsx`) highlights that one
question's **resulting area** — it reuses the main map's elimination
engine (`applyQuestionsToMapGeoData` against a clone of the play-area
boundary for an answered question; `determinePlanningPolygon` footprint
for a still-draft one), so the highlight matches the big map exactly.
Marking is **consistent across every type and matches the big map**: the
play-area boundary is the canonical red `PLAY_AREA_COLOR` stroke (same as
every other map), and the resulting area is shown by DIMMING everything
outside it (`holedMask`, the main map's elimination-mask language) AND a
translucent **white fill INSIDE** it + a white edge — the inside-brighten
is what makes the kept area legible on dark near-black tiles (dimming
alone is invisible there); no per-category fill colour. The base tiles
come from the **shared `buildStyle`** (`src/lib/mapStyle.ts`, extracted
from `Map.tsx`) so the preview's basemap matches the main map EXACTLY —
same light/dark Protomaps flavor, Thunderforest layer, and crucially the
**satellite overlay** (v609: without this the preview was a much darker
bare-Protomaps view than the satellite-brightened main map in dark mode).
The static view is
**snapshotted to a PNG** (`canvas.toDataURL`, needs `preserveDrawingBuffer`)
and cached per theme+question+framing, so RE-expanding a card shows a cheap
`<img>` with no MapLibre instance; the first render also **defers the
MapLibre mount ~350 ms** so the card's expand animation stays smooth
instead of fighting GL init. The map starts already framed on the play
area (bbox-derived initial zoom) so there's no fit-jump on first paint,
and it's `pointer-events-none` (so it never steals drawer scroll) and
shows an **`animate-pulse` skeleton** until both the geometry is computed
and the tiles paint.
Mounted only while expanded (so collapsed cards aren't each running a
MapLibre instance) and suppressed in the configure dialog (which already
embeds the interactive picker). Spatial types read cached play-area
references, degrading to "show the whole play area" on any failure.
**Photo is skipped** — it narrows nothing (the engine would just
highlight the whole play area), and the photo card's own received-image
`<img>` (`photoUrl ?? photoUri`) below IS its outcome. Once a question is
**resolved** (`locked`/answered) its config children (subtype select,
location-picker mini-map, …) are hidden — they're a read-only duplicate
of what the outcome map already shows, so the expanded card is just the
map. Children stay for in-flight questions (e.g. the thermometer
end-point share), the configure dialog (`forceExpanded`), and photo.

The questions drawer header (`QuestionSidebar.tsx`) matches the settings
drawer's (v593): a small `text-lg font-semibold` title + a muted
description, on the same `px-6` inset. The single **New question** CTA is
the standard primary `Button` (sentence case, normal size — v595); it
sits to the right of the title WHEN there are questions, and moves INTO
the empty-state box (as the lone CTA) when the list is empty. The
role/SEEKER chip is gone, and the empty state has **no logo icon**.

The shared `HideSeekMark` logomark (now used in `Welcome` only — dropped
from the empty state and the `BetaGate` in v593/v594) was realigned in
v593 to the favicon/landing-scene layout (sun centred,
mountain apex at the sun's centre, base spanning the full bottom) — the
pre-v593 mark had the sun high and the base inset; that was the "old"
look. Brand red `hsl(5 69% 55%)`.

## Current state

The app is well past the early-batch features documented here historically — current version is in `src/lib/version.ts` (`vNN`). Per-file batch tracking was discontinued; use `git log` + `src/lib/version.ts` as the source of truth for "what changed when." The baseline now includes: game-setup wizard, multiplayer (see below), photo questions, hider role + reach/trip-planning, thermometer target-distance flow, tile packs, and more.

## Multiplayer (shipped)

Built on **Cloudflare Workers + Durable Objects** (one DO per game, WebSocket fan-out, server-authoritative) — the decision resolved to **raw Workers+DO** (not PartyKit). Full design + operator docs in **`MULTIPLAYER.md`**. Real file layout:

- **Server** (`worker/`): `index.ts` (HTTP router — `POST /games`, `GET /games/:code/ws`, `GET /health`, `GET /vapid-public-key`, plus photo answers: `POST /games/:code/photo` → R2, `GET /games/:code/photo/:id`), `GameRoom.ts` (the Durable Object), `webpush.ts` (RFC 8291/8188 Web Push), `wrangler.toml` (DO binding + `PHOTOS` R2 binding → `jlhs-overpass-cache` bucket, `photos/<code>/<id>` prefix), `scripts/deploy.mjs` (master-only deploy shim).
- **Client lib** (`src/lib/multiplayer/`): `transport.ts`, `session.ts`, `store.ts` (the questions-store bridge), `types.ts`, `demoBroker.ts` (in-browser mock room for demo mode).
- **Client components** (`src/components/multiplayer/`): `OnlinePlaySection.tsx` (host/join), `InviteSheet.tsx`, `MultiplayerBoot.tsx`, `PresenceIndicators.tsx`, `RotateHiderDialog.tsx` — plus `GameLobbyDialog`, `RolePicker`, `SeekerLivePositions`, `CurseInbox` elsewhere.
- **Shared** (`protocol/`): `{index,messages,names,state,version}.ts` — wire types imported by both client and worker.

Shipped features include **live seeker→hider location sharing** (`loc` message), **curses over the wire** (`castCurse`/`curseReceived`, including Web Push to offline seekers), and presence. Limits live in `protocol/state.ts` (`MAX_PARTICIPANTS=5`, `IDLE_EVICTION_MS=30min`, `MAX_ROOM_LIFETIME_MS=18h`, `MAX_QUESTIONS_PER_ROOM=200`, `MAX_MESSAGE_BYTES=64KB`). Still absent: spectator mode, sophisticated reconnect.

## Coding conventions

- Tailwind + shadcn/ui components. `cn()` from `@/lib/utils` for class merging.
- `useStore(atom)` from `@nanostores/react` for reactive state.
- `questionModified()` from context to trigger re-render after mutating question data in place.
- Toast notifications via `react-toastify` (`toast.success/error/info`).
- No `<form>` elements in React components — use `onClick`/`onChange` handlers.
- Responsive: mobile-first, `md:` breakpoint for desktop-specific layout.
- Bottom nav is mobile-only (`md:hidden`). Top-left/right controls are `hidden md:block` or always-visible depending on what they replace.
- No emojis in code/UI text.

## Versioning

`src/lib/version.ts` exports `APP_VERSION` (the `vNN` batch sequence),
shown in the debug panel header (`DebugPhaseControls`) and the collapsed
bug-button tooltip. **Bump `APP_VERSION` on every meaningful change/deploy**
so the live build is identifiable at a glance — there's no other visible
build stamp. Current: `v683`. Use `git log` for the per-version detail;
the headline arcs since the v414 rulebook-audit pass (a SECOND rulebook
conformance pass landed in v671–v672 — see `RULEBOOK_AUDIT.md` section D:
time-bonus scoring direction fix, tentacle 2 km/25 km radii, one shared
`resetSharedRoundState()` for host+guest round resets, matching/measuring
un-gated to all sizes, grace→auto-commit, hand-limit-6 enforcement
(`HandLimitEnforcer`), and a manual game pause (`gamePause.ts` +
`GamePausedOverlay`, folded into `effectiveHiddenDebitMs`)):

- **Universal hider auto-grading wired into the answer flow** —
  `hiderifyQuestion` (`src/maps/index.ts`, the same engine the seeker
  uses to preview answer regions) now grades EVERY type in the hider's
  answer dialog (`HiderView.tsx`): radar/thermometer locally, matching/
  measuring/tentacles via the engine (verdict pre-selected, manual
  override kept). **Photo** is answerable from the dialog too (was the
  one type that dead-ended). **Veto / Randomize** are playable in the
  answer dialog; Randomize auto-grades a random substitute for the
  spatial types and swaps to a different photo subtype for photo.
  **Randomize SPLIT (v597):** the hider still overwrites the question in
  place over the wire, but the SEEKER's `mergeIncomingQuestion`
  (`multiplayer/store.ts`) splits a `randomized` answer into TWO list
  entries — the ORIGINAL kept as asked (`randomizedAway:true`, eliminates
  nothing, shown "Randomized") + the SUBSTITUTE as a separate answered
  entry (`substituteFor` label, key = original+1000, eliminates normally).
  Idempotent on re-send/snapshot; degrades to the single substitute entry
  on a fresh reconnect where the original's subtype is no longer local.
  `randomizedAway` is skipped by the elimination engine (like `vetoed`).
- **Photo pipeline** — capture → crop/censor editor
  (`PhotoCensorDialog.tsx`, non-destructive undo/redo, redaction baked
  into the exported JPEG) → `preparePhotoForSend` (`src/lib/photo.ts`):
  full-detail ~2560px JPEG uploaded to R2 via the multiplayer worker
  (`POST /games/:code/photo`, `PHOTOS` binding reusing the
  `jlhs-overpass-cache` bucket), only the short `photoUrl` crosses the
  WebSocket (a data URI would blow the 64 KB / 1 MiB WS caps). Thumbnail
  kept locally; solo/offline inlines the full image.
- **Question overlays redesigned** to the Jet Lag show lower-third look
  — shared `QuestionOverlayCard` (+ `summarizeQuestion`) used by BOTH
  the seeker's `PendingAnswerOverlay` and the hider's
  `HiderUnansweredOverlay`: solid category-colour icon block (left),
  big bold uppercase label in the deepened category colour, live status
  (countdown / retry / answered) on the right. Theme-aware via CSS vars
  (see Theming above). "Not sent" only happens on an offline copy
  failure → its action is **Retry**, not Share. **Answered state is
  STICKY (v599):** when the hider answers, the seeker's
  `PendingAnswerOverlay` switches to a green answered card showing the
  resolved answer (via the now-exported `answeredDetail` from
  `cards/base.tsx`) and **stays put** — it no longer auto-dismisses after
  a beat. Its right slot is a single **Dismiss** action (v604 dropped the
  Details button); tapping the card body still opens the questions panel.
  Asking the next question replaces it; v605 reduced the Dismiss action
  to a single big **X**. The card also plays a one-shot
  green glow/scale pop (`jlAnsweredCard`) the moment the answer lands
  (shared `QuestionOverlayCard`, fires on the awaiting→answered
  transition), and the main map flashes the **newly-eliminated slice** in
  brand red and fades it into the dark mask (`Map.tsx` diffs the previous
  vs. new remaining region) so an answer reads as a deliberate beat. The
  flash **blinks on-off-on-off (two pulses) then fades out slowly**
  (~1.7 s) — a timed step sequence in `triggerEliminationFlash` with a
  per-step transition duration (`eliminationFlash.fadeMs`: snappy for the
  blinks, long for the final fade). If
  the answer lands while the app is **backgrounded**, the flash is deferred
  and **replayed on return to the foreground** (v612 — `Map.tsx` snapshots
  the remaining area on `visibilitychange→hidden` and diffs it against the
  current area when visible again, so the seeker doesn't miss the beat).
- **OS notifications** (`src/lib/notifications.ts` `notify()` →
  `registration.showNotification`, mirrored in `src/sw.ts`'s push handler)
  use a **monochrome transparent badge** (`public/notification-badge.png`,
  white sun+mountain silhouette) — Android renders the small status-bar
  icon from the alpha channel and tints it, so a colour favicon showed as
  a solid rounded square. **Push-notification icons (v630):** Web Push
  notifications sometimes fell back to the generic bell + "H" letter
  avatar because the OS fetches the `icon`/`badge` directly (often
  bypassing the SW cache) and races the network on a cold push. Fixed by
  (a) long `immutable` HTTP cache headers on `notification-badge.png` +
  `android-chrome-192x192/512x512.png` (`public/_headers`), so the
  browser's own cache retains them, and (b) a `CacheFirst` SW runtime
  route for the icon+badge (`sw.ts`) as a backup for the SW-intercepted
  path. **Curses over the wire** (`curseReceived` in
  `multiplayer/store.ts`) now append to `receivedCurses` (the atom
  `CurseInbox` renders), not just fire a notification — previously a curse
  push surfaced nothing in-app (v612). **Seeker curse UI (v615):**
  `CurseInbox` drops the casting cost (it's the hider's concern); shows the
  `DiceRoller` ONLY for curses that make the seekers roll
  (`curseRequiresDice`, `src/lib/curseMeta.ts` — a name set + description
  fallback); auto-clears time-limited curses on a live countdown
  (`curseDurationMs` per game size, name table + "for the next N min/h"
  parse); and gives open-ended curses a manual **Clear curse** button
  (we trust the seekers' word, since clearing them is a real-world task).
  **Curses are per-round (v616):** `startNewRound` AND `startNewGame`
  (`roundActions.ts`) clear `receivedCurses` so a curse the seeker was
  still under doesn't bleed into the next round/game.
  **In-app curse ENFORCEMENT (v621):** three curses whose effect is
  "block the seekers from asking" are now enforced by the question UI,
  not just displayed — `src/lib/curseEnforcement.ts` is the single source
  (`computeAskingRestrictions(curses, {onTransit, spottyCategory})` →
  `{disabledCategories, blockedAll, reason, needsSpottyRoll}`):
  - **Drained Brain** — the hider picks **3 categories** at cast time
    (`CastCurseDialog` multi-select, gates the cast); they ride the curse
    payload's new optional `disabledCategories: string[]` field (added to
    both `protocol/messages.ts CursePayload` and `shareLinks
    SharedCursePayload`, carried over the wire AND the `?c=` link) and stay
    greyed out in the seeker's `AddQuestionDialog` tiles for the run.
  - **Spotty Memory** — the seeker rolls a d6 in the `CurseInbox` dialog
    (`DiceRoller` gained an `onSettle` cb; roll → `SPOTTY_DIE_CATEGORIES`
    index → `spottyMemoryCategory` atom); that one category is disabled
    until the next question is asked, when `CurseInbox`'s question-count
    effect clears it to force a re-roll. Before rolling, asking is blocked
    entirely (`needsSpottyRoll`).
  - **Urban Explorer** — a seeker self-declared `seekerOnTransit` toggle
    (in the curse dialog; the app has no reliable on-transit signal) blocks
    ALL asking while on.
  The gate is applied in `AddQuestionDialog` (per-tile `curseReason()` +
  a full-block notice) and `BottomNav` (New-question button disabled on
  `blockedAll`). These three are "rest of your run" curses → NOT manually
  clearable in `CurseInbox` (would drop the enforcement); they lift at
  round end. `seekerOnTransit` + `spottyMemoryCategory` reset per round in
  `roundActions`. The dice/movement curses (Jammed Door, Gambler's Feet,
  Endless Tumble, Right Turn) stay real-world — the app's only role is the
  existing dice roller.
- **A sent/answered question can't be deleted** (it would desync from
  the hider). As of v585 `cards/base.tsx` has **no delete control at
  all** — the earlier "swap the trash for a disabled lock in online
  games" treatment is gone; discarding an un-sent draft is the configure
  dialog's Cancel.
- **Debug overlay gallery** at `/debug/overlays` — every state of every
  overlay at once via a `preview` prop on each overlay (shadows its
  atoms, writes nothing global), plus a light/dark toggle. The debug
  panel (`DebugPhaseControls`) is also mounted on the `/welcome` landing
  page now. **Debug launcher in the header (v617):** the panel's launcher
  is the inline `DebugLaunchButton` (`Bug` icon, left slot of
  `SeekerTopBar`/`HiderTopBar`) — it replaced the floating bottom-left
  "debug" chip, which now collided with the Map-options chip moved there
  in v616. `DebugLaunchButton` only imports `debugPanelOpen` +
  `spoofedPosition` (featherweight) so the header stays out of the heavy
  lazy debug bundle. `DebugPhaseControls` takes a `floating` prop
  (`"always"` default / `"desktop"` / `"never"`) gating the legacy
  floating chip: seeker in-game uses `"desktop"` (mobile has the header,
  desktop has no header), hider in-game uses `"never"` (HiderTopBar shows
  on every viewport), and the pre-game lobbies + `/welcome` keep
  `"always"` (no header there).

Still enforced from the v414 audit (see `RULEBOOK_AUDIT.md`): Overflowing
Chalice draw boost, Move powerup pause/freeze/re-anchor, thermometer
preset size-gating, photo answer window by size, late-answer pause +
no-card economy, discard casting costs. Scoring:
`max(0, (foundAt − hidingEndsAt) + hiddenCreditMs − hiddenDebitMs)`.
B2 repeat-question pay-double still deferred (plan in the audit doc).

### Hider economy quick-reference

- `hiderRole.ts` — deck/hand/draw state. `presentDraw(n, k, cat, key)`
  is the single question-reward chokepoint (Chalice +1 boost lives
  here). `settleLateAnswer(key, cat)` banks overdue time + signals
  "no card". `QUESTION_DRAW_BUDGET` is the base draw/keep table.
- `gameSetup.ts` — `answerWindowMs(cat, size)`, `MOVE_PERIOD_MINUTES`,
  `hiddenCreditMs` (Move bank), `hiddenDebitMs` (late-answer pause),
  `seekersFrozenUntil` (Move freeze).
- `roundActions.ts` — `playMovePowerup()`; resets all three economy
  atoms in `startNewRound` / `startNewGame`.
- `castingCost.ts` — parses/enforces discard casting costs.

## Dev workflow

1. Edit files
2. **Update the docs in the same change** (standing instruction): keep
   this `CLAUDE.md` — and the relevant topic doc (`MULTIPLAYER.md`,
   `RULEBOOK_AUDIT.md`, `overpass-cache/*.md`) — in sync whenever you
   change app behaviour, architecture, endpoints, schema, or
   conventions. Treat stale docs as a bug; fix the affected section
   rather than only appending.
3. **Dependencies are installed with PNPM in CI.** The Cloudflare build
   runs `pnpm install --frozen-lockfile` (it detects the root
   `pnpm-lock.yaml`), so after ANY package.json change you MUST refresh
   the pnpm lockfile — `npx pnpm@10 install --lockfile-only` — or the
   deploy fails with ERR_PNPM_OUTDATED_LOCKFILE. An `npm install` alone
   only updates package-lock.json (which CI ignores); this exact
   mismatch broke the v662 deploy.
4. **Run `npm run verify` before pushing** (v662): `tsc --noEmit` +
   `eslint --config eslint.hooks.config.js src` (ONLY
   `react-hooks/rules-of-hooks` — the crash-class rule; full lint debt
   isn't gated yet) + `vitest run`. `npm run build` runs verify first,
   so a Cloudflare build fails instead of deploying broken code (if the
   dashboard invokes `vite build` directly rather than `npm run build`,
   switch it to `npm run build`; `build:only` keeps the ungated path).
   **`tsc --noEmit` is expected to be ZERO errors** — there is no
   known-errors filter list anymore; a new error is a regression.
   MapLibre paint objects that carry `*-transition` props (which the
   style-spec types omit) are wrapped in `fadePaint(...)`
   (`src/lib/mapPaint.ts`) — use it for any new fading layer.
5. Bump `APP_VERSION` in `src/lib/version.ts`
6. Push to master → Cloudflare auto-builds (2–3 min)
7. Check build logs in Cloudflare dashboard
8. If build fails: check TypeScript errors first (the historical SSR
   `window is not defined` Leaflet trap no longer applies — client-only SPA)

For multi-file changes: use `github.dev` (press `.` on repo) to batch-commit across folders in a single build trigger.

## Deploy mechanism (Cloudflare Workers Builds, not GitHub Actions)

GitHub Actions is **not** usable on this account (billing-locked — the
runner refuses to start). Deploys run on **Cloudflare's own build
system** (Workers Builds), connected to the GitHub repo, which builds
and deploys on every push to `master` — no GitHub minutes, no API token.

Two separate Cloudflare Workers Builds projects watch the same repo:
- **`jetlaghideandseek`** — the Astro frontend (repo root). Already wired.
- **`jlhs-multiplayer`** — the multiplayer worker + Durable Object.
  Build root directory `worker/`, deploy command
  `npx wrangler deploy --config wrangler.toml`. The explicit `--config`
  is REQUIRED: without it wrangler's auto-discovery walks up to the
  repo-root `wrangler.jsonc` (the frontend config) and fails on
  `assets.directory ... does not exist`. The worker imports
  `@protocol/*` from the repo-root `protocol/` dir (resolved via
  `worker/tsconfig.json` paths against `baseUrl: ".."`), so the full
  repo checkout must be present — which it is.

Do not add `.github/workflows/*` deploy jobs — they can't run here.
