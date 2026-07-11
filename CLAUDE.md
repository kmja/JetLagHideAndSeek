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

**Reference families + prewarm/cron (v625).** Matching/measuring reference POIs come from a "family" system: `STANDARD_REFERENCE_FAMILIES` (`playAreaPrefetch.ts`) is the canonical list warmed on play-area load, and it MUST stay byte-identical to the worker cron's `REFERENCE_FAMILY_FILTERS` (`overpass-cache/src/index.ts`) — the combined bbox query's hash is the shared R2 key. **Complete-cache guarantee (v685):** `runBboxOverpassFetch` returns `{elements, complete}` — `complete:true` ONLY when every play-area relation was a clean `/api/refs/<id>` R2 hit (served with zero live Overpass). On a complete result a family with 0 elements is AUTHORITATIVE (genuinely 0), so the preload records 0 and NEVER falls back to a live single-family query — a fully-prewarmed ("starred") city must never touch a public mirror mid-game. The per-family live re-fetch remains ONLY for `complete:false` (a cold area fell to the live/primary bbox query, where truncation is a real risk). Diagnose a wrongly-0 family for a warm city with **`GET /admin/inspect-refs?id=<rel>&secret=…`** (per-family element counts from the stored refs body) — a 0 there is a filter bug to fix at the source + re-warm, not a runtime live fallback (e.g. `["diplomatic"="consulate"]` misses `consulate_general`). To add a family: update `FamilyKey`, `STANDARD_REFERENCE_FAMILIES`, `filterForFamily`, `elementMatchesFamily`, `cacheableFamilyForType` (client) AND `REFERENCE_FAMILY_FILTERS` (worker) with the SAME filter string. **The `api:*` families derive their filter from ONE producer — `apiLocationFilter(loc)` / `apiLocationMatches(loc, tags)` in `constants.ts`** (used by `filterForFamily`, `elementMatchesFamily`, AND the matching/measuring elimination), so a per-location override lives in one place: **`consulate` = `["diplomatic"~"^consulate"]`** (v686 — catches `consulate` + `consulate_general`, excludes `honorary_consul`; the bare `="consulate"` found 0 in Oslo). The worker's `REFERENCE_FAMILY_FILTERS` consulate entry is kept byte-identical by hand. **Changing any reference filter changes the combined query string → new R2 key → ALL cities' refs entries orphan → stars drop and re-populate as cities re-warm** (the v686 consulate change requires a full refs re-warm). **Laptop self-heal (v700):** the offline `laptop-prewarm.mjs` kept a THIRD hand-mirror of these filters, and it silently missed the v686 consulate change — so every laptop-warmed city wrote its refs to the OLD key and failed the primary-star gate (`missing refs`) while the app read the new key and went live. Now the worker exposes the canonical set at **`GET /api/reference-filters`** (`handleReferenceFilters` — `referenceFilters`/`stationFilters`/`waterFilters` + their pads) and the laptop's `syncReferenceFilters()` fetches it at startup and OVERRIDES its local copies (loudly logging any drift it corrects), degrading to the now-correct local copies if the endpoint is unreachable. So the hand-mirror can't silently orphan a warm again; the worker is the single source of truth for the cache-key filter strings. **`body-of-water`** was tightened to MAJOR bodies only in v686 — `["natural"="water"]["name"]["water"!~"pond|basin|pool|fountain|wastewater|moat|tank|ditch"]` (in lockstep between `filterForFamily` and `measuring.ts`'s elimination fetch) to cut the pond/basin/pool noise that made it too heavy; still fetched lazily/isolated (not in the combined prewarm). Two families of note:
- **`rail-station`** (`["railway"="station"]`) backs the three station-property matching types, all **eliminated seeker-side** via one shared helper `matchingStationBoundary` (`matching.ts`, v625–v626): it Voronoi-partitions ALL stations and unions the cells of every station matching the seeker's nearest on the relevant property, so the map cut agrees with the hider's answer. **`same-train-line`** uses `trainLineNodeFinder` (same call the hider grades with); **`same-first-letter-station`** matches the first letter of the `name:en`/`name`; **`same-length-station`** is 3-way (`lengthComparison` equal/shorter/longer) — its boundary encodes the answer so `adjustPerMatching` always KEEPS the region (memo key includes `lengthComparison`). `same-first-letter-station`'s elimination is implemented but it is **not** in the subtype picker (v627) — it isn't a rulebook question (the rulebook only has "Station Name's Length"), and the picker mirrors the rulebook exactly. **Rulebook parity (v627): the app offers exactly the rulebook's questions — no more, no less** (Matching 20, Measuring 20, Radar 9 presets + Choose, Thermometer 1/5/15/75 by size, Photo 6/+8/+4 by size, Tentacles 4/+4 by size).
- **`body-of-water`** (`["natural"="water"]["name"]`) replaced the old Natural Earth 1:50m lakes bundle (v625) — that had ~411 major lakes and no rivers, so it found nothing at city scale. **NOT in the combined prewarm (v632):** `natural=water` matches huge multipolygon geometry (the Seine, canals, thousands of named ponds), so bundling it into the shared combined reference query timed the WHOLE reference set out upstream for dense metros — which broke the Paris cron prewarm and tripped Overpass rate limits on every Paris play-area pick. So `body-of-water` is deliberately **excluded from `STANDARD_REFERENCE_FAMILIES` + `REFERENCE_FAMILY_FILTERS`** and fetched LAZILY in isolation: `prefetchCategory` routes any family not in `STANDARD_FAMILY_SET` through `runSingleFamilyBboxFetch` (its own bbox query), so a heavy water scan can only slow its own on-demand fetch, never the shared prewarm. The isolated fetch holds `natural=water` centroids for the nearest-reference preview; the measuring ELIMINATION (`measuring.ts`) fetches full geometry (`natural=water` areas + named `waterway=river/canal` lines via `out geom`) so the seeker-distance buffer reflects real shore/bank distance. Rulebook p11: "any named body of water … excluding pools" (the `["name"]` filter enforces both). **Still isolated, but now PREWARMED (v687):** both consumers read the relation-keyed `GET /api/water/<id>` first (the `out geom` set served from R2) and only fall to the live isolated query on a cold miss — see the "Named-water prewarm (v687)" section below. The major-body `["water"!~"pond|basin|pool|fountain|wastewater|moat|tank|ditch"]` exclusion (v685) keeps a dense metro's water light enough to warm.

**Availability gating (v564):** `useSubtypeAvailability` (`src/lib/subtypeAvailability.ts`) greys out subtype tiles whose reference type has too few instances *inside the play area* to make a meaningful question — matching/tentacles need ≥2 (with one, everyone shares it), measuring needs ≥1. It counts via `countInPlayArea(family)` (`playAreaPrefetch.ts`, polygon-filtered cached features) for countable POI families only (airport, rail-station, `api:*` from `LOCATION_FIRST_TAG`); non-countable subtypes (admin divisions/borders, coastline, transit-line/name-length, metro, landmass, photo) and unknown/cold counts always stay enabled, so nothing valid is wrongly hidden. Relatedly, the **nearest-reference** lookup (`NearestReferencePreview.tsx`) filters every Overpass `around:`-radius fallback to the play-area polygon (`pointInPlayArea`) so an out-of-bounds instance can't win over a valid in-area one (rulebook p17).

**Self-hosting fetch paths (v639) — toward zero-Overpass for prewarmed cities.** Three changes closed the wizard/lobby-preview leaks the audit found: (1) **Boundary fetch is worker-first, CACHE-ONLY** — `doFetchRawBoundaryPolygon` (`polygonsOsmFr.ts`) tries the worker's R2 `relation(N);out geom;` (`fetchPolygonViaCacheWorker`, which passes **`?cacheOnly=1`**) BEFORE polygons.osm.fr, so a curated city's primary + neighbour boundaries paint from R2. **`cacheOnly=1` (v640) returns an edge/R2 hit (fresh or stale) or an instant empty `{elements:[]}` MISS — it NEVER goes upstream.** This is load-bearing: without it, worker-first sent every un-prewarmed neighbour's boundary to a LIVE Overpass query (the Madrid wizard fired ~14 `relation(N);out geom;` at overpass-api.de → 504s, and Cloudflare then 500'd the overloaded worker without CORS headers). With `cacheOnly`, an un-prewarmed area misses fast and the client falls to polygons.osm.fr (not Overpass); prewarmed neighbours self-warm only via the cron/laptop, not client traffic. (2) **Neighbour boundaries are prewarmed** — the cron's `prewarmAdjacentSearchForCity` (`overpass-cache/src/index.ts`) reads the topological + admin-band results it just stored, extracts up to `MAX_NEIGHBOUR_BOUNDARIES` (14) admin-boundary relation ids, and prewarms each via `singleRelationQuery` (byte-identical to the client's worker fetch). (3) **Adjacency `around:` centroid is relation-ID-keyed (v640), not client-derived** — the client fetches the ONE canonical extent from `GET /api/relation-extent/<id>` (`RELATION_EXTENT_BASE`; worker `handleRelationExtent` returns the stored `city.extent` via `getPopularCities`, the exact value `prewarmAdjacentSearchForCity`'s queries use, or a live `bboxFromRelation` for uncurated), and both sides take `((maxLat+minLat)/2, (minLng+maxLng)/2)` of that single value. This is the **v359 `/api/refs/<id>` pattern applied to adjacency**: one producer of the coordinate instead of two (client-bbox vs cron-bbox), so the `around:` string matches byte-for-byte with **no rounding** — replacing the earlier v639 3-dp-rounding band-aid (rounding two independently-derived numbers is the same anti-pattern v356/v359 killed for references). The builders in `playAreaExtensions.ts` ↔ `index.ts` are back to raw `${lat},${lng}` and kept byte-identical. **Transition caveat:** the query strings changed (rounded → raw), so existing prewarmed adjacency entries go stale and the cron re-warms under the new keys; until it catches up, adjacency cold-misses and falls through live (silently). **Laptop extent backfill (v640):** adjacency warming (cron *and* laptop) is gated on a city having a stored `city.extent`, which was previously cron-only (`upsertDiscoveredCity`, ~5 relations/tick). `POST /admin/store-city-extent {name, relationId}` (`handleAdminStoreCityExtent`, admin-secret) now derives it server-side via `bboxFromRelation` and upserts it, so `laptop-prewarm.mjs` (`ensureCityExtent`, called at the top of `processCity`) can fully bootstrap a brand-new city — extent → adjacency → references → boundaries → neighbours — in one run with no cron wait. The laptop's adjacency warm now keys off `city.extent` (the canonical value, matching the cron + client) rather than its boundary-geometry extent. **As of v665 the list of position-keyed live Overpass queries is EMPTY** — the last two (the hider map-tap `findNearestStation` fallback and `NearbyStationsPicker`'s 500 m `around:GPS` scan) now resolve against the game's own candidate-zone set via `findZonesNearPoint`/`findZoneAtPoint` (`src/lib/journey/stations.ts`): the shared play-area-keyed station fetch (byte-identical to the seeker's hiding-zones query, one R2 entry per game, in-module memoised + in-flight-coalesced) filtered client-side to the zones whose hiding-radius circle contains the point. Semantics improved too: a station of a disallowed mode or outside the play area is not a legal zone and no longer resolves; the picker header reads "Zones you're in". (Satellite tiles came off the external list in v664 — see the tile-overlays section.)

**Hiding-zone station prewarm (v668) — the last un-prewarmed hiding-zones surface.** The hider's "Hiding zones" overlay + the zone-containment lookups (`findZonesNearPoint`/`findZoneAtPoint`) fetch the candidate STATION field, which is a distinct Overpass query from anything the prewarm warmed: `hidingZoneFiltersFor(allowed)` is a multi-mode union of STOP selectors (`railway=station`, `highway=bus_stop`, `railway=tram_stop`, ferry, …) — NOT the reference-family `rail-station` (`["railway"="station"]`) nor the transit-ROUTE shards. So it only ever cached ON-DEMAND after a first live fetch — and that first fetch is the heaviest possible query (`bus_stop` across a whole metro), which is exactly what soft-timed-out for Chicago. Now it's prewarmed by the SAME relation-ID-keyed pattern as `/api/refs`: **`GET /api/area-stations/<relationId>`** (`handleAreaStationsByRelation`) derives the boundary-geometry extent (`canonicalReferenceExtent`, the identical drift-free extent references use), rebuilds the ONE combined all-mode station bbox query (`buildAreaStationsBboxQuery`, `AREA_STATION_FILTERS`, 2 km pad, `[timeout:180]`), and serves the R2 entry — so the client never builds a byte-fragile query (zero cross-codebase drift). Warmed per-city by the cron (**Phase 2b**, `prewarmAreaStationsForCity`, isolated NOT batched — the bus clause is too heavy to bundle, same lesson as `body-of-water` v632; opt-out `AREA_STATIONS_PREWARM_ENABLED="false"`), the laptop (`areaStationsQuery` in `laptop-prewarm.mjs`, byte-identical to the worker builder), and on-demand via `?warm=1` (`warmRelationAreaStations`, boundary-ensure → derive extent → abort-guarded store). Client: `fetchRawAreaStations` (`stations.ts`) tries the prewarm endpoint FIRST (all modes → filtered client-side to the allowed set), falling back to the live poly `findPlacesInZone` query on miss (and firing `requestStationWarm` so the next load is warm). All warm/prewarm paths refuse to store an abort-remark body (v667). **The SEEKER's `ZoneSidebar` is routed through it too (v669)** — `fetchPrewarmedHidingZoneStations(options)` serves the endpoint when `$displayHidingZonesOptions` map EXACTLY to a whole-mode subset (`modesForExactOptions` — the common auto-tracking case; any partial-mode or custom/non-mode pick declines to the live poly query), returning an Overpass-shaped `{elements}` fed straight to `osmtogeojson`. **Added adjacent areas are first-class on the fast path (v670):** the endpoint is FANNED over EVERY play-area relation id (primary + each added adjacent area — `playAreaRelationIdsAll`, mirroring `playAreaRelationIds().all`) and UNIONed (`fetchPrewarmedStationsUnion`), so an added area is prewarmed/served just like the primary. Each per-relation entry is a 2 km-PADDED bbox superset, so the union is culled to the combined play-area polygon (`cullElementsToPlayArea`, matching the poly query's clipping — no out-of-area stations). The endpoint is used ONLY when EVERY area is warm (miss detected via the endpoint's `cache` marker, distinct from a warmed-but-empty area); any cold area is `?warm=1`-background-warmed and the whole set falls to the live poly query (built from the combined polygon, so it covers the union). The live poly path keeps the v667 all-mirrors-failed detection; the endpoint path can't fail that way (it never touches Overpass). Not-yet-prewarmed added areas rely on the on-demand `?warm=1` (`warmRelationAreaStations` warms any relation id), the same as references. **Bus PTv2 broadening (v723):** the `bus` mode selector was `[highway=bus_stop]` only, so cities that map bus stops purely as PTv2 (`public_transport=platform` + `bus=yes`, no `highway=bus_stop`) showed ZERO bus hiding zones even with a dense bus overlay (reported on Nairobi's matatu network). `HIDING_ZONE_FILTERS_BY_MODE.bus` (client `gameSetup.ts`) is now `["[highway=bus_stop]", "[public_transport=platform][bus=yes]"]`, mirrored into the worker's `AREA_STATION_FILTERS` (`index.ts`) AND the laptop's byte-identical copy (`laptop-prewarm.mjs`; also auto-synced from `/api/reference-filters`'s `stationFilters`). Mode classification already maps `bus=yes` → bus (`inferStationMode`, `stations.ts inferMode`), so the new platforms are kept when bus is allowed and dropped otherwise. **This changes the combined `AREA_STATION_FILTERS` query string → new R2 key → all prewarmed `area-stations` entries orphan and re-warm** (same one-producer cache-key coupling as the reference filters); the live poly path (uncurated cities) fixes immediately, while a STARRED city (Nairobi) misses the new key → falls to the live poly query (which shows bus) + re-warms, and its star briefly drops until the cron/laptop re-warms the new key. **All-mode PTv2 audit (v724):** the same PTv2-platform gap was swept across every mode. **tram** gained `[public_transport=platform][tram=yes]` (networks that map tram stops only as PTv2 platforms; safe because a tram stop is a single platform, unlike multi-platform heavy rail). **ferry** gained `[public_transport=platform][ferry=yes]` — the documented PTv2 flag — since the pre-existing `[public_transport=platform][platform=ferry]` used a NON-standard tag that matched almost nothing (`platform=ferry` kept for the rare city that used it). **train/subway deliberately get NO platform selector** — a multi-platform station would explode into per-platform zones (distinctly-named platform ways don't dedup), and PTv2-only heavy rail/metro is rare, so legacy `railway=station`/`halt`/`subway=yes` still covers them. The prewarm-path classifier `stations.ts inferMode` was ALSO missing `tram=yes`/`ferry=yes`/`train=yes` (it would fetch the new platforms then drop them as unclassified) — now completed to mirror `stationManipulations.inferStationMode`. All additions land in the SAME `AREA_STATION_FILTERS` re-warm as the bus change (client `gameSetup.ts` + worker `index.ts` + laptop mirror).

**Named-water prewarm (v687) — the last per-question-type live hole.** The measuring **body-of-water** ELIMINATION needs full `out geom` water geometry (lake/reservoir shores + named river/canal centrelines) to buffer by seeker-distance — the single heaviest reference family in a dense metro, which is exactly why it's kept OUT of the combined refs query (v632) and why it soft-timed-out live on Paris. It's now prewarmed by the SAME relation-ID-keyed pattern as `/api/area-stations`: **`GET /api/water/<relationId>`** (`handleWaterByRelation`) derives the canonical boundary-geometry extent, rebuilds the one water query (`buildWaterBboxQuery`, `WATER_FILTERS` = the major-body **named** `natural=water` polygon filter + the `waterway~^(river|canal)$` line filter **with NO `["name"]`** (v690 — OSM tags a river's name on only some segments, so per-segment name-gating left the overlay skipping unnamed segments of an obvious river; rivers/canals are bodies of water even unnamed, and the type filter still excludes drains/streams/ditches — named-only stays on the polygon filter so unnamed ponds don't flood in), 2 km pad, `[timeout:180]`, `out geom`), and serves the R2 entry — client never builds a byte-fragile query. `WATER_FILTERS` MUST stay byte-identical to `measuring.ts`'s live-fallback filters AND `filterForFamily("body-of-water")`. Warmed per-city by the cron (**Phase 2c**, `prewarmWaterForCity`, isolated NOT batched — same heaviness lesson as stations/v632; opt-out `WATER_PREWARM_ENABLED="false"`), the laptop (`waterQuery` in `laptop-prewarm.mjs`, byte-identical to the worker builder; `--skip-water` to drop; runs for one-ring neighbours too), and on-demand via `?warm=1` (`warmRelationWater`, boundary-ensure → derive extent → abort-guarded store). Client (`src/maps/api/water.ts`): `fetchPrewarmedAreaWater()` fans the endpoint over EVERY play-area relation (primary + added adjacent) and UNIONs (deduped by `type/id`), used ONLY when every area is warm (miss via the `cache` marker); any cold area is `?warm=1`-warmed and BOTH consumers fall to the live query — the `measuring.ts` elimination poly query (`requestWaterWarmAll` after) AND the point-cache `runSingleFamilyBboxFetch("body-of-water")` (nearest-reference preview + availability count, deriving a representative point per `out geom` body via `featureFromGeomElement`). The union is a 2 km-padded bbox SUPERSET, deliberately NOT culled to the polygon — a shore just outside the boundary is still the nearest body of water (rulebook p17), and the elimination buffers geometry anyway. **NOT yet in the star gate** (`relationFullyCurated` still checks boundary+refs+stations only): water warming's reliability on the hardest metros is being verified before the star depends on it, so a starred city still self-warms water on first use (the one remaining first-game live fetch for this type). **Nearest-reference preview fixed (v688):** the body-of-water configure-card "Your nearest reference" label used to read the `natural=water` CENTROID point-cache — which ignored rivers (mapped as `waterway` LINES, never in that cache) and measured a lake from its middle, so a river 1 km away lost to a pond 3 km away named "Public Park". `fetchNearestWater` (`NearestReferencePreview.tsx`) now reads the SAME full `out geom` geometry the elimination buffers (`fetchPrewarmedAreaWater` first, live poly fallback) and returns the true closest point on any shore/river/canal via `polygonToLine` + `nearestPointOnLine` (like the coastline fetcher), so the label agrees with the actual answer. The elimination was already correct; this was a display-only mismatch, but a wrong reference label undermines trust. **Impact overlay fixed (v689):** the configure-card closer/further impact overlay (`questionImpact.ts`) had the SAME centroid bug in a THIRD place — it buffered the `natural=water` centroid point-cache, so it drew big circles around distant lake/pond centres and marked areas far from any shore as "closer", disagreeing with both the real cut and the label. For `body-of-water` the overlay now reuses `measuringDraftBuffer` (`measuring.ts`) — the exact memoised `bufferedDeterminer` buffer the elimination keeps — so preview, label, and answer are finally one geometry. Every other measuring family is a genuine point set, so it keeps the centroid buffer (exact there). **Sea/bay inclusion (v702):** OSM tags the open sea and large bays as `natural=coastline` (a SEPARATE family), NOT `natural=water`, so a coastal metro's biggest body of water (Houston's Galveston Bay / ship channel / the Gulf) was invisible to `body-of-water` — an area sitting IN the bay measured its nearest water as a far inland lake and read "further from water", and the nearest-reference label pointed outside the play area. The elimination (`measuring.ts`), the impact overlay (shares `bufferedDeterminer`), AND the label (`fetchNearestWater`) now fold in the bundled Natural Earth coastline as lines, clipped to the play-area frame (`clipLinesToBbox` in the elimination; a 3°-pad frame gate on `fetchNearestCoastline` in the label — matching the clip), so distance-to-sea buffers like distance-to-river and the sea can be the "nearest body of water". Inland cities clip to nothing → no-op. (The separate `coastline` measuring subtype still exists for the pure "distance to the coast" question; this just stops `body-of-water` from ignoring the sea.)

**Metro-routes relation endpoint (v701) — fixing a coastal dead-warm.** The tentacle **"Metro line"** question (`tentacles.ts`, `relation[route=subway][name]` → `out tags geom`) is prewarmed per city by the laptop (`metroRoutesQuery`, keyed off the RAW boundary extent). But the client built the same bbox query itself from the LAND-CLIPPED play-area extent (`referenceExtent()`), so on coastal cities (NYC/LA/SF/Sydney) its bbox drifted in the 3rd decimal → different R2 key → the prewarmed metro entry went unused and the client went live to Overpass. This is the exact pre-v386 transit bug, which was only fixed for transit. Now metro rides the SAME relation-ID pattern: **`GET /api/metro/<relationId>`** (`handleMetroByRelation`) derives the bbox SERVER-SIDE via `canonicalReferenceExtent` and rebuilds the identical `metroRoutesQuery` the laptop stored under. Client `fetchMetroRoutesData` (`tentacles.ts`) tries the endpoint first when the play area is a single OSM relation (no added adjacents), falling back to the live bbox query on a non-relation area / miss (firing `?warm=1` → `warmRelationMetro`). Byte-identical `metroRoutesQuery` now lives in three places (client `tentacles.ts`, worker `index.ts`, laptop) — the wrapper is hand-mirrored like the transit query.

**Two prewarm READ-path bugs fixed (v730) — "warmed but the app went live anyway."** A London game surfaced both: refs + transit failed in-app despite being warmed (the map PACK loaded fine because it's a plain static R2 file, never touching the Overpass path). Root causes were in the SERVE endpoints, not the warm:
- **`/api/transit/<id>/<mode>` missed for subway/ferry.** Those modes are stored ONLY as country-wide geographic SHARDS (`transit-routes/v1/<iso>/<mode>/all`, served by the slicing path), never per-city under the exact key — only `bus` (and coincidentally laptop-warmed `train`/`tram`) get a per-city exact entry. `handleTransitByRelation` did a single exact-key R2 lookup with NO shard fallback, so subway/ferry ALWAYS returned `cache:"miss"` → the client fell to the live `/api/interpreter` bbox query (which slices) AND fired `?warm=1` → a LIVE Overpass fetch on a warm city. Fix: `handleTransitByRelation` now calls `trySliceFromTransitShard` before the miss return (mirrors interpreter Step 2.6, `X-Cache: SLICED_RELATION`), so subway/ferry serve straight from the shard in R2.
- **`/api/refs/<id>` served an unparseable body for the biggest cities.** The laptop POSTs gzipped refs with `Content-Encoding: gzip`; Cloudflare's handling of a LARGE inbound gzip body is inconsistent (it decompressed London's body but left the header), so `handleAdminStorePrewarmed`'s streaming branch — which stored `request.body` verbatim and took the `encoding` metadata from that inbound header — wrote RAW JSON tagged `encoding:"gzip"`. `buildR2Response` then served it with `Content-Encoding: gzip`, so the client's `resp.json()` (and the browser) got a body that fails at byte 1 → the client silently fell back to live Overpass. This was invisible for MONTHS because the live fallback succeeded whenever Overpass was healthy; it only became visible under Overpass congestion. Fix: the laptop declares the gzip with a CUSTOM `X-Body-Encoding: gzip` header and sends NO `Content-Encoding` (so CF passes the body through verbatim); the worker reads `X-Body-Encoding ?? Content-Encoding`, keeping stored bytes + metadata in agreement. **Existing poisoned entries (large cities warmed pre-v730) EXIST in R2 so check-fresh skips them** — re-warm with the new laptop `--force` flag (`isFresh` returns false), e.g. `--only-city London --force`, or a full `--force` run.

Both endpoints are relation-id-keyed R2 reads (client `runBboxOverpassFetch` → `/api/refs/<id>` fan-out; `fetchTransitRoutesFeatures` → `/api/transit/<id>/<mode>` first), so a warmed city is served Overpass-free — these fixes make that hold for subway/ferry and for large-city refs.

**Double-gzip serve bug fixed (v738) — "warmed, R2 bytes correct, but the client still went live."** Follow-up to v730: even after the store-side gzip fix, a London game showed refs/transit failing in-app (`resp.json()` → `SyntaxError`) despite the map pack loading fine. Root cause was on the SERVE side, not the store: R2 stores the body as SINGLE gzip (confirmed byte-exact via the new **`GET /admin/inspect-encoding?id=<rel>&kind=<refs|stations|water|metro|transit-bus|transit-train|transit-tram>&secret=…`** — `handleAdminInspectEncoding` peels gzip layers off the raw stored bytes and returns `{verdict, layers, gzipLayers, encodingMetadata}`; London's refs read `stored-single-gzip (correct)`). The worker served that body with `Content-Encoding: gzip` and Cloudflare then **RE-COMPRESSED it on egress** — producing `gzip(gzip(json))` under one `Content-Encoding: gzip` header, so the browser's single transparent decompress left still-gzipped bytes → `resp.json()` failed → silent live-Overpass fallback (invisible for months, only surfacing under Overpass congestion). **`Cache-Control: no-transform` did NOT stop it** (CF ignores it for this), even with a cache-buster query param. Fix (serve-side, **no re-warm needed**): the worker now **serves PLAIN JSON with NO `Content-Encoding`**, so CF can apply at most its own single egress gzip, which the client decodes transparently — double-gzip is structurally impossible. Applied in BOTH serve paths: **`buildR2Response`** (the R2-hit path for every relation endpoint — refs/transit/water/metro/area-stations + interpreter R2 hits) and **`streamCompressIntoR2`** (the live-fetch miss path, which tees the PLAIN body — one branch compresses into R2, the other serves the client uncompressed). **`buildR2Response` PEELS EVERY gzip layer** (`readR2BodyAsPlainBytes` — loop `DecompressionStream("gzip")` while the body still starts with the gzip magic `1f 8b`, bounded to 4), because entries exist in THREE stored states across history: clean single gzip (correct), **DOUBLE gzip in R2** (a pre-v730 store poisoned by CF re-compressing the *inbound* upload — refs for a big city surfaced this: `transit` served fine because it's stored clean via `streamCompressIntoR2`, but `refs` from the laptop store were double-gzipped, so a decompress-*once* serve still left gzip bytes → same SyntaxError), and RAW JSON mis-tagged `encoding:"gzip"`. Peeling to plain serves ALL three correctly with no re-warm — the "extract once" self-heal. (Buffering the body here is fine: R2-hit warm path, reference-sized bodies; the OOM concern was only the multi-MB LIVE streaming fetch, which still streams.)

**v739 — the EDGE cache was the real hold-out.** After v738 refs STILL SyntaxError'd while transit worked, which was misleading: transit-subway serves via `trySliceFromTransitShard` (a fresh plain `JSON.stringify`, always was), so it never exercised buildR2Response and proved nothing about the fix. The actual leak: every relation handler (refs/stations/water/metro/transit) checks the **Cloudflare edge cache (`caches.default`) BEFORE R2** and re-served the hit via `appendCacheStatus` — which passes the cached Response's `Content-Encoding: gzip` straight through, so a poisoned edge entry double-gzipped on egress and NEVER reached buildR2Response's fix. Fix: **`serveEdgeHitNormalized`** reads the edge hit, peels every gzip layer (`peelGzipLayers`), and serves PLAIN — self-healing a poisoned edge entry the same way buildR2Response self-heals R2. Applied to all 5 relation handlers + the interpreter edge-hit. `readR2BodyText` (small-hit interpreter serve + abort sniff) also peels all layers now. Every serve path stamps an **`X-Serve` header** (`edge-plain; layers=N` / `r2-peel; enc=…; layers=N` / `r2-plain`) so devtools shows exactly which branch served a response and how many gzip layers it stripped — the diagnostic that ended the guessing. The laptop audit (`--audit-encoding`, `checkEndpointParse` in `laptop-prewarm.mjs`) classifies each endpoint's on-the-wire bytes (raw-body-tagged-gzip / gzip-body-tagged-identity / double-gzip / corrupt-gzip / ok) via node `https` raw reads; after the v738 deploy it should read clean with zero re-warming.

**Overpass soft-failure ("abort remark") handling (v667).** Overpass soft-fails: on a server-side time/memory limit it returns **HTTP 200** whose JSON carries `remark: "runtime error: Query timed out …"` with `elements` empty or silently truncated. Pre-v667 nothing checked `remark`, so one bad upstream moment got cached as a success — in the worker's R2 (30-day TTL) AND the browser Cache API — and every retry re-served "no stations in Chicago" (the "hiding zones say loaded but the map is empty" bug). Defences, all keyed on the same sniff (remark sits at the END of the JSON, so a cheap tail check gates the full parse): **worker** (`isAbortedOverpassText`, `overpass-cache/src/index.ts`) — the write path (`streamCompressIntoR2`) peeks bodies ≤256 KB and returns an aborted one to the client **uncached** (`Cache-Control: no-store`, `X-Cache: *_UNCACHED_ABORT`); the read path sniffs R2 hits ≤64 KB compressed and **deletes a poisoned entry + treats it as a miss** (self-heal for pre-fix entries; a clean small body is re-served from the decoded text since the sniff consumes the one-shot stream); the cron prewarms (`prewarmRelation`/`prewarmQuery`/HSR) refuse to store an aborted body (`upstream-aborted`). **Client** (`src/maps/api/overpassAbort.ts`, unit-tested in `tests/overpassAbort.test.ts`) — `getOverpassData` sniffs every racer's 200 body INSIDE the mirror race, so an aborted body (poisoned worker entry or live mirror timeout) counts as a per-mirror miss and fails over to the next tier, purging any Cache-API copy; the cache-first short-circuit self-heals the same way. **Consumers** — `fetchRawAreaStations` (`stations.ts`) and the seeker's `ZoneSidebar` compute use the `overpassFailureCount` before/after snapshot to tell a FAILED empty from a genuinely-empty result: failure now **throws** (→ error toast; and the ZoneSidebar signature cache is not recorded, so re-toggling retries), while `HiderReachOverlay` shows a deduped `toast.error` + null FC on failure vs. a `toast.info` + empty FC on a true zero.

**One prewarm list (v680).** The three-source sprawl (hand-curated array + `bulk-cities.json` + name-discovery R2 doc) collapsed into **TWO clean roles**: a static bundled **seed** — `overpass-cache/world-cities.json`, the top-N biggest cities worldwide (`{name, relationId, extent?, population?}`), regenerated by `overpass-cache/scripts/build-world-cities.mjs` (Wikidata population + OSM relation id, Photon-reconciled so ids match in-app search; run it on a machine that can reach Wikidata/Photon — CI egress blocks them; default MERGES into the existing file — `--replace` to overwrite. **Regional top-up (v690):** `--region na,eu` (or explicit `--continents Q49,Q46`) joins city→country→continent in the SPARQL to target just those continents, and `--new-limit N` caps the run to the N biggest cities NOT already seeded — e.g. `--region na --new-limit 100 --limit 400 --reconcile` appends the 100 biggest North-American cities the seed is missing. The early-stop means it only reconciles until N new are found, not the whole `--limit` buffer. **Country tag + player-region warming (v693):** each entry now carries a `country` (ISO 3166-1 alpha-2, from Wikidata P297 / an `all-the-cities` backfill for legacy entries) — because the pure-population seed is ~44% Asia / 20% China, which is NOT where a US-YouTube-show audience plays. The generator self-cleans same-city/different-id duplicates on every run (a legacy `"City, Country"` entry vs the reconciled `"City"` entry — Paris #7444 vs #71525 — collapsed by normalised name, keeping the with-population reconciled one). The laptop's **`--priority-regions US,CA,GB,IE,AU,NZ,DE,FR,…`** (default list = English-speaking + Western Europe + Nordics; bare flag uses it) warms the whole city list by region TIER (list order) then population within each tier, so the stars players actually use light up first while the seed stays globally complete; unknown-country cities warm last. Takes precedence over `--seed-first`. **Two-phase warming (v700):** the laptop default is now **PRIMARIES ONLY** — warm each curated city's own play area, verify → stamp `primaryCuratedAt` (the ⭐). Fast; every curated city earns its star. A second **`--adjacents`** pass (alias `--city-complete`, v696) then fills the adjacent-ready set city-by-city — per city it warms the primary (skip-if-fresh) + its adjacent areas as full play areas via the worker's REAL neighbour set (`/admin/city-neighbours`) and stamps `adjacentsCuratedAt`, so the app can offer "extend play area" for it. The legacy always-on one-ring pass (`processOneRing`/`findNeighbors`) is retired (its local admin_level-around discovery diverged from the star gate for megacities). Pairs with `--priority-regions` to light up whole player regions in order) — PLUS the R2 **growth/state doc** (`loadDiscoveredCities`), which now holds only (a) organic player-added areas and (b) per-city curation state (`extent`, `adjacentsCuratedAt`, `fullyCuratedAt`). `getPopularCities = mergeUnique(growth, SEED_CITIES)` (growth first so runtime state/extent wins; `mergeUnique` field-fills missing `extent`/stamps across duplicates, killing the old "extentless seed shadows an extent-bearing dup" bug). **No hand-correction/override layer** (v681): the generator resolves each city through the app's EXACT play-area ranking (a verbatim port of `geocode.ts`'s `rankPlayAreaResults` — MUST stay in sync), so every relation id is the one in-app search returns by construction; fix a wrong city at the source (regenerate), not with a parallel list. The legacy speculative name-discovery cron pass is **OFF by default** (`NAME_DISCOVERY_ENABLED="true"` to re-enable; `/admin/discover` still works manually). **Runtime growth:** when a player picks a play area not already in the set, the client `POST`s `/api/register-area {relationId, name}` (`REGISTER_AREA_URL`, fired from `playAreaPrefetch.ts`'s warm-on-add hook for the primary + every added adjacent); the worker (`handleRegisterArea`, public, guardrailed: idempotent, `bboxFromRelation`-validated, capped at `REGISTER_AREA_MAX_GROWTH`) derives the extent and upserts into the growth doc, so the cron then caches it (+ adjacents) and it eventually earns a star. That's how "the list grows as players use the app."

**Warm-city star (v642; meaning re-settled v700 = PRIMARY warm, with a separate adjacent-ready gate).** The play-area search (`PlayAreaStep` in `GameSetupDialog.tsx`) stars results that are cached so users can spot Overpass-free regions (v645: the star also shows on the SELECTED play-area summary card, not just the search-results list). **v700: a star means "the PRIMARY play area is fully cached"** — the worker (`handleWarmCities`) reports cities stamped `primaryCuratedAt` (the city's own boundary+refs+stations in R2), the *achievable* guarantee that a normal game on this city runs Overpass-free. This deliberately reverses the v679/v692 strict gate (star = primary + EVERY adjacent, `fullyCuratedAt`), which made big cities almost never star — one flaky neighbour blocked the whole city, so the map showed almost no stars for months. **The "broken promise" the strict gate guarded against (a starred city offers adding an un-warm adjacent → live Overpass mid-game) is now handled a BETTER way, decoupled from the star:** the wizard only shows the adjacent-add picker for a primary whose neighbours are ALL prewarmed, gated on the SEPARATE `/api/adjacent-ready-cities` set (stamped `adjacentsCuratedAt`). So a city can be starred and fully playable the moment its primary is warm, and it simply offers no "extend play area" option until its adjacents are warm too. Two orthogonal signals: ⭐ = primary warm (`warmCityIds`, `/api/warm-cities`); "can extend" = adjacents warm (`adjacentReadyIds`, `src/maps/api/adjacentReadyCities.ts`, `/api/adjacent-ready-cities`, gated in `PlayAreaExtensions.tsx` via `isAdjacentReady`). Both sets fetch once + cache in their atom; CDN/browser-cached 1 h. Escape hatches (precedence lenient > strict > default, `handleWarmCities`): `WARM_STAR_STRICT="true"` restores the v692 primary+adjacents star (`fullyCuratedAt`); `WARM_STAR_LENIENT="true"` is the loosest extent-only star (broader/sooner, NOT a cache guarantee). The operator's laptop-prewarm default now warms **primaries only** (every curated city earns its star fast); a second `--adjacents` (alias `--city-complete`) pass fills the adjacent-ready set city-by-city using the worker's real neighbour set. **Tile pack folded into the star (v725):** the star's `primaryCuratedAt` now ALSO requires the city's **tile pack** (`tile-packs/v1/<id>.pmtiles` in R2) — so a starred city's map preload always gets the one-shot pack, never the slow per-tile z14 range walk (the Nairobi report: starred but 798-tile range-walking because no pack was ever built). `diagnosePrimaryCuration` gained a `requirePack` param + a `packCached` field; it's passed `true` ONLY for the PRIMARY star path (`verifyAndStampCity`, gated by `WARM_STAR_REQUIRE_PACK` — default ON) and the `/admin/adjacent-curation-status` primary row (now pack-aware, exposes `packCached`), NEVER for adjacent neighbours (the generic `relationFullyCurated` leaves it off — neighbours don't get their own packs, so requiring one would break the adjacent gate). **Operational consequence: earning a star now needs the `--tile-packs` prewarm pass** (which shells out to the `go-pmtiles` binary); a primaries-only run without it warms the data but no longer stars the city. Set `WARM_STAR_REQUIRE_PACK="false"` to revert to data-only stars for a prewarm environment that can't build packs. Existing stamps are corrected on the next verify (cron re-verify / laptop `--verify-only` / `--tile-packs` run), so packless cities drop their star until a pack is built. **Tile packs are now a DEFAULT part of the laptop prewarm (v726)** — built for every city `processCity` handles, so the primaries pass packs each primary and the `--adjacents` pass (which runs `processCity` per neighbour) packs each adjacent too, making adjacents fully first-class play areas (data + pack). `DO_TILE_PACKS` flipped from opt-in `--tile-packs` to default-on with `--skip-tile-packs` opt-out (the old `--tile-packs` flag is a no-op alias). Still needs the go-pmtiles binary — absent, the startup check disables packs for the run and loudly warns that cities will earn NO star under the v725 gate. NOTE: packs are a LAPTOP-only build (the go binary can't run in a Cloudflare Worker), so the CRON warms data but can't produce a star on its own anymore — stars are earned by the laptop pack pass. (The client only loads the PRIMARY play area's pack today; an adjacent's pack is used when that municipality is picked directly as a play area, not yet when it's added as an extension — a future enhancement.) **Adjacents earn their OWN primary star (v727):** an adjacent can also be a valid primary (someone searches "the Bronx" directly). The `--adjacents` pass now verify+stamps EACH warmed neighbour (`verifyCity(n.relationId)` after `processCity(n)`), not just the parent primary — since the neighbour is fully warmed (boundary+refs+stations+pack, v726) and its extent/name are stored (`ensureCityExtent`), `verifyAndStampCity` stamps its `primaryCuratedAt`, so it flows into `/api/warm-cities` and shows a star when searched directly. **Auto-resolved basemap (v727):** the tile-pack builder no longer hard-codes the date-stamped master filename — `GET /api/basemap-url` (`handleBasemapUrl`) lists the newest `basemap-z15-*.pmtiles` in R2 and the laptop uses it as `MASTER_PMTILES_URL` unless `--master-pmtiles` is passed (falling back to the baked default on lookup failure). Bump the client's `DEFAULT_PMTILES_URL` in lockstep when uploading a new basemap so packs extract from the same archive the app renders.

**Adjacent-area full curation + star gate (v676).** A curated city's adjacent municipalities are now curated as first-class play-area members, not just outlined: the cron's Phase-4 `prewarmAdjacentSearchForCity` (`overpass-cache/src/index.ts`) warms each neighbour relation's **boundary + references + hiding-zone stations** (via the existing `warmRelationReferences` + `warmRelationAreaStations`, keyed on the same canonical relation-id keys the client reads via `/api/refs/<id>` and `/api/area-stations/<id>`) — so an "added adjacent area" loads Overpass-free exactly like the primary. Opt-OUT via `ADJACENT_CURATION_ENABLED="false"` (reverts to boundary-only, pre-v676). Once every neighbour is verified fully curated (a read-only `relationFullyCurated` R2-HEAD check on boundary+refs+stations; a no-neighbour city passes vacuously), the caller stamps `adjacentsCuratedAt` on the city's discovered-doc entry (`CityEntry`, `cities.ts`) — written only on state change, cleared on regression. The Phase-4 caller also verifies the PRIMARY itself (`relationFullyCurated(city.relationId)`) and stamps both `primaryCuratedAt` (primary alone cached — the **v700 star**) and `fullyCuratedAt` (primary + adjacents all cached). **v700: the default star gates on `primaryCuratedAt`, NOT `fullyCuratedAt`** — `adjacentsCuratedAt` instead feeds the separate `/api/adjacent-ready-cities` set that gates the adjacent-add UI (see the Warm-city star section above). `WARM_STAR_STRICT="true"` restores the v679/v692 fully-cached star; `WARM_STAR_LENIENT="true"` is the extent-only star. The laptop-prewarm's one-ring pass already fully curates neighbours offline, so the cron's verification passes fast for laptop-warmed cities. The neighbour set is derived ONCE by a shared read-only `deriveAdjacentNeighbourIds` (v677 — reads the cached topological+admin-band results) so the cron gate and the status readout below can't drift. **Progress readout: `GET /admin/adjacent-curation-status?secret=…&scope=seed|all|top&top=N&limit=M`** (v677, extended v679/v680; `scope=seed` = the top-N biggest seed cities) runs the exact server-side `relationFullyCurated` check (real boundary/refs/stations R2 keys — immune to the metadata-attribution gaps in `/admin/prewarmed-cities`) per curated city, on BOTH the primary and every adjacent, and reports `{scope, starMeaning, targets, probed, fullyCached, stampedFully, adjacencyUnknown, cities:[{name, relationId, hasExtent, primaryCached, adjacencyKnown, neighboursTotal, neighboursCurated, adjacentsCurated, fullyCached, stampedAdjacents, stampedFully}]}`. `fullyCached` (live) = `primaryCached && adjacentsCurated` — exactly the star gate; `stampedFully` = the `fullyCuratedAt` stamp actually written. `limit` caps the probe (default 60, max 200) to bound R2-op cost. **This is the authoritative "how many cities are star-eligible under the gate" number** — `/admin/prewarmed-cities` under-reports because `batched` references and on-demand (`warmRelation*`) warms carry no `sourceName` (they surface as `name:null` rows) and aren't attributed to their city.

**v684 — cron rate-limit protection + laptop-side stamping.** The heavier v676 curation was tripping Overpass's per-IP rate limit where the serial laptop prewarmer never did. Three cron-side fixes (`overpass-cache/src/index.ts`): (1) the Overpass slot gate `waitForOverpassSlot` now **skips on uncertainty by default** — when `/api/status` is unreachable or the wait-budget runs out it returns `false` (decline the fetch, catch it next tick) instead of proceeding blind; only the user-facing `fetchUpstreamStreaming` passes `proceedWhenUncertain:true` (a user is waiting). (2) A 500 ms inter-fetch **pacing floor** (`paceCronUpstream`) on the cron path, mirroring the laptop's `DELAY_MS`. (3) A **per-tick cap** on cold heavy adjacent curation — `ADJACENT_HEAVY_CITIES_PER_TICK` (default 4): only that many cities fully-curate their ~14 neighbours per tick (the rest still warm the cheap adjacency queries + neighbour boundaries and defer the heavy refs+stations), so one tick can't queue hundreds of cold fetches. **Laptop-side stars:** the star stamp is now one shared producer `verifyAndStampCity` used by BOTH the cron Phase-4 caller AND a new **`POST /admin/verify-city {relationId}`** (admin-secret) — so the laptop-prewarmer earns the star the instant it finishes a city rather than waiting for the cron to pick it. Laptop flags (`laptop-prewarm.mjs`): **`--seed-first`** (warm the biggest/seed cities first, in population order — reads `/api/seed-cities` + `orderSeedFirst`), a **verify pass ON by default** (`--skip-verify` to drop) that `POST`s `/admin/verify-city` for every processed city + one-ring neighbour after warming, and **`--verify-only`** (stamp stars for already-cached cities, no warming — run it right after a completed warm run to light up the map).

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
build stamp. Current: `v746`. Use `git log` for the per-version detail;
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
- **Adjacency comparison** at `/debug/adjacency` (v705, Topic-2 prototype)
  — for a searched city, runs BOTH the shipped ADMIN-adjacency selector
  (`findExtensionCandidates`, `playAreaExtensions.ts`: topological + admin-
  band neighbours filtered by a `hasMatchingTransit` bbox flag) AND a
  prototype TRANSIT-REACH selector (`findTransitReachCandidates`,
  `src/maps/api/transitReach.ts`) that inverts the question: fetch the
  primary's rail network (subway + light-rail + `route=train` excluding
  long-distance/high-speed — broad enough to catch differently-tagged local
  rail like Stockholm's Roslagsbanan to Täby, radius-bounded), take every
  stop those routes serve, and return the
  municipalities the stops land in (point-in-polygon against each
  candidate's real boundary) — literally "everywhere the subway / commuter
  train runs". Shows the two candidate sets side by side (in-both / rail-
  only / admin-only) so the idea can be eyeballed on Stockholm + presets
  before it's wired into the wizard. **Prefer few-large over many-small
  (v706):** a `candidate level` control (auto / 6 county / 7 / 8 city)
  targets a COARSER admin level so a metro returns a handful of counties
  instead of dozens of tiny suburbs (Chicago's annoyance); plus per-
  candidate area (km²), a `largest / most-stops / nearest` sort (default
  largest), min-stops + min-area sliders (cut the 1-2-stop slivers), and a
  **MapLibre preview** (v709) painting the reached municipalities as real
  boundary polygons — green = in both selectors, blue = rail-only additions —
  over the rail stops (amber dots) + the primary boundary (red), so a set can
  be judged geographically without knowing the city. Coterminous duplicates
  (NYC's Queens borough L7 vs Queens County L6) are collapsed by bbox-IoU, and NESTED candidates (Bronxville village inside Westchester County) drop the contained one, keeping only the container.
  **Enclave containment (v720):** an enclave (Kauniainen wholly inside Espoo)
  is an OSM HOLE in the container, so `booleanPointInPolygon(enclave, Espoo)`
  is false (centre in the hole) and dedup kept both — `centreInside` now tests
  the container's `fillHoles`ed outer ring. **Island-owning primaries (v721):**
  Tokyo owns the Izu/Ogasawara islands ~1000 km south; that region has a huge
  BBOX but little land, so `dropFarExclaves` (which ranked components by bbox
  area) treated it as the "largest" and its `bboxesNear` fallback kept the
  islands, dragging the query centroid to the open ocean (2 stops). Fixed:
  `dropFarExclaves` ranks components by TRUE geodesic area, and the query
  centroid anchors on the largest TRUE-area component (`largestComponentCentre`,
  the mainland) instead of the multi-component bbox midpoint.
  **NOT the default yet** — read-only inspector, writes no global state; the
  wizard still uses admin-adjacency.
- **Offline transit-reach adjacent generator** (v722,
  `overpass-cache/scripts/build-city-adjacents.mjs`) — the agreed Topic-2
  architecture: don't run the heavy transit-reach selection at wizard time,
  PRECOMPUTE it once offline and bake a FIXED `adjacentRelationIds: number[]`
  (new optional `CityEntry` field) onto each `world-cities.json` city. The
  wizard/cron/laptop then READ + cache exactly those relations (no runtime
  Overpass, no runtime selection). The script is a faithful node PORT of
  `findTransitReachCandidates` + its helpers (hand-synced, same coupling as
  `build-world-cities.mjs` porting `rankPlayAreaResults`) — Overpass over
  rotating mirrors (soft-timeout `remark` sniff), boundaries via
  `relation;out geom;` + `osmtogeojson`, turf for the geometry. Defaults mirror
  the validated debug-tool settings (radius 40 km, all six modes, primary's own
  admin level, min 2 stops, area cap 10×, min density 0.2/km², contiguous-only),
  all `--flag`-overridable; `--only`/`--limit`/`--skip-existing` for targeted or
  resumable runs; incremental save every 5 cities. Must run on a machine that
  can reach Overpass (CI/sandbox egress blocks it).
- **Baked adjacency consumers wired (v740, Topic 2; three-state contract v744).**
  Both consumers PREFER the baked `adjacentRelationIds`. **The field is
  THREE-STATE (v744 — a baked city NEVER falls back to live at wizard time):**
  ABSENT → not generated → fall back to live admin-adjacency; PRESENT but empty
  `[]` → generated + CANONICAL "no transit-reach neighbours" → show zero
  adjacents, NO fallback; PRESENT non-empty → show exactly that set. The
  generator (`build-city-adjacents.mjs`) writes the field ONLY on a successful
  run (an empty `[]` is a genuine result); a transient "0 stops"/"no boundary"
  fetch failure (usually upstream rate-limiting) leaves the field ABSENT, so a
  flaky run can't poison a real transit city with a canonical empty.
  `--skip-existing` therefore skips ANY present field (incl. `[]`) and retries
  only absent ones.
  - **Worker (star gate + warming):** `deriveAdjacentNeighbourIds`
    (`index.ts`) — the SINGLE producer every worker path funnels through (star
    gate `verifyAndStampCity`, cron Phase-4 neighbour warming, laptop
    `--adjacents` via `/admin/city-neighbours`, the status readout) — returns
    `city.adjacentRelationIds` verbatim (deduped, self-excluded,
    `adjacencyKnown:true`) whenever the field is a PRESENT array, INCLUDING an
    empty one (a canonical no-neighbours city is vacuously adjacent-curated →
    stamps `adjacentsCuratedAt`). Only an ABSENT field falls through to live.
    So the warmed set and the gated set are the baked set by construction, with
    zero runtime Overpass to derive them.
  - **Client (wizard):** `findExtensionCandidates` (`playAreaExtensions.ts`)
    first hits **`GET /api/city-adjacents/<relationId>`** (`handleCityAdjacents`,
    worker) — which resolves the baked ids into rendered candidates (name +
    extent from each neighbour's PREWARMED boundary in R2, area precomputed) and
    returns `{baked, requested, count, candidates}`. `fetchBakedAdjacentCandidates`
    returns `[]` for a canonical-empty baked city (`requested:0`) and the caller
    renders zero WITHOUT falling back; it returns `null` only when the city
    isn't baked (`baked:false`) OR on a transient warm gap (`requested>0` but 0
    boundaries resolved yet), both of which fall through to the live derivation.
    A neighbour whose boundary isn't cached yet is silently omitted (appears
    once warm). **The generated data is not committed to `world-cities.json`
    yet** — until it is, every city is `baked:false` and both consumers behave
    exactly as before; running `build-city-adjacents.mjs` + committing its
    output is what activates the baked path per city. **Coarsening (v743):** a
    fine-level (≥7) or unknown-level primary whose auto result exceeds
    `--max-adjacents` (20) re-queries at admin_level 6 (county) with the density
    floor AND area-ratio cap OFF (the cap is relative to the primary, so a small
    primary like Long Beach would otherwise drop its own huge county) — Long
    Beach → 3 counties, Miami → 2, LA → 3, Chicago → 5, instead of dozens of
    suburbs.
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
  `"always"` (no header there). **Invisible-launcher toggle (v745):** a
  persisted `debugLauncherHidden` atom (`debugState.ts`, key
  `jlhs:debugLauncherHidden`) renders BOTH launchers (`DebugLaunchButton`
  + the floating chip) `opacity-0` — invisible in demo screenshots but the
  hit target stays, so the panel is still reachable. Toggled by a checkbox
  inside `DebugPhaseControls` ("Hide launcher"), so you un-hide from the
  same panel you opened via the invisible button.

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
