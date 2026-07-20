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

**Stuck `body{pointer-events:none}` — one central guard (v785).** Radix's `DismissableLayer` (every modal Dialog/AlertDialog/Select/modal Popover) disables background interaction by setting `document.body.style.pointerEvents="none"` on the first modal open and restoring it on the last close, via a MODULE-LEVEL saved value. That desyncs — leaving the whole app frozen with no modal open — when a modal layer unmounts abruptly (a route change on role-pick, the lobby→in-game shell swap on a multiplayer push), when layers overlap (a Radix Dialog over a vaul Drawer captures `"none"` as the "original"), etc. **vaul only ever writes `"auto"` (never `"none"`), so Radix is the SOLE source of `"none"`** — which is what makes a reliable central fix possible. `src/lib/bodyPointerEventsGuard.ts` (`installBodyPointerEventsGuard`, called once from `main.tsx`, outside React so it survives route changes) observes `<body>`'s style + direct children and clears an ORPHANED lock (via `healBodyPointerEventsNow`) whenever `pointerEvents==="none"` but NO open Radix modal layer is in the DOM (`[role="dialog"|"alertdialog"|"menu"|"listbox"][data-state="open"]` or a `[data-radix-popper-content-wrapper]`). Debounced two rAFs so it never fights a mid-transition restore. Clearing is safe even in a rare false-negative because every Radix modal ALSO renders a full-screen Overlay that blocks outside clicks — the body lock is redundant belt-and-braces. **This replaced the four scattered per-component band-aids** (`useReleaseStuckBodyLock` [deleted], and the ad-hoc clears in `AddQuestionDialog`/`RolePicker`/`StationTransitCard`); don't add new local body-lock clears — the guard is the one place. (`AddQuestionDialog.promoteLastQuestion` keeps its picker→configure *sequencing* setTimeout, which avoids provoking the lock in the first place; that's orthogonal to the guard.)

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

**MOTIS multi-itinerary selection (v766).** MOTIS `/api/v1/plan` returns MULTIPLE ranked itineraries and frequently ranks a WALK-ONLY "direct" option first; `parseMotisPlan` used to take `itineraries[0]` blindly, so the planner surfaced a bogus "walking only" trip even though transit itineraries followed AND the departures board proved transit exists (the "sometimes falls back to walking" bug). It now parses EVERY itinerary and picks a mode-compliant transit-bearing one (honouring the request's `modes` allow-set so a banned-mode best itinerary doesn't shadow an allowed transit one MOTIS ranked lower), falling back to a walk itinerary only when no transit itinerary is available/allowed. Applies to both `transitous.ts` and the self-hosted MOTIS box (`motisSelfHosted.ts`), which share `planViaMotis`/`parseMotisPlan`.

**MOTIS access/egress walk budget (v768).** Follow-up to v766: a trip with a live departures board could STILL fall to a straight-line walking estimate. Departures only need the nearest stop (a geo lookup), but the plan must route DOOR-TO-DOOR — including the walk from the origin GPS to a stop and from the destination stop to the pin. MOTIS's default access/egress walk budget (~15 min) meant an origin/destination not right next to a stop yielded NO transit itinerary → walking backstop. `planViaMotis` now passes `maxPreTransitTime`/`maxPostTransitTime` = 1800 s (30 min each way) so MOTIS connects a farther origin/destination to the network; the upstream timeout was bumped 9 s → 12 s. Unknown params are ignored by MOTIS, so no regression on instances that predate the fields. NOTE: the request shape isn't unit-tested (only the parser is), so this is validated in production — if it ever regresses working routes, revert these two params first.
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

**Hider hiding-zones overlay** (`HiderReachOverlay.tsx` + `hiderReachFC` shadow atom): the hider's counterpart to the seeker's hiding-zones station field. Uses `fetchAreaStations` (**v751: NO station cap** — returns the WHOLE field, matching the seeker overlay which unions every circle uncapped off-thread. The old 180-cap + distance-from-hider-GPS trim was a pre-worker freeze guard that clustered a big metro's overlay around the hider and hid most of the play area — an NYC game showed only the Bronx/Queens, Manhattan/Brooklyn/Staten Island empty. Now that the hider union runs off-thread (v652) just like the seeker's (v663), the two are structurally identical and the cap is gone; **v661: play-area-keyed, not GPS-keyed** — it rides the seeker's `hidingZoneFiltersFor(allowedTransit)` → `findPlacesInZone` path with the exact ZoneSidebar argument shape, so the Overpass query is **byte-identical to the seeker's** and shares its R2 entry; the old `around:GPS` clauses made every position a unique query → guaranteed cache miss → live-Overpass rate limits even for starred cities, the same one-producer lesson as v640. GPS is only the client-side distance-sort anchor, so there's no re-fetch-on-movement deadband anymore) and paints the results via `HiderBackgroundMap` as name-labeled dots styled **identically to the seeker's `hiding-zones-*` layers** (single brand-red zoom-scaled dot + `Noto Sans` name label + invisible tap-target circle) PLUS a single **`safeUnion`-ed extent fill** (v650) — the union of every candidate zone's hiding-radius circle, painted once at a faint uniform opacity + dashed envelope, matching the seeker's `hiding-zones-fill`/`-line` (the point layers are geometry-filtered so the union polygon only feeds the fill/line). **The union runs OFF the main thread (v652)** in a Web Worker (`src/workers/hidingZonesUnion.worker.ts`, driven by `src/lib/journey/hidingZonesUnion.ts`): unioning hundreds of overlapping circles in a dense metro (Chicago's ~180 bus-stop circles) is a seconds-long `turf.union`, and doing it inline froze the whole app while the overlay loaded (v651 merely *bounded* it — still on-thread). So the union runs in the worker (no app-wide hitch), and the overlay reveals in **ONE update — dots + circles together after a single loading period, never staggered** (v653; the interim v652 painted dots first then dropped the fill in, which read as two loads). The worker builds **smooth 64-step circles + only a gentle `simplify`** (v660, matching the seeker's look — the interim 16-step + heavy simplify made blocky angular arcs) and unions ALL the stations (v751: the worker's `MAX_UNION_CIRCLES` slice cap was REMOVED — it unions every circle exactly like the seeker's `zonePipeline`, which never capped; the hider cap was a pre-worker artifact); requests are id-tagged + `AbortSignal`-cancelled so a stale result (hider moved / toggled off) is ignored; it degrades to dots-only where Workers aren't available or the union fails. (This is the repo's first Web Worker — Vite bundles it via the `new Worker(new URL(...), {type:"module"})` pattern.) The tapped-zone gets the seeker's **selected-zone highlight** (v660 — `hider-selected-zone-*` layers: white ring + fill + dot from `selectedMapStation` + `hidingRadius`, parity with the seeker map's `selected-zone-*`). Toggle in `HiderMapDisplayControls` ("Hiding zones"). Auto-disables once a zone is committed. **v643: reachability was REMOVED from the overlay** — it used to fan out a per-station `/api/journey/arrivals` call to colour-code reachable-vs-out-of-reach (green/red/amber), but that round-trip made the overlay slow + flaky ("hiding zones don't work well"). Whether a SINGLE tapped zone is reachable before the whistle is now an **on-demand, one-zone-at-a-time check in `StationTransitCard`**: it already plans the trip from live GPS to the tapped station, so it compares `journey.arriveAt` against `hidingPeriodEndsAt` and shows a colour-coded "Reachable in time / Out of reach" banner (with the arrival clock + minutes of slack) whenever the hiding period is still running. The card also shows a **live "Next departures" board** for the tapped stop (v644 — `fetchDepartures` → `/api/journey/departures`), so the hider can adapt on the fly; it's a separate stop-only fetch (independent of GPS). **Card layout (v648, v650):** progressive disclosure — the drawer opens compact (title + reachability banner + any seeker endgame action) and a **"Route & departures" expander** (tap toggle) reveals the full detail: a **Trip | Departures tab switcher** (trip = `JourneyCard`; departures = the board, using the shared `TRANSIT_ICONS` mode glyphs instead of text labels, with an upcoming-count badge on the tab). (A vaul snap-point / drag-to-expand version was tried in v650 but caused a hard UI freeze on some devices, so v651 reverted to the tap toggle; **v666 added a freeze-proof swipe-up gesture** — a plain touch-delta check on the card that expands on a ≥40 px upward flick, no vaul snap points. Down-drag stays vaul's dismiss.) **The card stays open on outside taps (v666)** — `onPointerDownOutside`/`onInteractOutside` preventDefault on the Content, so tapping another zone on the (non-modal) map behind it switches the selection in place instead of Radix dismissing the card. The planned trip is drawn on the map behind the (non-modal) card via the shared `tripRouteFC` overlay (`TripRouteLayers`, mounted on both maps). **`tripRouteFC` writes are ownership-tracked (v666, `useOwnedTripRoute`)** — three components write the atom, and the old unconditional `set(null)` on unmount/null-journey let any of them wipe a route another had just drawn (a "route never shows" bug); each writer now only clears the atom if it still holds its own FC. `journeyToRouteFC` also drops legs with non-finite or (0,0) endpoints so a parser's Null-Island default can't drag the route/fit across the globe. `HiderBackgroundMap` **fits the map to the route with a LIVE bottom inset** (v666): `StationTransitCard` publishes its measured drawer height to `stationCardInsetPx` (ResizeObserver), and the fit re-runs per (route, inset-bucket) with bottom padding = card height (clamped to 75% of the viewport) + the CURRENT GPS folded into the bounds — so the GPS dot + zone stay in the visible strip as the card opens/expands/collapses. A redundant **trailing access-walk leg is trimmed** (`trimTrailingAccessWalk`, v650) when the last transit leg already alights within ~350 m of the tapped station — planners append a "walk to the exact pin" that added fake travel time + a bogus final step. `JourneyCard` leg rows were enlarged (bigger icons + text). (Departure *line geometry* isn't overlaid — the departures API returns line names + times but no route shapes.)

**Hider trip-plan card** (`HiderTripPlanCard.tsx`): rendered inside `HiderHome`'s `hiding`/`grace` branches under the zone picker once `hidingZone` is set — calls `/api/travel/plan` from live GPS to the committed station, renders via the shared `JourneyCard`. **Plan-once + manual Refresh (v620):** both trip planners (hider card + seeker sheet) plan ONCE when a GPS fix first arrives and re-plan only on zone/destination change, mode change, or the `JourneyCard` **Refresh** button (which reads the current GPS via `lastKnownPosition.get()` at plan time). GPS coordinate changes are deliberately excluded from the plan effect's deps/signature (only a `hasGps` boolean drives the initial plan) — the earlier `useStableGpsOrigin` 150 m-threshold approach still re-planned constantly in dense cities where a stationary fix routinely jumps >150 m (urban multipath, reported in a Bucharest game). (`useStableGpsOrigin` was deleted in v662 — recover from git history if the threshold approach is ever wanted back.)

**Seeker trip planner** (`SeekerTripPlannerSheet.tsx`): Vaul drawer, text input → `forwardGeocodeOne` (or `lat,lng` paste) → `JourneyCard` for the journey from live GPS. Open state in `seekerTripPlannerOpen`. **v617: the "Search place" launcher pill was removed** (it sat top-right of the map) — the sheet stays mounted but currently has no in-app entry point; re-add a launcher if trip search is wanted back.

### Subtype picker (matching/measuring/tentacles)
`src/lib/subtypes.ts` defines `SUBTYPES` with `validSizes: GameSize[]` per entry. `-full` suffixed types (e.g. `aquarium-full`) are Small+Medium only — not available in Large games. Use `isSubtypeAllowed(value, size)` to filter dropdowns, `getSubtypes(categoryId, size)` for the step-2 picker tiles. Use `cleanDescription(desc)` to strip `" Question"` and `" (Small+Medium Games)"` suffixes from schema descriptions.

**Reference families + prewarm/cron (v625).** Matching/measuring reference POIs come from a "family" system: `STANDARD_REFERENCE_FAMILIES` (`playAreaPrefetch.ts`) is the canonical list warmed on play-area load, and it MUST stay byte-identical to the worker cron's `REFERENCE_FAMILY_FILTERS` (`overpass-cache/src/index.ts`) — the combined bbox query's hash is the shared R2 key. **Complete-cache guarantee (v685):** `runBboxOverpassFetch` returns `{elements, complete}` — `complete:true` ONLY when every play-area relation was a clean `/api/refs/<id>` R2 hit (served with zero live Overpass). On a complete result a family with 0 elements is AUTHORITATIVE (genuinely 0), so the preload records 0 and NEVER falls back to a live single-family query — a fully-prewarmed ("starred") city must never touch a public mirror mid-game. The per-family live re-fetch remains ONLY for `complete:false` (a cold area fell to the live/primary bbox query, where truncation is a real risk). Diagnose a wrongly-0 family for a warm city with **`GET /admin/inspect-refs?id=<rel>&secret=…`** (per-family element counts from the stored refs body) — a 0 there is a filter bug to fix at the source + re-warm, not a runtime live fallback (e.g. `["diplomatic"="consulate"]` misses `consulate_general`). To add a family: update `FamilyKey`, `STANDARD_REFERENCE_FAMILIES`, `filterForFamily`, `elementMatchesFamily`, `cacheableFamilyForType` (client) AND `REFERENCE_FAMILY_FILTERS` (worker) with the SAME filter string. **The `api:*` families derive their filter from ONE producer — `apiLocationFilter(loc)` / `apiLocationMatches(loc, tags)` in `constants.ts`** (used by `filterForFamily`, `elementMatchesFamily`, AND the matching/measuring elimination), so a per-location override lives in one place: **`consulate` = `["diplomatic"~"^consulate"]`** (v686 — catches `consulate` + `consulate_general`, excludes `honorary_consul`; the bare `="consulate"` found 0 in Oslo). The worker's `REFERENCE_FAMILY_FILTERS` consulate entry is kept byte-identical by hand. **Changing any reference filter changes the combined query string → new R2 key → ALL cities' refs entries orphan → stars drop and re-populate as cities re-warm** (the v686 consulate change requires a full refs re-warm). **Laptop self-heal (v700):** the offline `laptop-prewarm.mjs` kept a THIRD hand-mirror of these filters, and it silently missed the v686 consulate change — so every laptop-warmed city wrote its refs to the OLD key and failed the primary-star gate (`missing refs`) while the app read the new key and went live. Now the worker exposes the canonical set at **`GET /api/reference-filters`** (`handleReferenceFilters` — `referenceFilters`/`stationFilters`/`waterFilters` + their pads) and the laptop's `syncReferenceFilters()` fetches it at startup and OVERRIDES its local copies (loudly logging any drift it corrects), degrading to the now-correct local copies if the endpoint is unreachable. So the hand-mirror can't silently orphan a warm again; the worker is the single source of truth for the cache-key filter strings. **`body-of-water`** was tightened to MAJOR bodies only in v686 — `["natural"="water"]["name"]["water"!~"pond|basin|pool|fountain|wastewater|moat|tank|ditch"]` (in lockstep between `filterForFamily` and `measuring.ts`'s elimination fetch) to cut the pond/basin/pool noise that made it too heavy; still fetched lazily/isolated (not in the combined prewarm). Two families of note:
- **`rail-station`** (`["railway"="station"]`) backs the three station-property matching types, all **eliminated seeker-side** via one shared helper `matchingStationBoundary` (`matching.ts`, v625–v626): it Voronoi-partitions ALL stations and unions the cells of every station matching the seeker's nearest on the relevant property, so the map cut agrees with the hider's answer. **`same-train-line`** uses `trainLineNodeFinder` (same call the hider grades with); **`same-first-letter-station`** matches the first letter of the `name:en`/`name`; **`same-length-station`** is 3-way (`lengthComparison` equal/shorter/longer) — its boundary encodes the answer so `adjustPerMatching` always KEEPS the region (memo key includes `lengthComparison`). `same-first-letter-station`'s elimination is implemented but it is **not** in the subtype picker (v627) — it isn't a rulebook question (the rulebook only has "Station Name's Length"), and the picker mirrors the rulebook exactly. **Rulebook parity (v627): the app offers exactly the rulebook's questions — no more, no less** (Matching 20, Measuring 20, Radar 9 presets + Choose, Thermometer 1/5/15/75 by size, Photo 6/+8/+4 by size, Tentacles 4/+4 by size).
- **`body-of-water`** (`["natural"="water"]["name"]`) replaced the old Natural Earth 1:50m lakes bundle (v625) — that had ~411 major lakes and no rivers, so it found nothing at city scale. **NOT in the combined prewarm (v632):** `natural=water` matches huge multipolygon geometry (the Seine, canals, thousands of named ponds), so bundling it into the shared combined reference query timed the WHOLE reference set out upstream for dense metros — which broke the Paris cron prewarm and tripped Overpass rate limits on every Paris play-area pick. So `body-of-water` is deliberately **excluded from `STANDARD_REFERENCE_FAMILIES` + `REFERENCE_FAMILY_FILTERS`** and fetched LAZILY in isolation: `prefetchCategory` routes any family not in `STANDARD_FAMILY_SET` through `runSingleFamilyBboxFetch` (its own bbox query), so a heavy water scan can only slow its own on-demand fetch, never the shared prewarm. The isolated fetch holds `natural=water` centroids for the nearest-reference preview; the measuring ELIMINATION (`measuring.ts`) fetches full geometry (`natural=water` areas + named `waterway=river/canal` lines via `out geom`) so the seeker-distance buffer reflects real shore/bank distance. Rulebook p11: "any named body of water … excluding pools" (the `["name"]` filter enforces both). **Still isolated, but now PREWARMED (v687):** both consumers read the relation-keyed `GET /api/water/<id>` first (the `out geom` set served from R2) and only fall to the live isolated query on a cold miss — see the "Named-water prewarm (v687)" section below. The major-body `["water"!~"pond|basin|pool|fountain|wastewater|moat|tank|ditch"]` exclusion (v685) keeps a dense metro's water light enough to warm.

**Availability gating (v564):** `useSubtypeAvailability` (`src/lib/subtypeAvailability.ts`) greys out subtype tiles whose reference type has too few instances *inside the play area* to make a meaningful question — matching/tentacles need ≥2 (with one, everyone shares it), measuring needs ≥1. It counts via `countInPlayArea(family)` (`playAreaPrefetch.ts`, polygon-filtered cached features) for countable POI families only (airport, rail-station, `api:*` from `LOCATION_FIRST_TAG`); non-countable subtypes (admin divisions/borders, coastline, transit-line/name-length, metro, landmass, photo) and unknown/cold counts always stay enabled, so nothing valid is wrongly hidden. Relatedly, the **nearest-reference** lookup (`NearestReferencePreview.tsx`) filters every Overpass `around:`-radius fallback to the play-area polygon (`pointInPlayArea`) so an out-of-bounds instance can't win over a valid in-area one (rulebook p17).

**Self-hosting fetch paths (v639) — toward zero-Overpass for prewarmed cities.** Three changes closed the wizard/lobby-preview leaks the audit found: (1) **Boundary fetch is worker-first, CACHE-ONLY** — `doFetchRawBoundaryPolygon` (`polygonsOsmFr.ts`) tries the worker's R2 `relation(N);out geom;` (`fetchPolygonViaCacheWorker`, which passes **`?cacheOnly=1`**) BEFORE polygons.osm.fr, so a curated city's primary + neighbour boundaries paint from R2. **`cacheOnly=1` (v640) returns an edge/R2 hit (fresh or stale) or an instant empty `{elements:[]}` MISS — it NEVER goes upstream.** This is load-bearing: without it, worker-first sent every un-prewarmed neighbour's boundary to a LIVE Overpass query (the Madrid wizard fired ~14 `relation(N);out geom;` at overpass-api.de → 504s, and Cloudflare then 500'd the overloaded worker without CORS headers). With `cacheOnly`, an un-prewarmed area misses fast and the client falls to polygons.osm.fr (not Overpass); prewarmed neighbours self-warm only via the cron/laptop, not client traffic. (2) **Neighbour boundaries are prewarmed** — the cron's `prewarmAdjacentSearchForCity` (`overpass-cache/src/index.ts`) reads the topological + admin-band results it just stored, extracts up to `MAX_NEIGHBOUR_BOUNDARIES` (14) admin-boundary relation ids, and prewarms each via `singleRelationQuery` (byte-identical to the client's worker fetch). (3) **Adjacency `around:` centroid is relation-ID-keyed (v640), not client-derived** — the client fetches the ONE canonical extent from `GET /api/relation-extent/<id>` (`RELATION_EXTENT_BASE`; worker `handleRelationExtent` returns the stored `city.extent` via `getPopularCities`, the exact value `prewarmAdjacentSearchForCity`'s queries use, or a live `bboxFromRelation` for uncurated), and both sides take `((maxLat+minLat)/2, (minLng+maxLng)/2)` of that single value. This is the **v359 `/api/refs/<id>` pattern applied to adjacency**: one producer of the coordinate instead of two (client-bbox vs cron-bbox), so the `around:` string matches byte-for-byte with **no rounding** — replacing the earlier v639 3-dp-rounding band-aid (rounding two independently-derived numbers is the same anti-pattern v356/v359 killed for references). The builders in `playAreaExtensions.ts` ↔ `index.ts` are back to raw `${lat},${lng}` and kept byte-identical. **Transition caveat:** the query strings changed (rounded → raw), so existing prewarmed adjacency entries go stale and the cron re-warms under the new keys; until it catches up, adjacency cold-misses and falls through live (silently). **Laptop extent backfill (v640):** adjacency warming (cron *and* laptop) is gated on a city having a stored `city.extent`, which was previously cron-only (`upsertDiscoveredCity`, ~5 relations/tick). `POST /admin/store-city-extent {name, relationId}` (`handleAdminStoreCityExtent`, admin-secret) now derives it server-side via `bboxFromRelation` and upserts it, so `laptop-prewarm.mjs` (`ensureCityExtent`, called at the top of `processCity`) can fully bootstrap a brand-new city — extent → adjacency → references → boundaries → neighbours — in one run with no cron wait. The laptop's adjacency warm now keys off `city.extent` (the canonical value, matching the cron + client) rather than its boundary-geometry extent. **As of v665 the list of position-keyed live Overpass queries is EMPTY** — the last two (the hider map-tap `findNearestStation` fallback and `NearbyStationsPicker`'s 500 m `around:GPS` scan) now resolve against the game's own candidate-zone set via `findZonesNearPoint`/`findZoneAtPoint` (`src/lib/journey/stations.ts`): the shared play-area-keyed station fetch (byte-identical to the seeker's hiding-zones query, one R2 entry per game, in-module memoised + in-flight-coalesced) filtered client-side to the zones whose hiding-radius circle contains the point. Semantics improved too: a station of a disallowed mode or outside the play area is not a legal zone and no longer resolves; the picker header reads "Zones you're in". (Satellite tiles came off the external list in v664 — see the tile-overlays section.) **v750 correction:** one position-keyed query survived that claim — the **tentacle POI** finder (`findTentacleLocations`, `overpass.ts`) still fired `nwr[...](around:radius,lat,lng)` per tentacle centre (unique string → guaranteed R2 miss → live Overpass → the rate-limit errors when asking a tentacle question). Fixed by reading the prewarmed `api:*` reference family (`cacheableFamilyForType(locationType)` → `prefetchCategory` → R2 hit for a warm city) and filtering to the tentacle radius client-side, gated on `pointInsideCacheCoverage`; the live `around:` query remains only as the cold-city / out-of-coverage fallback.

**Hiding-zone station prewarm (v668) — the last un-prewarmed hiding-zones surface.** The hider's "Hiding zones" overlay + the zone-containment lookups (`findZonesNearPoint`/`findZoneAtPoint`) fetch the candidate STATION field, which is a distinct Overpass query from anything the prewarm warmed: `hidingZoneFiltersFor(allowed)` is a multi-mode union of STOP selectors (`railway=station`, `highway=bus_stop`, `railway=tram_stop`, ferry, …) — NOT the reference-family `rail-station` (`["railway"="station"]`) nor the transit-ROUTE shards. So it only ever cached ON-DEMAND after a first live fetch — and that first fetch is the heaviest possible query (`bus_stop` across a whole metro), which is exactly what soft-timed-out for Chicago. Now it's prewarmed by the SAME relation-ID-keyed pattern as `/api/refs`: **`GET /api/area-stations/<relationId>`** (`handleAreaStationsByRelation`) derives the boundary-geometry extent (`canonicalReferenceExtent`, the identical drift-free extent references use), rebuilds the ONE combined all-mode station bbox query (`buildAreaStationsBboxQuery`, `AREA_STATION_FILTERS`, 2 km pad, `[timeout:180]`), and serves the R2 entry — so the client never builds a byte-fragile query (zero cross-codebase drift). Warmed per-city by the cron (**Phase 2b**, `prewarmAreaStationsForCity`, isolated NOT batched — the bus clause is too heavy to bundle, same lesson as `body-of-water` v632; opt-out `AREA_STATIONS_PREWARM_ENABLED="false"`), the laptop (`areaStationsQuery` in `laptop-prewarm.mjs`, byte-identical to the worker builder), and on-demand via `?warm=1` (`warmRelationAreaStations`, boundary-ensure → derive extent → abort-guarded store). Client: `fetchRawAreaStations` (`stations.ts`) tries the prewarm endpoint FIRST (all modes → filtered client-side to the allowed set), falling back to the live poly `findPlacesInZone` query on miss (and firing `requestStationWarm` so the next load is warm). All warm/prewarm paths refuse to store an abort-remark body (v667). **The SEEKER's `ZoneSidebar` is routed through it too (v669)** — `fetchPrewarmedHidingZoneStations(options)` serves the endpoint when `$displayHidingZonesOptions` map EXACTLY to a whole-mode subset (`modesForExactOptions` — the common auto-tracking case; any partial-mode or custom/non-mode pick declines to the live poly query), returning an Overpass-shaped `{elements}` fed straight to `osmtogeojson`. **Added adjacent areas are first-class on the fast path (v670):** the endpoint is FANNED over EVERY play-area relation id (primary + each added adjacent area — `playAreaRelationIdsAll`, mirroring `playAreaRelationIds().all`) and UNIONed (`fetchPrewarmedStationsUnion`), so an added area is prewarmed/served just like the primary. Each per-relation entry is a 2 km-PADDED bbox superset, so the union is culled to the combined play-area polygon (`cullElementsToPlayArea`, matching the poly query's clipping — no out-of-area stations). The endpoint is used ONLY when EVERY area is warm (miss detected via the endpoint's `cache` marker, distinct from a warmed-but-empty area); any cold area is `?warm=1`-background-warmed and the whole set falls to the live poly query (built from the combined polygon, so it covers the union). The live poly path keeps the v667 all-mirrors-failed detection; the endpoint path can't fail that way (it never touches Overpass). Not-yet-prewarmed added areas rely on the on-demand `?warm=1` (`warmRelationAreaStations` warms any relation id), the same as references. **Bus PTv2 broadening (v723):** the `bus` mode selector was `[highway=bus_stop]` only, so cities that map bus stops purely as PTv2 (`public_transport=platform` + `bus=yes`, no `highway=bus_stop`) showed ZERO bus hiding zones even with a dense bus overlay (reported on Nairobi's matatu network). `HIDING_ZONE_FILTERS_BY_MODE.bus` (client `gameSetup.ts`) is now `["[highway=bus_stop]", "[public_transport=platform][bus=yes]"]`, mirrored into the worker's `AREA_STATION_FILTERS` (`index.ts`) AND the laptop's byte-identical copy (`laptop-prewarm.mjs`; also auto-synced from `/api/reference-filters`'s `stationFilters`). Mode classification already maps `bus=yes` → bus (`inferStationMode`, `stations.ts inferMode`), so the new platforms are kept when bus is allowed and dropped otherwise. **This changes the combined `AREA_STATION_FILTERS` query string → new R2 key → all prewarmed `area-stations` entries orphan and re-warm** (same one-producer cache-key coupling as the reference filters); the live poly path (uncurated cities) fixes immediately, while a STARRED city (Nairobi) misses the new key → falls to the live poly query (which shows bus) + re-warms, and its star briefly drops until the cron/laptop re-warms the new key. **All-mode PTv2 audit (v724):** the same PTv2-platform gap was swept across every mode. **tram** gained `[public_transport=platform][tram=yes]` (networks that map tram stops only as PTv2 platforms; safe because a tram stop is a single platform, unlike multi-platform heavy rail). **ferry** gained `[public_transport=platform][ferry=yes]` — the documented PTv2 flag — since the pre-existing `[public_transport=platform][platform=ferry]` used a NON-standard tag that matched almost nothing (`platform=ferry` kept for the rare city that used it). **train/subway deliberately get NO platform selector** — a multi-platform station would explode into per-platform zones (distinctly-named platform ways don't dedup), and PTv2-only heavy rail/metro is rare, so legacy `railway=station`/`halt`/`subway=yes` still covers them. The prewarm-path classifier `stations.ts inferMode` was ALSO missing `tram=yes`/`ferry=yes`/`train=yes` (it would fetch the new platforms then drop them as unclassified) — now completed to mirror `stationManipulations.inferStationMode`. All additions land in the SAME `AREA_STATION_FILTERS` re-warm as the bus change (client `gameSetup.ts` + worker `index.ts` + laptop mirror).

**Named-water prewarm (v687) — the last per-question-type live hole.** The measuring **body-of-water** ELIMINATION needs full `out geom` water geometry (lake/reservoir shores + named river/canal centrelines) to buffer by seeker-distance — the single heaviest reference family in a dense metro, which is exactly why it's kept OUT of the combined refs query (v632) and why it soft-timed-out live on Paris. It's now prewarmed by the SAME relation-ID-keyed pattern as `/api/area-stations`: **`GET /api/water/<relationId>`** (`handleWaterByRelation`) derives the canonical boundary-geometry extent, rebuilds the one water query (`buildWaterBboxQuery`, `WATER_FILTERS` = the major-body **named** `natural=water` polygon filter + the `waterway~^(river|canal)$` line filter **with NO `["name"]`** (v690 — OSM tags a river's name on only some segments, so per-segment name-gating left the overlay skipping unnamed segments of an obvious river; rivers/canals are bodies of water even unnamed, and the type filter still excludes drains/streams/ditches — named-only stays on the polygon filter so unnamed ponds don't flood in), 2 km pad, `[timeout:180]`, `out geom`), and serves the R2 entry — client never builds a byte-fragile query. `WATER_FILTERS` MUST stay byte-identical to `measuring.ts`'s live-fallback filters AND `filterForFamily("body-of-water")`. Warmed per-city by the cron (**Phase 2c**, `prewarmWaterForCity`, isolated NOT batched — same heaviness lesson as stations/v632; opt-out `WATER_PREWARM_ENABLED="false"`), the laptop (`waterQuery` in `laptop-prewarm.mjs`, byte-identical to the worker builder; `--skip-water` to drop; runs for one-ring neighbours too), and on-demand via `?warm=1` (`warmRelationWater`, boundary-ensure → derive extent → abort-guarded store). Client (`src/maps/api/water.ts`): `fetchPrewarmedAreaWater()` fans the endpoint over EVERY play-area relation (primary + added adjacent) and UNIONs (deduped by `type/id`), used ONLY when every area is warm (miss via the `cache` marker); any cold area is `?warm=1`-warmed and BOTH consumers fall to the live query — the `measuring.ts` elimination poly query (`requestWaterWarmAll` after) AND the point-cache `runSingleFamilyBboxFetch("body-of-water")` (nearest-reference preview + availability count, deriving a representative point per `out geom` body via `featureFromGeomElement`). The union is a 2 km-padded bbox SUPERSET, deliberately NOT culled to the polygon — a shore just outside the boundary is still the nearest body of water (rulebook p17), and the elimination buffers geometry anyway. **NOT yet in the star gate** (`relationFullyCurated` still checks boundary+refs+stations only): water warming's reliability on the hardest metros is being verified before the star depends on it, so a starred city still self-warms water on first use (the one remaining first-game live fetch for this type). **Nearest-reference preview fixed (v688):** the body-of-water configure-card "Your nearest reference" label used to read the `natural=water` CENTROID point-cache — which ignored rivers (mapped as `waterway` LINES, never in that cache) and measured a lake from its middle, so a river 1 km away lost to a pond 3 km away named "Public Park". `fetchNearestWater` (`NearestReferencePreview.tsx`) now reads the SAME full `out geom` geometry the elimination buffers (`fetchPrewarmedAreaWater` first, live poly fallback) and returns the true closest point on any shore/river/canal via `polygonToLine` + `nearestPointOnLine` (like the coastline fetcher), so the label agrees with the actual answer. The elimination was already correct; this was a display-only mismatch, but a wrong reference label undermines trust. **Impact overlay fixed (v689):** the configure-card closer/further impact overlay (`questionImpact.ts`) had the SAME centroid bug in a THIRD place — it buffered the `natural=water` centroid point-cache, so it drew big circles around distant lake/pond centres and marked areas far from any shore as "closer", disagreeing with both the real cut and the label. For `body-of-water` the overlay now reuses `measuringDraftBuffer` (`measuring.ts`) — the exact memoised `bufferedDeterminer` buffer the elimination keeps — so preview, label, and answer are finally one geometry. Every other measuring family is a genuine point set, so it keeps the centroid buffer (exact there). **Sea/bay inclusion (v702):** OSM tags the open sea and large bays as `natural=coastline` (a SEPARATE family), NOT `natural=water`, so a coastal metro's biggest body of water (Houston's Galveston Bay / ship channel / the Gulf) was invisible to `body-of-water` — an area sitting IN the bay measured its nearest water as a far inland lake and read "further from water", and the nearest-reference label pointed outside the play area. The elimination (`measuring.ts`), the impact overlay (shares `bufferedDeterminer`), AND the label (`fetchNearestWater`) now fold in the bundled Natural Earth coastline as lines, clipped to the play-area frame (`clipLinesToBbox` in the elimination; a 3°-pad frame gate on `fetchNearestCoastline` in the label — matching the clip), so distance-to-sea buffers like distance-to-river and the sea can be the "nearest body of water". Inland cities clip to nothing → no-op. (The separate `coastline` measuring subtype still exists for the pure "distance to the coast" question; this just stops `body-of-water` from ignoring the sea.) **Sea-as-AREA + detailed coastline prewarm (v770/v776):** buffering the coastline as thin LINES only covered a band near the shore, so OPEN water beyond the seeker's distance was wrongly "further from water" (impossible — it IS water). The elimination now builds the sea as an **AREA**: `seaFromCoastline` (`src/maps/questions/seaFromCoastline.ts`, unit-tested) nodes the coastline against the play-area frame, `turf.polygonize`s it into faces, and labels water by the OSM **right-of-way rule** (land-left / water-right of the way direction; `out geom` preserves direction), unioning the water faces. It self-guards — returns null (→ caller falls back) if the seeker ends up inside the sea (inverted winding) or the sea covers ~the whole frame. The **1:50m Natural Earth coastline was too coarse for a metro** (NYC's harbour + tidal rivers stayed "further"), so v776 prewarms the **detailed OSM `natural=coastline`** per city via **`GET /api/coast/<relationId>`** (`handleCoastByRelation`, mirrors `/api/water` exactly — `COAST_FILTERS`/`buildCoastBboxQuery`, 2 km pad, `out geom`; cron **Phase 2d** `prewarmCoastForCity` opt-out `COAST_PREWARM_ENABLED="false"`; laptop `coastQuery`; `?warm=1` → `warmRelationCoast`; `coastFilters` in `/api/reference-filters` for laptop sync). Client `src/maps/api/coast.ts` `fetchPrewarmedAreaCoast()` fans over every play-area relation. `measuring.ts` body-of-water tries the DETAILED coast → `seaFromCoastline` first, falls back to the coarse 1:50m sea (v770, frame minus `lineToPolygon` land, seeker-not-in-sea guard), then to the thin coastline band — so it only ever improves or no-ops, never corrupts (each layer is guarded). **NOT in the star gate** (like water). **Full per-city-coast migration (v778):** ALL coast consumers now prefer per-city OSM coastline, with the bundled 1:50m `coastline50.geojson` kept ONLY as a last-resort fallback (rulebook p18: only coast WITHIN the play area exists, which is exactly what the per-city fetch returns; the global bundle is far too coarse for a metro). The shared fetch is `src/maps/api/coast.ts` **`fetchAreaCoastlineLines()`** — prewarmed `/api/coast/<id>` (R2, warm cities) → a live `way["natural"="coastline"]` play-area Overpass query (cold cities; the v776 `fetchPrewarmedAreaCoast` already fired `?warm=1` so the NEXT game is warm) → returns `null` only on total failure so the CONSUMER falls to the global bundle. Successful results are session-cached per relation-id set (a `null` failure is evicted so it retries). **`fetchAreaLandPolygons(seeker)`** builds per-city LAND = the play-area frame MINUS `seaFromCoastline(...)`, returning `null` on any degeneracy/guard-reject. Consumers: (1) **`same-landmass`** (`matching.ts`) walks `fetchAreaLandPolygons` parts for the one containing the seeker (each part = a distinct landmass within the frame, so NYC's East River / harbour correctly splits Manhattan / Brooklyn+Queens / Bronx / Staten Island), falling back to closing the global bundle into land. (2) The **`coastline` subtype** (`measuring.ts`) was rebuilt to treat coast like the **border cases** — return the per-city coastline LINES (MultiLineStrings flattened) and let `arcBufferToPoint` buffer them by the seeker's distance (the old close-into-land-polygon + `difference` construction relied on the coarse bundle and only worked because the buffer collapsed to ~0); global-clipped lines are the fallback. (3) **body-of-water** now uses the shared `fetchAreaCoastlineLines()` (so an un-warmed coastal metro gets the detailed sea via the live fallback, not just the coarse 1:50m). (4) The **nearest-coast label** (`fetchNearestCoastline`, `NearestReferencePreview.tsx`) scans per-city coastline lines first (so the label agrees with the elimination), falling back to the global scan. `coastline50.geojson` is retained (still used as the guarded fallback everywhere), so nothing breaks where per-city coast is unavailable.

**Metro-routes relation endpoint (v701) — fixing a coastal dead-warm.** The tentacle **"Metro line"** question (`tentacles.ts`, `relation[route=subway][name]` → `out tags geom`) is prewarmed per city by the laptop (`metroRoutesQuery`, keyed off the RAW boundary extent). But the client built the same bbox query itself from the LAND-CLIPPED play-area extent (`referenceExtent()`), so on coastal cities (NYC/LA/SF/Sydney) its bbox drifted in the 3rd decimal → different R2 key → the prewarmed metro entry went unused and the client went live to Overpass. This is the exact pre-v386 transit bug, which was only fixed for transit. Now metro rides the SAME relation-ID pattern: **`GET /api/metro/<relationId>`** (`handleMetroByRelation`) derives the bbox SERVER-SIDE via `canonicalReferenceExtent` and rebuilds the identical `metroRoutesQuery` the laptop stored under. Client `fetchMetroRoutesData` (`tentacles.ts`) tries the endpoint first when the play area is a single OSM relation (no added adjacents), falling back to the live bbox query on a non-relation area / miss (firing `?warm=1` → `warmRelationMetro`). Byte-identical `metroRoutesQuery` now lives in three places (client `tentacles.ts`, worker `index.ts`, laptop) — the wrapper is hand-mirrored like the transit query.

**Two prewarm READ-path bugs fixed (v730) — "warmed but the app went live anyway."** A London game surfaced both: refs + transit failed in-app despite being warmed (the map PACK loaded fine because it's a plain static R2 file, never touching the Overpass path). Root causes were in the SERVE endpoints, not the warm:
- **`/api/transit/<id>/<mode>` missed for subway/ferry.** Those modes are stored ONLY as country-wide geographic SHARDS (`transit-routes/v1/<iso>/<mode>/all`, served by the slicing path), never per-city under the exact key — only `bus` (and coincidentally laptop-warmed `train`/`tram`) get a per-city exact entry. `handleTransitByRelation` did a single exact-key R2 lookup with NO shard fallback, so subway/ferry ALWAYS returned `cache:"miss"` → the client fell to the live `/api/interpreter` bbox query (which slices) AND fired `?warm=1` → a LIVE Overpass fetch on a warm city. Fix: `handleTransitByRelation` now calls `trySliceFromTransitShard` before the miss return (mirrors interpreter Step 2.6, `X-Cache: SLICED_RELATION`), so subway/ferry serve straight from the shard in R2.
- **`/api/refs/<id>` served an unparseable body for the biggest cities.** The laptop POSTs gzipped refs with `Content-Encoding: gzip`; Cloudflare's handling of a LARGE inbound gzip body is inconsistent (it decompressed London's body but left the header), so `handleAdminStorePrewarmed`'s streaming branch — which stored `request.body` verbatim and took the `encoding` metadata from that inbound header — wrote RAW JSON tagged `encoding:"gzip"`. `buildR2Response` then served it with `Content-Encoding: gzip`, so the client's `resp.json()` (and the browser) got a body that fails at byte 1 → the client silently fell back to live Overpass. This was invisible for MONTHS because the live fallback succeeded whenever Overpass was healthy; it only became visible under Overpass congestion. Fix: the laptop declares the gzip with a CUSTOM `X-Body-Encoding: gzip` header and sends NO `Content-Encoding` (so CF passes the body through verbatim); the worker reads `X-Body-Encoding ?? Content-Encoding`, keeping stored bytes + metadata in agreement. **Existing poisoned entries (large cities warmed pre-v730) EXIST in R2 so check-fresh skips them** — re-warm with the new laptop `--force` flag (`isFresh` returns false), e.g. `--only-city London --force`, or a full `--force` run.

Both endpoints are relation-id-keyed R2 reads (client `runBboxOverpassFetch` → `/api/refs/<id>` fan-out; `fetchTransitRoutesFeatures` → `/api/transit/<id>/<mode>` first), so a warmed city is served Overpass-free — these fixes make that hold for subway/ferry and for large-city refs.

**Double-gzip serve bug fixed (v738) — "warmed, R2 bytes correct, but the client still went live."** Follow-up to v730: even after the store-side gzip fix, a London game showed refs/transit failing in-app (`resp.json()` → `SyntaxError`) despite the map pack loading fine. Root cause was on the SERVE side, not the store: R2 stores the body as SINGLE gzip (confirmed byte-exact via the new **`GET /admin/inspect-encoding?id=<rel>&kind=<refs|stations|water|metro|transit-bus|transit-train|transit-tram>&secret=…`** — `handleAdminInspectEncoding` peels gzip layers off the raw stored bytes and returns `{verdict, layers, gzipLayers, encodingMetadata}`; London's refs read `stored-single-gzip (correct)`). The worker served that body with `Content-Encoding: gzip` and Cloudflare then **RE-COMPRESSED it on egress** — producing `gzip(gzip(json))` under one `Content-Encoding: gzip` header, so the browser's single transparent decompress left still-gzipped bytes → `resp.json()` failed → silent live-Overpass fallback (invisible for months, only surfacing under Overpass congestion). **`Cache-Control: no-transform` did NOT stop it** (CF ignores it for this), even with a cache-buster query param. Fix (serve-side, **no re-warm needed**): the worker now **serves PLAIN JSON with NO `Content-Encoding`**, so CF can apply at most its own single egress gzip, which the client decodes transparently — double-gzip is structurally impossible. Applied in BOTH serve paths: **`buildR2Response`** (the R2-hit path for every relation endpoint — refs/transit/water/metro/area-stations + interpreter R2 hits) and **`streamCompressIntoR2`** (the live-fetch miss path, which tees the PLAIN body — one branch compresses into R2, the other serves the client uncompressed). **`buildR2Response` PEELS EVERY gzip layer** (`readR2BodyAsPlainBytes` — loop `DecompressionStream("gzip")` while the body still starts with the gzip magic `1f 8b`, bounded to 4), because entries exist in THREE stored states across history: clean single gzip (correct), **DOUBLE gzip in R2** (a pre-v730 store poisoned by CF re-compressing the *inbound* upload — refs for a big city surfaced this: `transit` served fine because it's stored clean via `streamCompressIntoR2`, but `refs` from the laptop store were double-gzipped, so a decompress-*once* serve still left gzip bytes → same SyntaxError), and RAW JSON mis-tagged `encoding:"gzip"`. Peeling to plain serves ALL three correctly with no re-warm — the "extract once" self-heal. (Buffering the body here is fine: R2-hit warm path, reference-sized bodies; the OOM concern was only the multi-MB LIVE streaming fetch, which still streams.)

**v739 — the EDGE cache was the real hold-out.** After v738 refs STILL SyntaxError'd while transit worked, which was misleading: transit-subway serves via `trySliceFromTransitShard` (a fresh plain `JSON.stringify`, always was), so it never exercised buildR2Response and proved nothing about the fix. The actual leak: every relation handler (refs/stations/water/metro/transit) checks the **Cloudflare edge cache (`caches.default`) BEFORE R2** and re-served the hit via `appendCacheStatus` — which passes the cached Response's `Content-Encoding: gzip` straight through, so a poisoned edge entry double-gzipped on egress and NEVER reached buildR2Response's fix. Fix: **`serveEdgeHitNormalized`** reads the edge hit, peels every gzip layer (`peelGzipLayers`), and serves PLAIN — self-healing a poisoned edge entry the same way buildR2Response self-heals R2. Applied to all 5 relation handlers + the interpreter edge-hit. `readR2BodyText` (small-hit interpreter serve + abort sniff) also peels all layers now. Every serve path stamps an **`X-Serve` header** (`edge-plain; layers=N` / `r2-peel; enc=…; layers=N` / `r2-plain`) so devtools shows exactly which branch served a response and how many gzip layers it stripped — the diagnostic that ended the guessing. The laptop audit (`--audit-encoding`, `checkEndpointParse` in `laptop-prewarm.mjs`) classifies each endpoint's on-the-wire bytes (raw-body-tagged-gzip / gzip-body-tagged-identity / double-gzip / corrupt-gzip / ok) via node `https` raw reads; after the v738 deploy it should read clean with zero re-warming.

**Overpass soft-failure ("abort remark") handling (v667).** Overpass soft-fails: on a server-side time/memory limit it returns **HTTP 200** whose JSON carries `remark: "runtime error: Query timed out …"` with `elements` empty or silently truncated. Pre-v667 nothing checked `remark`, so one bad upstream moment got cached as a success — in the worker's R2 (30-day TTL) AND the browser Cache API — and every retry re-served "no stations in Chicago" (the "hiding zones say loaded but the map is empty" bug). Defences, all keyed on the same sniff (remark sits at the END of the JSON, so a cheap tail check gates the full parse): **worker** (`isAbortedOverpassText`, `overpass-cache/src/index.ts`) — the write path (`streamCompressIntoR2`) peeks bodies ≤256 KB and returns an aborted one to the client **uncached** (`Cache-Control: no-store`, `X-Cache: *_UNCACHED_ABORT`); the read path sniffs R2 hits ≤64 KB compressed and **deletes a poisoned entry + treats it as a miss** (self-heal for pre-fix entries; a clean small body is re-served from the decoded text since the sniff consumes the one-shot stream); the cron prewarms (`prewarmRelation`/`prewarmQuery`/HSR) refuse to store an aborted body (`upstream-aborted`). **Client** (`src/maps/api/overpassAbort.ts`, unit-tested in `tests/overpassAbort.test.ts`) — `getOverpassData` sniffs every racer's 200 body INSIDE the mirror race, so an aborted body (poisoned worker entry or live mirror timeout) counts as a per-mirror miss and fails over to the next tier, purging any Cache-API copy; the cache-first short-circuit self-heals the same way. **Consumers** — `fetchRawAreaStations` (`stations.ts`) and the seeker's `ZoneSidebar` compute use the `overpassFailureCount` before/after snapshot to tell a FAILED empty from a genuinely-empty result: failure now **throws** (→ error toast; and the ZoneSidebar signature cache is not recorded, so re-toggling retries), while `HiderReachOverlay` shows a deduped `toast.error` on failure vs. a `toast.info` on a true zero. **Overlay-toggle honesty (v782):** any overlay effect that reaches a terminal "can't/shouldn't draw" outcome now turns its TOGGLE atom OFF, not just clears its FC — so a Map-options button never reads ON over an empty map (the reported "hiding zones say on but nothing's drawn" state). `HiderReachOverlay` turns `showHiderReach` off on every non-loading terminal path (no clock / **zone committed** / past whistle / fetch-failed / genuinely-empty); `TravelTimesOverlay` turns `showTravelTimes` off on its definitive game-level can't-draw paths (no journey provider / no start-GPS). The only non-drawing state that legitimately keeps a toggle ON is LOADING (spinner + loading pill). Setting the toggle atom off re-runs the effect into its `!enabled` branch, which settles. (The seeker `ZoneSidebar` overlay keeps the deliberate v667 keep-on-and-retry-on-re-toggle behaviour — its failure throws + toasts + skips the signature cache — because travel-times depends on its field and it's the core gameplay overlay.)

**One prewarm list (v680).** The three-source sprawl (hand-curated array + `bulk-cities.json` + name-discovery R2 doc) collapsed into **TWO clean roles**: a static bundled **seed** — `overpass-cache/world-cities.json`, the top-N biggest cities worldwide (`{name, relationId, extent?, population?}`), regenerated by `overpass-cache/scripts/build-world-cities.mjs` (Wikidata population + OSM relation id, Photon-reconciled so ids match in-app search; run it on a machine that can reach Wikidata/Photon — CI egress blocks them; default MERGES into the existing file — `--replace` to overwrite. **Regional top-up (v690):** `--region na,eu` (or explicit `--continents Q49,Q46`) joins city→country→continent in the SPARQL to target just those continents, and `--new-limit N` caps the run to the N biggest cities NOT already seeded — e.g. `--region na --new-limit 100 --limit 400 --reconcile` appends the 100 biggest North-American cities the seed is missing. The early-stop means it only reconciles until N new are found, not the whole `--limit` buffer. **Country tag + player-region warming (v693):** each entry now carries a `country` (ISO 3166-1 alpha-2, from Wikidata P297 / an `all-the-cities` backfill for legacy entries) — because the pure-population seed is ~44% Asia / 20% China, which is NOT where a US-YouTube-show audience plays. The generator self-cleans same-city/different-id duplicates on every run (a legacy `"City, Country"` entry vs the reconciled `"City"` entry — Paris #7444 vs #71525 — collapsed by normalised name, keeping the with-population reconciled one). The laptop's **`--priority-regions US,CA,GB,IE,AU,NZ,DE,FR,…`** (default list = English-speaking + Western Europe + Nordics; bare flag uses it) warms the whole city list by region TIER (list order) then population within each tier, so the stars players actually use light up first while the seed stays globally complete; unknown-country cities warm last. Takes precedence over `--seed-first`. **Two-phase warming (v700):** the laptop default is now **PRIMARIES ONLY** — warm each curated city's own play area, verify → stamp `primaryCuratedAt` (the ⭐). Fast; every curated city earns its star. A second **`--adjacents`** pass (alias `--city-complete`, v696) then fills the adjacent-ready set city-by-city — per city it warms the primary (skip-if-fresh) + its adjacent areas as full play areas via the worker's REAL neighbour set (`/admin/city-neighbours`) and stamps `adjacentsCuratedAt`, so the app can offer "extend play area" for it. The legacy always-on one-ring pass (`processOneRing`/`findNeighbors`) is retired (its local admin_level-around discovery diverged from the star gate for megacities). Pairs with `--priority-regions` to light up whole player regions in order) — PLUS the R2 **growth/state doc** (`loadDiscoveredCities`), which now holds only (a) organic player-added areas and (b) per-city curation state (`extent`, `adjacentsCuratedAt`, `fullyCuratedAt`). `getPopularCities = mergeUnique(growth, SEED_CITIES)` (growth first so runtime state/extent wins; `mergeUnique` field-fills missing `extent`/stamps across duplicates, killing the old "extentless seed shadows an extent-bearing dup" bug). **No hand-correction/override layer** (v681): the generator resolves each city through the app's EXACT play-area ranking (a verbatim port of `geocode.ts`'s `rankPlayAreaResults` — MUST stay in sync), so every relation id is the one in-app search returns by construction; fix a wrong city at the source (regenerate), not with a parallel list. The legacy speculative name-discovery cron pass is **OFF by default** (`NAME_DISCOVERY_ENABLED="true"` to re-enable; `/admin/discover` still works manually). **Runtime growth:** when a player picks a play area not already in the set, the client `POST`s `/api/register-area {relationId, name}` (`REGISTER_AREA_URL`, fired from `playAreaPrefetch.ts`'s warm-on-add hook for the primary + every added adjacent); the worker (`handleRegisterArea`, public, guardrailed: idempotent, `bboxFromRelation`-validated, capped at `REGISTER_AREA_MAX_GROWTH`) derives the extent and upserts into the growth doc, so the cron then caches it (+ adjacents) and it eventually earns a star. That's how "the list grows as players use the app."

**Warm-city star (v642; meaning re-settled v700 = PRIMARY warm, with a separate adjacent-ready gate).** The play-area search (`PlayAreaStep` in `GameSetupDialog.tsx`) stars results that are cached so users can spot Overpass-free regions (v645: the star also shows on the SELECTED play-area summary card, not just the search-results list). **v700: a star means "the PRIMARY play area is fully cached"** — the worker (`handleWarmCities`) reports cities stamped `primaryCuratedAt` (the city's own boundary+refs+stations in R2), the *achievable* guarantee that a normal game on this city runs Overpass-free. This deliberately reverses the v679/v692 strict gate (star = primary + EVERY adjacent, `fullyCuratedAt`), which made big cities almost never star — one flaky neighbour blocked the whole city, so the map showed almost no stars for months. **The "broken promise" the strict gate guarded against (a starred city offers adding an un-warm adjacent → live Overpass mid-game) is now handled a BETTER way, decoupled from the star:** the wizard only shows the adjacent-add picker for a primary whose neighbours are ALL prewarmed, gated on the SEPARATE `/api/adjacent-ready-cities` set (stamped `adjacentsCuratedAt`). So a city can be starred and fully playable the moment its primary is warm, and it simply offers no "extend play area" option until its adjacents are warm too. Two orthogonal signals: ⭐ = primary warm (`warmCityIds`, `/api/warm-cities`); "can extend" = adjacents warm (`adjacentReadyIds`, `src/maps/api/adjacentReadyCities.ts`, `/api/adjacent-ready-cities`, gated in `PlayAreaExtensions.tsx` via `isAdjacentReady`). Both sets fetch once + cache in their atom; CDN/browser-cached 1 h. Escape hatches (precedence lenient > strict > default, `handleWarmCities`): `WARM_STAR_STRICT="true"` restores the v692 primary+adjacents star (`fullyCuratedAt`); `WARM_STAR_LENIENT="true"` is the loosest extent-only star (broader/sooner, NOT a cache guarantee). The operator's laptop-prewarm default now warms **primaries only** (every curated city earns its star fast); a second `--adjacents` (alias `--city-complete`) pass fills the adjacent-ready set city-by-city using the worker's real neighbour set. **Tile pack folded into the star (v725):** the star's `primaryCuratedAt` now ALSO requires the city's **tile pack** (`tile-packs/v1/<id>.pmtiles` in R2) — so a starred city's map preload always gets the one-shot pack, never the slow per-tile z14 range walk (the Nairobi report: starred but 798-tile range-walking because no pack was ever built). `diagnosePrimaryCuration` gained a `requirePack` param + a `packCached` field; it's passed `true` ONLY for the PRIMARY star path (`verifyAndStampCity`, gated by `WARM_STAR_REQUIRE_PACK` — default ON) and the `/admin/adjacent-curation-status` primary row (now pack-aware, exposes `packCached`), NEVER for adjacent neighbours (the generic `relationFullyCurated` leaves it off — neighbours don't get their own packs, so requiring one would break the adjacent gate). **Operational consequence: earning a star now needs the `--tile-packs` prewarm pass** (which shells out to the `go-pmtiles` binary); a primaries-only run without it warms the data but no longer stars the city. Set `WARM_STAR_REQUIRE_PACK="false"` to revert to data-only stars for a prewarm environment that can't build packs. Existing stamps are corrected on the next verify (cron re-verify / laptop `--verify-only` / `--tile-packs` run), so packless cities drop their star until a pack is built. **Tile packs are now a DEFAULT part of the laptop prewarm (v726)** — built for every city `processCity` handles, so the primaries pass packs each primary and the `--adjacents` pass (which runs `processCity` per neighbour) packs each adjacent too, making adjacents fully first-class play areas (data + pack). `DO_TILE_PACKS` flipped from opt-in `--tile-packs` to default-on with `--skip-tile-packs` opt-out (the old `--tile-packs` flag is a no-op alias). Still needs the go-pmtiles binary — absent, the startup check disables packs for the run and loudly warns that cities will earn NO star under the v725 gate. NOTE: packs are a LAPTOP-only build (the go binary can't run in a Cloudflare Worker), so the CRON warms data but can't produce a star on its own anymore — stars are earned by the laptop pack pass. (The client only loads the PRIMARY play area's pack today; an adjacent's pack is used when that municipality is picked directly as a play area, not yet when it's added as an extension — a future enhancement.) **Adjacents earn their OWN primary star (v727):** an adjacent can also be a valid primary (someone searches "the Bronx" directly). The `--adjacents` pass now verify+stamps EACH warmed neighbour (`verifyCity(n.relationId)` after `processCity(n)`), not just the parent primary — since the neighbour is fully warmed (boundary+refs+stations+pack, v726) and its extent/name are stored (`ensureCityExtent`), `verifyAndStampCity` stamps its `primaryCuratedAt`, so it flows into `/api/warm-cities` and shows a star when searched directly. **Auto-resolved basemap (v727):** the tile-pack builder no longer hard-codes the date-stamped master filename — `GET /api/basemap-url` (`handleBasemapUrl`) lists the newest `basemap-z15-*.pmtiles` in R2 and the laptop uses it as `MASTER_PMTILES_URL` unless `--master-pmtiles` is passed (falling back to the baked default on lookup failure). Bump the client's `DEFAULT_PMTILES_URL` in lockstep when uploading a new basemap so packs extract from the same archive the app renders. **Firefox PMTiles serve fix (v748):** the service worker's `/tiles/*.pmtiles` range route (`src/sw.ts`, `PMTILES_RANGE_CACHE`) re-fetched the intercepted `request` on a cache miss. Firefox DROPS the `Range` header when a SW re-issues the original request via `fetch(request)`, so the worker returned the FULL file (a `200` — e.g. the ~127 GB basemap) and `resp.arrayBuffer()` tried to buffer gigabytes → threw → workbox's `setCatchHandler` synthesized a `503` for EVERY tile (curl + Chrome, which preserve the header, were fine; only Firefox + the huge `/tiles/` files broke). Fix: the miss path now forwards the Range header EXPLICITLY (`fetch(request.url, {headers:{Range:range}})`) and only buffers+caches a genuine `206` (a non-206 passes through unbuffered, so a multi-GB body is never `arrayBuffer()`d). The worker/R2 side was always correct — a ranged `GET` returns a clean `206` (verified via `curl -H "Range: bytes=0-99"`).

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

**Wizard defaults from play-area size (v760–v761).** Both wizards (`SetupPage` = first-time/new-game at `/setup`; `GameSetupDialog` = edit-settings) auto-default game size AND allowed transit from the play area, until the user overrides either by hand (tracked by `sizeManuallySet` / `transitManuallySet`, both init `true` in edit mode so a saved game isn't clobbered). The pure helpers live in **`src/lib/playAreaSize.ts`** (v761 — extracted from `GameSetupDialog` so the eager `AppSettingsDrawer` can measure the committed area without pulling the lazy setup dialog into its bundle): `sizeForAreaKm2(km2)` (rulebook S/M/L bands), `estimateAreaKm2`/`estimateTotalAreaKm2(primary, adjacents)` (bbox×`BBOX_FILL_FACTOR` estimate, summed over the primary + EVERY added `additionalMapGeoLocations` entry — so adjacents ARE counted toward the size, the previous gap), `exactTotalAreaKm2(primary, adjacents)` (**v761: the EXACT area** — `turf.area` over each area's real OSM relation boundary, already warmed by `PlayAreaPreviewMap`'s `fetchRawBoundaryPolygon`, memoised per relation id in `src/maps/api/boundaryArea.ts` `fetchExactAreaKm2`, bbox fallback per piece), `formatAreaLabel`, `inferTransitModes(size)`: **Small = bus+tram, Medium = tram+subway+train, Large = tram+subway+train+ferry** (bus dropped for M/L — too slow/local past a walkable metro core; walking always implicit), and `sameModes`. Two decoupled effects: (1) size — seeds synchronously from the bbox estimate then REFINES with the exact boundary area, deps `[draftFeature, additionalAreas, sizeManuallySet]` (NOT `draftSize`, so the async refine can't fight the sync seed); (2) transit — derives from the effective `draftSize` (so a manual size bump re-defaults the untouched transit set, e.g. Large pulls in ferry), guarded by `sameModes`.

**Preload estimate uses the committed area (v761 fix).** `AppSettingsDrawer`'s "Preload during hiding" panel rendered `PreloadChoicesPanel` with NO `areaKm2`, so it always showed the null-area fallback (~19 MB) regardless of city. It now passes `estimateTotalAreaKm2(mapGeoLocation, additionalMapGeoLocations)`; `GameSetupDialog`'s step-4 preload likewise now includes adjacents.

**Global press feedback (v761).** A `@layer base` rule in `globals.css` shrinks any `button` / `[role="button"]` / `a[href]` / `summary` to `scale(0.97)` while `:active` (90 ms transform transition, `prefers-reduced-motion` gated, disabled-excluded). It's in `@layer base` so a component's own `active:` Tailwind utility (which lands in `@layer utilities`) always overrides it — this only fills the long tail of bare interactive elements. The shared `Button` also carries an explicit `active:scale-[0.97]` + `transition-all`.

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

**App header layout (v747):** `[Settings · HIDE+SEEK wordmark · Notifications]` with the wordmark **centered** (equal-width 40px buttons on each side). Left = **Settings** (`Settings`, `moreSheetOpen` → `AppSettingsDrawer`); center = the `HideSeekWordmark`, now a **button that opens the developer debug panel** (`debugPanelOpen.set(true)`) — it replaced the standalone `DebugLaunchButton` (now orphaned/unused) so the header carries no debug-looking chrome (cleaner for demo screenshots; the wordmark is legitimate brand). Right = `NotificationsIconButton`. Same layout in `SeekerTopBar` + `HiderTopBar`. `GameLobbyDialog` is mounted in `SeekerPage`; `AppSettingsDrawer` + `MapOptionsDrawer` are mounted in `BottomNav`. The hiding-period countdown is **not** in the nav — it lives on the map's `HiderTimer` card. (The `DebugPhaseControls` floating chip still exists on the pre-game lobby + `/welcome`, gated by the `debugLauncherHidden` toggle; in-game the wordmark is the only debug entry point.)

**Hider nav parity (v632):** `HiderBottomNav.tsx` mirrors the seeker layout — four slots **Questions** (`List`, inbox badge) | **Zone** (`Tent`, the hider's primary action → `HiderHomeContent` drawer) | **Map** (`Map` icon → `HiderMapOptionsDrawer`, active-overlay badge) | **Lobby** (`Users`, rightmost). **Settings moved to the `HiderTopBar`** right cluster (`moreSheetOpen`, same `AppSettingsDrawer`), matching `SeekerTopBar`'s `[debug] — wordmark — [Settings · Notifications]`. The hider's map options (`HiderMapDisplayControls.tsx`, now exporting the shared `HiderMapOptionsPanel` + `HiderMapOptionsDrawer` + `useHiderMapOptionsActiveCount`) are a trimmed set — Basemap, **Hiding zones** (v643; was "Reachable zones"), transit overlays (no Travel-times/Export, which would leak seeker deduction shape). The old floating top-right `Layers` popover on `HiderBackgroundMap` was **removed** — the hider nav shows on every viewport, so the nav "Map" slot is the single entry point (no desktop-chip split like the seeker). Both surfaces reuse the shared `mapOptionsDrawerOpen` atom (seeker + hider views never coexist).

**Hider map timer + Zone-drawer declutter (v633):** the hider's phase/countdown moved OFF the old `HiderTimeHeader` flow-row (deleted) onto a **floating `HiderMapTimer` card** on `HiderBackgroundMap`, matching the seeker's `HiderTimer` visual + layout exactly — golden "HIDING TIME REMAINING" box bottom-LEFT while hiding, white "HIDDEN FOR" box + red accent + gold "time to beat" row bottom-RIGHT while seeking (endgame swaps the eyebrow/accent to yellow; grace = red pulse box; forfeit/pre-game variants). It self-positions and the hider's `MapNavControls` dodge to the OPPOSITE corner (a one-shot `setTimeout` on `hidingPeriodEndsAt` in `HiderBackgroundMap` flips `seekingStarted`, no per-second tick). The hider-only **"Mark spot"** popover (inside-committed-zone gate) moved onto the card, stacked above it. The **Zone drawer** (`HiderHomeContent`) is now stage-gated to only what the hider needs: **hiding** = timer + zone picker (**v781 declutter**: the timer's game-size pill, the explanatory "pick a transit station… / allowed modes / grace-period warning" section, the "Nearby stations / Pick on map" mode-toggle, and the "Jet Lag Hide and Seek · hider home · active" footer were all removed — the station list is the sole in-drawer picker; map-picking is still available by tapping the map behind the non-modal drawer; the trip-plan card + scouted-spots notebook were dropped from this stage back in v633); **seeking** = zone info + **seekers' ETA card** + scouted spots (the elapsed banner, live seeker positions, question log, hand panel, and dice were removed — they live on the map / the "Questions" nav drawer / the hand fan); the spot-lockdown section surfaces only once the seekers claim the endgame (`endgameStartedAt !== null`); **endgame** = locked-spot map + scouted spots. Zone-drawer subheader updated to match. `SeekerETACard` (v634) now renders a quiet "waiting for a seeker to share their location…" placeholder instead of `null` when there's a committed zone but no fresh seeker broadcast, so the ETA slot is visible during seeking rather than silently absent (it fills in live once a seeker shares GPS).

**Hider follow-ups (v635):** (1) The on-map `HiderMapTimer` hiding box now carries an **"End hiding · Start seeking"** button, shown only once a zone is committed (`hidingZone !== null`) — same gate applied to the drawer's copy of that button. (2) **Seeker-proximity notifications:** `SeekerProximityWatcher.tsx` (always mounted on `HiderPage` during seeking) owns the seeker→zone arrivals fetch, publishes to the new `seekerEta` atom (`journey/state.ts`), and fires an OS `notify()` when the seekers cross into a **closer colour band** (comfortable → heads-up → imminent → arrived; monotonic-max rank so each threshold alerts once per round, no boundary spam; plain `setInterval` so it fires while backgrounded). `SeekerETACard` is now a pure renderer of `seekerEta` (no own fetch). (3) **Hider-map parity:** added the `AttributionControl` (top-left, was missing entirely — also a license requirement) and made the reach-overlay labels basemap-brightness-aware (dark text on the light base), matching the seeker map's v616/v622 treatment. The question overlay was already the shared `QuestionOverlayCard`; the elimination flash stays **seeker-only** (the hider must not see the seeker's deduction shape). (4) The hider's **"Reachable zones"** overlay was renamed **"Hiding zones"** and colour-coded green/red/amber by reachability. **(Superseded in v643** — the per-station arrivals fan-out was slow, so the overlay reverted to a plain seeker-style station field and reachability moved on-demand into `StationTransitCard`; see the "Hider hiding-zones overlay" section above.)

## Map display controls (bottom-nav "Map" on mobile / bottom-left chip on desktop, v622)

`MapDisplayControls.tsx` exports one shared **`MapOptionsPanel`** (`roomy` prop for bigger touch targets) rendered on two surfaces:
- **Mobile** — the bottom-nav **"Map"** slot opens **`MapOptionsDrawer`** (a vaul bottom sheet, `mapOptionsDrawerOpen` atom) with the roomy panel.
- **Desktop** — the floating **"Map options" chip** (`Layers`, `h-14/w-14`, active-count badge) opens a `Popover` (`side="top" align="start"`) with the compact panel. `SeekerPage` wraps it `hidden md:block` (mobile uses the nav).

Panel sections (v833 trimmed): **Basemap** (Map/Satellite), **Overlays** (Hiding zones — the Travel-times toggle was removed), **Transit overlays** (per-mode rail/subway/bus/ferry/train/tram, gated on `allowedTransit`, laid out as a `grid grid-cols-2` so four modes read as 2+2). The Save-image **Export** section was also removed. The active-overlay count comes from the exported `useMapOptionsActiveCount()` hook (used by both the desktop chip badge and the nav "Map" badge).

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
   - **Radar (radius)** → opens configure **dialog** (size **carousel** + Custom; v747)
   - **Thermometer** → opens `ThermometerConfigureDialog` (target-distance picker + Start confirm; v339)
   - **Matching/Measuring/Tentacles** → opens subtype picker (drawer 2)
2. Subtype picker (**drawer 2**) — header + scrollable flex-col body, dark sidebar background, "back to categories" button
3. Configure **dialog** (pending question from `promoteLastQuestion`) — header / scroll body / footer (Cancel + Send), centered Dialog

Thermometer is blocked if any other thermometer is already `status:"started"`.

**Picker chrome unified to `QuestionOverlayCard` (v747):** the category picker (`CategoryTile`) AND the matching/measuring/tentacles subtype picker (`SubtypeTile`) now render the SHARED `QuestionOverlayCard` (the on-map overlay / collapsed-list card chrome) — solid `deepColor(category)` icon block on the left, big bold uppercase label in the deepened category colour, the prompt/subtype-description as the detail line — instead of the old `bg-secondary` + coloured top-border + white-label tiles. So the whole add-question flow reads as one system with the overlays and the questions list. Both are laid out as a `grid-cols-1 sm:grid-cols-2` list of horizontal cards (subtypes were a 2–3 col grid). Disabled = `opacity-50` + no `onClick` (the card's `role=button` drops); the repeat-cost `N×` badge rides the card's `right` slot.

**Radar size carousel (v747):** `cards/radius.tsx` replaced the 5-up preset grid + "Other ▾" popover with a single **prev/next cycler** over all nine rulebook sizes (`ChevronLeft`/`ChevronRight` + one prominent size label), plus a compact **Custom** toggle beneath it. The cycler skips presets already used by another radar question (the one-preset-per-game rule) so it only lands on selectable sizes. Changing the size **animates the map preview** (v747): the camera already `fitBounds`-animated (`duration:400`); now the overlay circle in `InlineLocationPicker` also tweens — a `requestAnimationFrame` ease-out over ~420 ms drives an `animatedRadius` state that feeds the turf circle, so the ring grows/shrinks smoothly in step with the zoom instead of snapping (pin drags / first mount still snap).

**Labelled dialog loading (v747):** the configure veil no longer shows blank grey bars. `InlineLocationPicker` reports the currently-pending steps ("Getting your location…", "Finding your nearest reference…", "Calculating question impact…", "Loading map…") up to `AddQuestionDialog` via the widened `ConfigureDialogContext` (`onLoadingStatus`), which renders them as `Loader2`-spinner rows over a map-placeholder that reads "Loading map…". Falls back to "Preparing question…" before the picker reports.

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

The `{label, radius, unit, sig}` shape (a single `RADIUS_PRESETS` array of all nine sizes) is unchanged. **Rendering (v747): radius uses a prev/next CAROUSEL** (`cards/radius.tsx`, see the AddQuestionDialog section) — the old `grid grid-cols-5` + "Other" popover is gone; the cycler skips already-used sigs (uniqueness) and the currently-selected size stays reachable. Thermometer still renders its target presets as a grid.

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
build stamp. Current: `v1021`. Use `git log` for the per-version detail;

**v1021 — hider can commit a hiding zone from the map + drawer auto-closes.**
- **Tap a zone on the hider map → "Hide here"** — `StationTransitCard` gained an
  `allowHiderCommit` prop (passed by `HiderPage`); when the hider taps a zone
  during the hiding period and hasn't committed yet, the card shows a "Hide here"
  action that runs the shared `confirmAndCommitZone` (same lock-in confirm + map
  preview as the Zone drawer's picker) and closes the card. Previously the map tap
  only opened the card with no commit path.
- **The Zone drawer closes on lock-in** — `HiderBottomNav` watches the fresh
  null→committed `hidingZone` transition during the hiding period and closes the
  Zone drawer, so the map + the on-map "end timer early?" callout are visible right
  after committing (the seeking-phase drawer, which shows committed-zone info, is
  left open).

**v1020 — gameplay/UX batch (endgame, radar map, overlays, Move, round reset).**
- **Pending/hider question overlay: CATEGORY is an eyebrow, subtype is the big
  label.** `QuestionOverlayCard` gained a `categoryEyebrow` mode + `summarizeQuestion`
  now carries `category`; the on-map overlays (`PendingAnswerOverlay`,
  `HiderUnansweredOverlay`) pass it, so "MATCHING · MUSEUM" reads as a small
  "MATCHING" eyebrow over a big "MUSEUM". (base.tsx list/configure cards keep the
  combined label — they own their own status eyebrow.)
- **Radar answer no longer zooms out to the whole play area.**
  `triggerEliminationFlash` (`Map.tsx`): when the answer NARROWS to a small area
  (remaining area < ½ the ruled-out delta — a radar "inside", a tight
  thermometer), it frames the small remaining area directly instead of
  fit-to-delta (which zoomed all the way out first).
- **Radar elimination circle is smooth again.** The holedMask input `turf.simplify`
  (~66 m tolerance, for cheap world-scale difference on a dense metro) collapsed a
  SMALL remaining area (a 500 m radar circle) into an octagon. Now gated on vertex
  count — only a dense (≥1500-vert) boundary is simplified.
- **Endgame cuts the map with the elimination look, not a gold circle.** The
  `endgame-focus` layers dropped the gold ring/glow and now dim everything OUTSIDE
  the zone with the SAME `eliminationFillColor`/opacity as a question elimination;
  reaching the zone fires the elimination flash (delta = remaining minus zone) and
  settles framed on the zone — "the zone is the only area left."
- **Reaching the endgame turns OFF the hiding-zones overlay + every transit
  overlay** (`Map.tsx`, once per arming) — the seekers are at the zone and no
  longer need them.
- **Hider POI field defaults OFF** (`hiderPois.ts hiderPoiShow`) — it was showing
  orange POI dots the hider never enabled; now they appear only when turned on.
- **Move powerup's Play button is disabled during the endgame** with an
  explanation (`HiderHandFan` + `HiderHandPanel`) — you're locked to your final
  spot; previously the tap fired and errored with a toast.
- **Curse proof photos show uncropped** — `CurseInbox` used `object-cover` (the
  reported Labyrinth-maze crop); now `object-contain` so the whole photo shows.
- **New round resets the clock + gives the new hider a planning window.** The
  server's `handleRotateHider` deliberately kept `hidingPeriodEndsAt`, so a stale
  clock leaked back to every device and a new round opened mid-timer. It now nulls
  `hidingPeriodEndsAt`/`revealedStation`/`seekersFrozenUntil` + resets the
  seeking-push dedup and broadcasts `setupChanged`, so every device returns to the
  lobby where the new hider gets the 10-min planning window and the host arms a
  fresh hiding period via Start.



**v1019 — photo question UX batch (seeker signal + hider gallery upload +
configure-card declutter + "photo sent").** From the demo-feedback batch:
- **Photo configure card decluttered** (`cards/photo.tsx`) — the subtype NAME is
  already the card header ("PHOTO · THE SKY"), so the old `Camera` icon + repeated
  `{subtypeLabel}` block was pure duplication. Removed; the rulebook INSTRUCTION
  for that photo (`subtypeDescription`, e.g. "Phone on the ground, shoot straight
  up.") is now a clear bordered callout. `Camera` import dropped.
- **Hider can UPLOAD from the gallery, not just shoot** — the `capture="environment"`
  attribute forced the rear camera and hid the photo library on mobile. Removed
  from BOTH photo file inputs (`cards/photo.tsx` + `HiderView.tsx PhotoAnswer`), so
  the OS offers "take photo" OR "choose from library" (the button already says
  "Take or choose photo").
- **Seeker gets a clear answered signal for photo** — a photo answer eliminates
  nothing on the map (no elimination flash), so the seeker had no clear "answered"
  moment. `PendingAnswerOverlay` now, for an answered `photo` question, makes the
  answered overlay card open the received image in a full-screen **lightbox**
  (`createPortal` → `z-[1200]` black backdrop + close X) on tap instead of the
  details panel.
- **Hider log reads "Photo sent"** — `HiderQuestionLog`'s answered-photo detail
  was the role-agnostic `answeredDetail` → "Photo received", which reads wrong on
  the hider's OWN log (they SENT it). Now shows "Photo sent".

**v1018 — correctness batch: matching `-full` verdict, curse payload leak,
thermometer-started overlay, photo-sent naming.**
- **Matching `-full` questions now AUTO-GRADE the hider's verdict** — a matching
  aquarium (any `-full` point family) showed the hider "Match" while the map cut
  put the hider's nearest and the seeker's nearest in DIFFERENT Voronoi cells,
  because `hiderifyMatching` (`matching.ts`) never handled `-full` types → the
  verdict was whatever stale `question.same` carried. It now runs
  `determineMatchingBoundary(question)` (the seeker's own geodesic-Voronoi cut,
  returning the cell CONTAINING the seeker) and sets `question.same` =
  `booleanPointInPolygon(hiderPoint, boundary)`, so verdict == cut. Falls back to
  the manual answer on any failure.
- **Curse cast payload can't leak a stale field** — `CastCurseDialog.enforceParams()`
  now gates EVERY optional payload field on the CURRENT curse's requirement flag
  (`costRequiresPhoto`/`Video`/`RockCount`/`Destination`), so a "Test text here"
  destination typed for the Mediocre Travel Agent no longer rides along into a
  later curse (Impressionable Consumer) that has no destination.
- **A STARTED (not finished) thermometer no longer shows as an incoming question**
  on the hider — `HiderUnansweredOverlay`'s `waiting` filter excludes a
  `thermometer` entry whose `status === "started"` (only the seeker's finish stamps
  `createdAt` + sends), mirroring the seeker's `PendingAnswerOverlay`.

**v1016/v1017 — CLEAN the headless MVT water before it's unioned (fixes the 30 s
`dissolveWater`/`bufferAndUnion` TIMEOUT) + self-healing worker pool + full-path
diagnostics.** The v1016 diagnostics gave the definitive trace: the first compute
used the barely-loaded CAPTURE (5 polys → dissolve → `bufferAndUnion ok`, fast,
but `cancelled=true` — discarded when the headless bump re-ran the effect), then
the second compute on the 94→79-polygon HEADLESS set hit `[geometry]
'dissolveWater' TIMED OUT after 30000ms` AND `'bufferAndUnion' TIMED OUT` →
arcgis on the main thread (the 30 s+ freeze). Root cause: the pmtiles `water`
tiles decode with quantization artifacts (near-coincident/duplicate vertices,
tiny self-intersections) that make `turf.union` pathologically slow — the clean
`querySourceFeatures` capture unions instantly, the raw MVT decode does not.
Fixes:
- **Clean the headless geometry at the source** (`ensureBasemapWaterForArea`,
  `basemapWater.ts`): each decoded polygon is `turf.truncate`d (~1 m, snaps the
  near-coincident vertices) then `turf.simplify`d (~30 m, invisible against a
  ≥km water buffer) before it's stored, dropping zero-area results. So the union
  is fast. `[water] headless cleaned → N polys stored` logs it.
- **Self-healing worker pool** (`geometry/client.ts`): a Web Worker can't be
  interrupted, so a wedged op blocks THAT worker forever and slowly depletes the
  pool. On a call timeout the client now TERMINATES the stuck worker, fails its
  other pending calls (they fall back to the main thread), and spawns a
  replacement (`replaceWorker`).
- **Full-path diagnostics** kept: `[qimpact] measuring effect run`, `[bow]
  getDissolvedWater START` / `after ensure: polys=N` / `dissolvedWater=N`,
  `[geometry] worker pool created: N` / `'<op>' TIMED OUT`, `[qimpact] buffer
  resolved … cancelled=…`, so the next stall is visible end-to-end.

**v1015 — dissolve cache keyed on CONTENT not version (fixes the second
compute re-dissolving to failure → 30 s freeze).** v1014's pool wasn't enough:
the log showed the FIRST body-of-water compute dissolving fine (`feats=1
verts=6627 → ok`, fast), then the headless read's version bump re-ran
questionImpact and the SECOND compute started a FRESH dissolve of the SAME 79
polys (the dissolve cache key included `basemapWaterVersion`) — that re-dissolve
intermittently failed → the caller fell back to the RAW 79 polys →
`bufferAndUnion threw` → arcgis on the MAIN thread (the ~30 s freeze, incl. the
frozen main map on dialog close as the seeker `holedMask` fell to the main
thread behind the same contention). Fix (`basemapWater.ts` `getDissolvedWater`):
key the dissolve cache on `playArea:sea:polyCount`, NOT the water version, so the
second compute AWAITS the first dissolve's Promise and reuses its one small
dissolved shape (`bufferAndUnion` on 1 feature is trivial). A genuinely changed
water set changes the poly count → re-dissolve. A failed dissolve is evicted (not
cached) so a retry recomputes instead of re-serving the failure. The version-bump
recompute still happens once but is now fast (cached dissolve), so it no longer
piles up in the worker.

**v1014 — geometry worker POOL (fixes the ~30 s freeze / late overlay) +
settle-the-veil-on-failure + longer deadlock backstop.** The v1013 headless read
WORKS on device (`[water] headless read: 94 water polys`), but body-of-water
still revealed bare then dropped the overlay ~30 s later with hitches. The
console showed why: `dissolveWater` + `bufferAndUnion` (configure overlay) + the
seeker map's `holedMask` behind the dialog + version-bump re-computes all queued
in ONE serial geometry worker, piled up, and hit the 30 s call timeout — so the
dissolve fell back to raw polys, `bufferAndUnion threw`, and it dropped to arcgis
on the MAIN thread (the freeze), resolving ~30 s later. Fixes:
- **Worker POOL** (`geometry/client.ts`) — 2–4 workers (by `hardwareConcurrency`)
  round-robin over one shared `pending` map (ids are globally unique), so the
  dissolve, buffer, and holedMask run in PARALLEL instead of serializing. A crash
  tears the whole pool down and falls back to the main thread, unchanged.
- **Veil settles on failure** (`questionImpact.ts`) — `measuringReady` required an
  actual region (`yes||no`), so a failed/empty buffer left `loading` stuck true
  and the veil could only be freed by the deadlock backstop. New `measuringSettled`
  (compute DONE, success or fail) drives `loading`; `measuringReady` (has a region)
  still gates whether the overlay is DRAWN. The measuring + matching-region effects
  now `setMeasuring`/`setMatchingRegion` even on a null/empty result. So the veil
  reveals the moment the overlay is done — drawn OR determined-empty — not on a
  timer.
- **Deadlock backstop 6 s → 15 s** (`AddQuestionDialog.tsx`) — 6 s was fine when
  the veil lifted on `impact !== null` (fast), but v1013 made it wait for the
  buffer, and a complex question (headless read + heavy buffer) can exceed 6 s.
  The labelled "Calculating question impact…" row shows meanwhile; the overlay
  normally settles well before this floor now that the pool keeps it fast.

**v1013 — reveal the configure map WITH its overlay (veil waits for the
buffer) + deterministic complete water (headless read) + coastline off the fast
path.** Three connected fixes, from the user's "the veil lifts before the
overlay is ready" + the `[bow]` diag showing `verts` climbing 6627→10052 on ONE
open (the viewport capture filling in AFTER the first compute):
- **Veil holds until the overlay is drawable.** `InlineLocationPicker`'s
  `impactReady` was `impact !== null` — but `impact.loading` stays true while a
  full-geometry buffer computes, so the map revealed bare and the overlay "came
  in after". Now `impact !== null && !impact.loading`, so the dialog's
  `pickerReady` gate (and the 6 s backstop) reveal the map WITH its overlay.
- **Deterministic complete water.** The `querySourceFeatures` capture only sees
  a display map's loaded viewport tiles, so the first body-of-water compute ran
  on half-loaded water (an adjacent body missing → near-shore land wrongly
  "further"; the overlay then changed as more tiles idled in). `getDissolvedWater`
  (`basemapWater.ts`) now `await`s `ensureBasemapWaterForArea` FIRST — the
  dormant-since-v1008 headless pmtiles read (whole play-area `water` layer at a
  fixed z11, viewport-independent), now safe under v1012's cached dissolve. It's
  bounded (4.5 s, under the veil backstop), memoised per play area (runs once →
  every open instant + complete), marks the entry `headless` so the capture stops
  accumulating (kills the version-bump churn), and degrades to the capture on any
  failure. `[water] headless read: N water polys` logs the result.
- **Coastline off the slow arcgis path.** `distanceToFeatureKm` (`geometry/
  worker.ts`) returned `Infinity` for a sea polygon with island HOLES —
  `polygonToLine` yields a `MultiLineString` for a holed ring set and
  `pointToLineDistance` THROWS on that, so `minKm` was non-finite and
  `bufferAndUnion` never buffered the sea (`→ null` → arcgis fallback). Now it
  flattens each `MultiLineString` ring to a `LineString`, so coastline buffers on
  the fast worker path like body-of-water.
Still watching (needs the next on-device read): whether the headless read
returns complete NYC water (`[water] headless read: N`) — if N is 0/low, the
pmtiles decode isn't reaching the archive on device and we fall back to capture.

**v1012 — body-of-water: cache the water DISSOLVE per version (kills the
intermittent "ok → threw → arcgis" timeout) + no dropped narrow water + markers
off + styleimagemissing silenced.** The v1009 diagnostic caught the real failure:
opening the configure dialog ONCE logged the SAME 126-feature/42825-vertex input
computing three times — `bufferAndUnion ok`, then `threw`, then `arcgis ok`.
Root cause: `captureBasemapWater` accumulates water pieces on every map idle and
each new piece bumped `basemapWaterVersion`, so the (expensive) 126-piece union
re-ran on every buffer call and the CONCURRENT re-unions piled up in the single
geometry worker and timed out (30 s call cap → "threw" → slow arcgis fallback →
the overlay that "comes in after"). Fixes:
- **Cache the dissolve per (play area, water version).** New worker op
  `dissolveWater` (`geometry/worker.ts`/`client.ts`) unions the pieces into their
  real bodies ONCE; `getDissolvedBasemapWater`/`getDissolvedBasemapSea`
  (`basemapWater.ts`) memoise the Promise per version, so body-of-water /
  coastline / same-landmass all reuse ONE small dissolved shape and the buffer
  works on that (fast, never piles up). Falls back to the raw pieces if the
  dissolve fails, then to cold OSM.
- **Debounce the version bumps** (`bumpWaterVersionDebounced`, 1.2 s) so a burst
  of idles (panning / an app-switch reloading tiles) bumps at most once.
- **No dropped narrow water:** `unionPolygonsGently` no longer pre-simplifies
  each piece (a 20 m simplify could self-intersect a narrow channel → its union
  throws → that water silently dropped → its shore read "further"). It unions the
  RAW pieces and only simplifies the ACCUMULATOR once it grows.
- **Body-of-water candidate MARKERS removed** (`InlineLocationPicker`
  `measuringDotsFC` skips body-of-water/coastline/sea-level) — their dots are
  water-body centroids, but the overlay buffers the water GEOMETRY, so a dot on a
  small pond the buffer doesn't include read as a marker that "doesn't affect the
  math" (user report). The overlay region IS the answer.
- **`styleimagemissing` console spam silenced** on the four maps that lacked the
  handler (`ThermometerPreviewMap`, `ZonePreviewMap`, `TransitRoutePicker`, and
  the shared helper) — the Protomaps road layers reference per-number highway
  shields absent from the sprite; `installMissingImageHandler` supplies a 1×1
  transparent placeholder.
Known-still-open (need the next on-device console read): the lower-Manhattan
"closer marked further" if it's a CAPTURE-completeness gap (the Hudson / southern
harbour never captured by any map) rather than the now-fixed union drop — the
`[bow]` diag's dissolved-piece count will show which; if it's completeness, the
deterministic headless pmtiles read (dormant `ensureBasemapWaterForArea`) is the
next lever, now safe under the cached dissolve.

**v1011 — unify same-landmass + coastline on the basemap-water base, and fix
body-of-water "closer marked further" (union-first, not aggressive simplify).**
Three connected fixes, all off the SAME basemap `water` layer body-of-water uses
(the user's ask: "why don't we use the same base calculation as body of water?"):
- **body-of-water correctness (the confirmed "closer marked further" bug).**
  v1010 stopped the throw by simplifying each captured water polygon to an 8000-
  vertex budget — but hitting that budget on 72 tile-pieces / 32k verts forced
  tolerances up to ~700 m, which COLLAPSED narrow water (the lower East River /
  harbour channels) so their buffer vanished and near-shore land wrongly read
  "further". Replaced with **union-first** in the geometry worker
  (`bufferAndUnionImpl`, `geometry/worker.ts`): `unionPolygonsGently` unions the
  tile-clipped polygons FIRST (largest/sea first, gentle ~20 m river-safe
  pre-simplify only to speed the union, accumulator re-simplified if it grows),
  which DISSOLVES the redundant tile-boundary vertices far more than simplify AND
  preserves every body's true shape; then the dissolved water is buffered ONCE.
  Line targets (cold-OSM rivers/coastline) are buffered individually. Cheaper
  (one buffer + a small dissolved input, not N buffers unioned as big blobs) and
  shoreline-preserving.
- **same-landmass → basemap water** (`matching.ts`, new worker op `landFromWater`
  in `geometry/client.ts`/`worker.ts`): land = the play-area frame MINUS the
  unioned basemap water, the connected component CONTAINING the seeker. Smooth
  Protomaps water polygons replace the BLOCKY raster `seaFromCoastline` land
  (`fetchAreaLandPolygons`) the user flagged. Runs in the worker (no freeze). The
  v1001 "are you in a body of water?" error is fixed inside the op AND at the
  call site: if the seeker's point falls on the water side of an imprecise shore,
  the op returns the NEAREST land part and the caller TRUSTS it rather than
  erroring. Falls back to the OSM-coast land path when no basemap water captured.
- **coastline → basemap SEA** (`measuring.ts`, `getBasemapSeaPolys` filtering
  Protomaps `kind` = ocean/sea/bay): "closer to the coast" = closer to the sea,
  so the sea polygons are buffered via the SAME union-first `bufferAndUnion` path
  (coastline now routed through it like body-of-water). This replaces the OSM
  coastline + `seaFromCoastline` 2 km-strait-rule path that FROZE the app for a
  second or two and often drew no overlay — Protomaps already tags open sea as
  ocean/sea/bay and narrow channels separately, so the sea-kind filter IS the
  strait rule by construction. Cold fallback (no basemap sea captured): the OSM
  coastline lines + strait rule.
- **PC-console diagnostics** for all three (`[bow]` / `[coast]` / `[landmass]`
  tags) plus the debug-panel `lastBodyOfWaterDiag` line, so the failing stage /
  source / vertex counts are visible while iterating. Known follow-ups (not
  blocking): the first-open capture race (overlay sometimes absent the very first
  time, fine on re-open — self-heals via `basemapWaterVersion`); the coastline
  nearest-reference LABEL still reads OSM coast (elimination now basemap sea, so
  they can disagree slightly); and the split-second draft overlay flashing on the
  main map before the configure dialog opens.

**v1010 — body-of-water ROOT CAUSE FIXED (buffer chokes on the unbounded
basemap-water capture).** The v1009 diagnostic paid off immediately: the overlay
worked the FIRST time (`feats=8`) then, after switching apps and back, THREW
(`src=basemap-water feats=93 verts=48495 → bufferAndUnion threw`). Root cause:
`captureBasemapWater` (`basemapWater.ts`) ACCUMULATES water polygons across every
map `idle` — panning / zoom / an app-switch re-render loads more tiles, and each
new tile-clipped piece is appended (the `geomKey` dedupe only catches an
identical re-seen piece, not the same body at a different zoom/detail), so the
set grows UNBOUNDED. `bufferAndUnion` then buffers + incrementally unions that
volume and throws (a hard turf throw OR the client's 30 s worker-call timeout —
both volume-driven; both surface as "threw"). Water needs no fine detail (we
buffer by hundreds of metres to kilometres), so the fix caps input complexity IN
THE WORKER: `bufferAndUnionImpl` (`geometry/worker.ts`) now runs
`reduceToVertexBudget` on the buffer targets — `turf.simplify` each polygon at a
PROGRESSIVELY coarser tolerance (0.0002→0.0064) until the whole set is under
`BUFFER_VERTEX_BUDGET` (8000 verts), points/lines untouched. Crucially each
simplified polygon is PAIRED with its ORIGINAL: if the simplified buffer fails
(a simplify-induced self-intersection — the v1001 "sea dropped" regression), it
RETRIES the original at full detail, so a large body (the sea) is never silently
lost to over-simplification. Simplify is pure vertex decimation (never throws);
the incremental union is already per-part guarded. This is a targeted fix for the
CONFIRMED 48k-vertex throw, not a blind geometry change — the v1009 diagnostic
stays in so the next test shows `feats=93 verts=48495 → bufferAndUnion ok`.

**v1009 — body-of-water ON-DEVICE DIAGNOSTIC (stop guessing which stage
fails).** After v1008 reverted the body-of-water path to the byte-identical
v1000 build the user confirmed worked ("better than ever"), the overlay STILL
showed nothing on device. A full diff proved the entire runtime path — the
`body-of-water` case, the `basemapWater.ts` capture (`getBasemapWaterPolys`),
`questionImpact.ts`, the geometry worker's `bufferAndUnion`, and the configure
map's capture wiring — is unchanged since v1000, so it can't be a code
regression to revert. "No overlay" means the buffer step returns null/false,
which leaves `questionImpact`'s `loading` stuck true → the configure veil times
out to a bare map. WHICH stage produces nothing (the basemap-water capture never
populating, the cold OSM fallback returning empty, or the buffer failing on
dense geometry) is unobservable from a screenshot, and shipping another blind
geometry patch is exactly the guess-and-regress cycle v1008's lesson warned
against. So v1009 adds a diagnostic instead of a fix: `measuring.ts` summarises
each body-of-water compute (`src` = basemap-water vs cold-osm, feature/vertex
counts, poly/line breakdown, and the buffer outcome — `bufferAndUnion ok/null/
threw`, `arcgis ok/null (NO OVERLAY)`, or `determineMeasuringBoundary EMPTY`)
into `lastBodyOfWaterDiag` (`debugState.ts`), shown in the `DebugPhaseControls`
panel (readable on a phone) and `console.warn`ed with the `[bow]` tag. Configure
a body-of-water question, open the debug panel (5 taps on the top-centre
wordmark), read the line — it names the failing stage, so the NEXT change is
targeted (a cold/empty fetch needs a different fix than a buffer timeout than a
capture that never fires). Rejected a "guaranteed overlay" net (union the raw
water polys when the buffer fails): for a seeker far from water it draws only the
water and omits the near-shore "closer" band, which is WRONG (land near the water
is also closer), not just degraded — a misleading overlay is worse than none.
Diagnostic-only; no behaviour change to the elimination.

**v1008 — REVERT the speculative basemap-water changes that regressed
body-of-water + same-landmass to NO overlay / a hard error.** An audit of the
diff since the user's "better than ever" (v1000) showed every "reliability"
change layered on top REGRESSED the working state (v1001 was the last build that
actually deployed — basemapTiles.ts broke the build for v1002-v1005, so the
regressions only went live at v1006). Backed out:
- **body-of-water**: dropped v1001's `turf.simplify` (real MVT ocean geometry can
  self-intersect after a radial-distance simplify → the buffer drops the sea) and
  v1002's headless pmtiles read (untestable offline; it REPLACED the working
  `querySourceFeatures` capture with geometry that over-loaded / broke the
  buffer). Back to v1000: RAW captured basemap water, buffered as-is — the state
  the user confirmed worked.
- **same-landmass**: reverted the v1001 `basemapLandParts` migration (frame minus
  basemap water) back to the established per-city OSM land (`fetchAreaLandPolygons`)
  + frame-bounded coarse fallback. The basemap water could put the seeker's point
  on the water side → no land part contained them → the "are you in a body of
  water?" error.
- **coastline** + the nearest-coast LABEL: reverted `basemapCoastLines` back to
  the per-city OSM coastline.
The headless-read machinery (`basemapTiles.ts`, `ensureBasemapWaterForArea`) is
left in place but DORMANT (nothing calls it) — it needs on-device validation
before being re-enabled, not another blind ship. LESSON: stop layering
speculative, offline-untestable "reliability" changes onto a surface the user
just confirmed works.

**v1007 — thermometer arrow drag-handle + body-of-water no-overlay regression
fixed.**
- **Body-of-water showed NO overlay again.** v1002 made the elimination `await`
  the headless pmtiles read, and that read (up to 24 z12 tiles, decoded on the
  main thread, possibly from the huge master archive) is slow enough to blow the
  configure veil's timeout → bare map / no overlay; the extra z12 polygons also
  over-loaded the buffer. Fixes in `basemapWater.ts`: (a) the `ensureBasemapWaterForArea`
  await is now BOUNDED (`capAwait`, 2.5 s) — a slow read never blocks the overlay,
  the populate keeps running in the background and bumps the version when done so
  the elimination recomputes with the deterministic set once it lands, and the
  `querySourceFeatures` capture (or the cold OSM fallback) covers the first paint;
  (b) the headless read drops to zoom 11 / ≤16 tiles (fewer, larger tiles → far
  fewer polygons → a much lighter buffer). Water needs no fine detail (simplify +
  km-scale buffer).
- **Thermometer preview: draggable arrow handle + pan/zoom, circle removed.** The
  `ThermometerPreviewMap` map now pans/zooms normally, and the travel ARROW's tip
  is a DRAG HANDLE (an arrowhead that rotates to the aim) — drag it around the
  start to change direction. The distance stays fixed by the carousel, so the
  handle orbits at radius D and the arrow LENGTH shows the distance (the separate
  distance circle was removed as redundant). The D/2 cut + warm/cool half-planes
  + HOTTER/COLDER labels track the aim live; the map reframes on distance change.

**v1006 — CI build fix: ambient decls for `@mapbox/vector-tile` + `pbf`.** The
v1002 headless MVT decoder imports two libs that ship NO TypeScript
declarations, and the DefinitelyTyped `@types/*` packages don't resolve cleanly
under the CI's strict `pnpm install --frozen-lockfile` (non-hoisted) — so
`tsc --noEmit` failed the Cloudflare build with TS7016 (`v1002`-`v1005` all
failed to deploy). Local `tsc` passed only because the dev `node_modules` was
hoisted. Fixed by declaring both as ambient `any` modules in `src/vite-env.d.ts`
(`declare module "@mapbox/vector-tile"; declare module "pbf";`); the decoder's
runtime is validated on-device regardless. LESSON (reinforcing v795): after ANY
dependency change, run a FULL `pnpm install` (re-link to strict) before trusting
a local `tsc`/build — a hoisted dev tree hides missing declarations + resolution
gaps that the CI's frozen-lockfile install surfaces.

**v1005 — thermometer configure dialog: radar-parity + directional hotter/colder
preview.**
- **Header restyled to the shared question-card chrome** — the plain
  "New thermometer" title became the `QuestionOverlayCard` (solid yellow
  category icon block + big label + prompt), matching the radar/configure
  dialogs (a visually-hidden `DialogTitle` keeps Radix a11y happy).
- **Directional hotter/colder preview** (`ThermometerPreviewMap`, replaces the
  plain `ZonePreviewMap` circle) — a thermometer's answer splits the map along
  the perpendicular BISECTOR of [start, end] (a line D/2 from the start,
  perpendicular to travel), so a circle can't convey it. The preview draws the
  endpoint RING (radius D) + the D/2 cut for a chosen travel direction + the
  two half-planes tinted WARM (hotter, toward travel) / COOL (colder) with
  HOTTER/COLDER labels + a travel arrow. Direction defaults toward the
  play-area centre and is TAP-to-aim (the seeker picks it by walking, so it's a
  planning aid, not saved on the question).
- **Reframes on distance change** — the map `fitBounds`-animates to the new ring
  whenever the carousel distance changes, so the ring always fits (the old
  `ZonePreviewMap` only fit once on load, so a big 15 km circle never showed).

**v1004 — closer/further overlay: − is closer, + is further.** Corrects the
v1003 mapping — minus = LESS distance (closer, the "yes"/lighter region), plus =
MORE distance (further, the "no"/darker region). Swapped the two
`makePatternImage` symbols + the `isYes` shade check in lockstep.

**v1003 — measuring closer/further overlay uses +/− instead of </>.** The
configure-card impact overlay's measuring tile patterns (`registerImpactPatterns`
/ `makePatternImage`, `InlineLocationPicker`) draw `+` for the CLOSER ("yes")
region and `−` (U+2212) for the FURTHER ("no") region, replacing the `<`/`>`
arrows — clearer "closer = plus, further = minus". The `isYes` backdrop-shade
check + the symbol union type were updated in lockstep so `+` still gets the
lighter closer tint. Matching keeps `=`/`≠`; tentacles unchanged.

**v1002 — headless pmtiles read: the basemap water is DETERMINISTIC (no map/idle
race).** The `querySourceFeatures` capture (v998) only sees tiles a DISPLAY map
has loaded, tying the water geometry to the map's viewport/zoom + an `idle` race
— the root of the "overlay reveals before it's ready / sometimes never loads"
fragility. New `src/maps/api/basemapTiles.ts` (`fetchBasemapLayerPolys`) reads
the SAME pmtiles archive we already ship straight off R2 via range requests at a
FIXED zoom (≈12, bounded to ≤24 tiles), decodes the MVT with
`@mapbox/vector-tile` + `pbf`, and returns the layer's polygons in lng/lat —
independent of any map. `basemapWater.ts` `ensureBasemapWaterForArea(bbox)` runs
it once per play area (memoised), REPLACES the cache with the authoritative
headless set + marks the entry `headless` (the `querySourceFeatures` capture then
stops writing to it), and bumps `basemapWaterVersion`. The body-of-water /
same-landmass / coastline eliminations AND the nearest-water/coast labels all
`await ensureBasemapWaterForArea(...)` before reading the sync helpers, so the
water is ready when the elimination runs — the overlay no longer depends on a map
having idled. Purely additive + gated: every failure path (no URL, decode error,
empty) is a silent no-op that falls back to the v998 capture, so worst case is
identical to v1001. New direct deps `@mapbox/vector-tile` + `pbf` (both tiny;
lockfile refreshed). NOTE: validated by build only — the pmtiles/MVT decode
against the live archive is confirmed on-device (the sandbox can't reach the
archive host); every failure degrades to the capture path, so a decode mismatch
can't regress below v1001.

**v1001 — body-of-water reliability + two more map-based migrations
(same-landmass, coastline).**
- **Body-of-water "overlay never loads" / bare-map reveal fixed.** The configure
  veil gates on `impact !== null`, so a bare-map reveal meant the buffer tripped
  the veil TIMEOUT, and "never loads" meant it hung/returned null — both because
  buffering the RAW MVT ocean (dozens of tiles, tens of thousands of vertices)
  was slow/fragile. `measuring.ts` now SIMPLIFIES each basemap water polygon
  (~30 m, negligible vs a ≥km buffer) before it goes downstream, so the buffer is
  fast + robust; the veil holds until the overlay is ready then lifts with it.
- **`same-landmass` (matching) → basemap water** (`basemapLandParts`): land = the
  play-area frame MINUS the basemap water, split into connected polygons (the
  distinct landmasses). The polygon containing the seeker is their landmass, so
  NYC's East River / harbour correctly split Manhattan / Brooklyn+Queens / Bronx /
  Staten Island — the SAME authoritative water the map draws. Replaces the
  fragile `seaFromCoastline` assembly + the global-continent fallback (the v990
  "entire Americas" bug). Falls through to the per-city OSM land + frame-bounded
  coarse land when no map has captured the water yet.
- **`coastline` (measuring) → basemap ocean** (`basemapCoastLines`): the ocean
  SHORELINE = the boundary of the basemap water ocean/sea/bay polygons (`kind`),
  unioned (dissolves the tile-seam edges) with the frame edges dropped. Fed into
  the existing 2 km strait-rule + buffer pipeline, and the nearest-coast LABEL
  (`fetchNearestCoastline`) reads the same source so label == cut. Gated: only
  engages when the local sea is tagged ocean/sea/bay; otherwise falls through to
  the per-city OSM coastline → bundled 1:50m, so it never regresses.
- **`same-street` deliberately NOT migrated** — Protomaps generalizes the `roads`
  layer by zoom (minor/residential streets only at z13-14+), so reading streets
  off a zoomed-out configure map would MISS small roads. The prewarmed
  `/api/streets` set is complete + Overpass-free for warm cities, so the basemap
  would be a downgrade. Left as-is.
The `basemap-water` capture now also records each water feature's `kind` (for the
ocean filter) alongside `name`.

**v1000 — body-of-water is JUST the map water (drop coastline + OSM + the
`__waterArea` hack).** The map's `water` layer already contains every shoreline
(as polygon boundaries), so the separate coastline fetch was redundant — and
the earlier collapse wasn't "use the map" failing, it was the LABEL still using
OSM (said 1.0 km) while the elimination used the map (the East River, ~metres):
they disagreed. Now BOTH read only the basemap water:
- **Elimination** (`measuring.ts` body-of-water): `getBasemapWaterPolys` returns
  the basemap water polygons and they're buffered as NORMAL targets — buffering
  the real water gives the open sea (inside → distance 0 → closer) AND the
  near-shore land band, and the radius `r` = seeker → nearest water. No
  coastline, no OSM `natural=water`, no `__waterArea`. Cold fallback (no map has
  captured water yet) keeps the OSM-water + coastline-lines path.
- **Label** (`nearestBasemapWater` in `basemapWater.ts`, used first by
  `fetchNearestWater`): nearest point on any basemap water polygon (0 if inside),
  named from the tile's `name`/`kind` (else "Shoreline"/"Water"). Reads the SAME
  polygons the elimination buffers, so the label distance == the buffer radius by
  construction — the overlay and the label always agree. Falls back to the OSM
  path only when no basemap water is captured.
The capture now keeps each water feature's `name`/`kind` so the label can name
the body. `__waterArea` handling stays in `bufferAndUnion` for any other caller
but body-of-water no longer uses it.

**v999 — body-of-water fix: basemap water is `__waterArea` (not a buffered
target), restoring the overlay.** v998 shipped the basemap-water sea but made
the water polygons NORMAL buffered targets, so `bufferAndUnion`'s radius `r`
collapsed to the seeker's distance to the nearest water POLYGON (NYC's East
River, ~metres away) instead of the labelled shoreline (1.0 km) — shrinking the
whole "closer" region to an invisible sliver (the reported "no overlay"). Fix:
the basemap water is tagged `__waterArea`, so it's unioned in AS-IS (open sea →
distance 0 → closer) but EXCLUDED from the radius min; the coastline LINES are
ALWAYS added as the BUFFERED target, so `r` = the real shoreline distance that
matches the nearest-reference label, and the near-shore land band is drawn
correctly. This also re-enables the retry-without-sea degradation (the sea is
`__waterArea` again, so `noSea` is a strict subset) and guarantees an overlay in
every case: basemap water + coastline band (normal), water-as-is only (no
coastline), or coastline band only (no basemap water).

**v998 — body-of-water sea from the BASEMAP's own water layer (throw away
coastline assembly) + `--capitals-first` prewarm.**
- **The land/water map is the basemap we already ship.** Every prior sea attempt
  (v976–v997) reconstructed the ocean from OSM `natural=coastline` LINES —
  polygonize / flood-fill / raster — and every one mislabeled NYC's harbour
  because coastline assembly on dense real data is fundamentally fragile (and
  un-testable offline). The Protomaps basemap in our offline pmtiles ALREADY
  carries a `water` source-layer: the ocean, bays, lakes and wide rivers as real
  polygons, correctly assembled globally by Protomaps' pipeline. That IS the
  authoritative land/water map. `src/maps/api/basemapWater.ts`
  (`captureBasemapWater` / `getBasemapWaterPolys` / `attachBasemapWaterCapture`)
  reads those polygons straight off a loaded MapLibre map via
  `querySourceFeatures("protomaps", {sourceLayer:"water"})` — the SAME pattern
  the hider POI overlay uses for `pois` — accumulating them across map `idle`s
  (tiles load progressively) into a per-play-area cache. The configure map, the
  seeker map and the hider map all attach a capture on load, so the current
  question's play-area water is captured before its elimination runs.
- **body-of-water now buffers the REAL water.** `measuring.ts` body-of-water
  pushes the basemap water polygons as NORMAL buffered targets (alongside OSM
  `natural=water` + rivers): buffering the accurate ocean boundary by the
  seeker's nearest-water distance gives BOTH the open sea (distance 0 → closer)
  AND the near-shore land band (within the distance → closer), and the
  min-distance naturally equals the shoreline distance the nearest-reference
  label shows — no `__waterArea` special-case, no coastline lines, no
  `seaFromCoast`/`seaFromCoastline`/polygonize/flood-fill. FALLBACK (no map has
  captured water yet — rare): the per-city coastline LINES buffered (near-shore
  band only, open water reads "further" until the basemap water lands, which
  busts the memo). The memo key folds in a `basemapWaterVersion` so a compute
  that ran before the water arrived is re-run once it does; `questionImpact.ts`'s
  measuring effect depends on the same version so the preview fills the sea in.
  The measuring preview shares `measuringDraftBuffer`, so preview == elimination.
- **`--capitals-first` prewarm flag** (`laptop-prewarm.mjs`): with
  `--priority-regions`, warm each priority region's NATIONAL capital (Paris,
  Berlin, Madrid, Rome, Amsterdam, Vienna, Stockholm, …) BEFORE that region's
  other cities, so EU/Nordic capitals light up early instead of only after the
  whole US/GB/CA long tail. `CAPITAL_BY_COUNTRY` maps ISO country → capital name
  (matched against the reconciled world-cities.json names); capitals order among
  themselves by region tier, non-capitals keep the region-tier + population
  order. Opt-in (leaves a running warm's order unchanged unless passed).
- Progress check for starred primaries + adjacents:
  `GET /admin/adjacent-curation-status?secret=…&scope=seed&top=60&limit=200`
  (auth via `?secret=` or `Authorization: Bearer`) — runs the real R2-key
  boundary/refs/stations checks per city on the primary AND every adjacent, and
  reports `{targets, probed, fullyCached, stampedFully, cities:[{name,
  primaryCached, neighboursCurated, adjacentsCurated, fullyCached, …}]}`.

**v997 — body-of-water sea: ray-cast raster → RASTER FLOOD-FILL 2-COLORING
(fixes the v996 noise) + measuring reference ICONS restored + `useRaster`
gating.**
- **Sea build corrected.** v996's ray-cast raster (cell→seeker crossing parity)
  was fast but NOISY on convoluted coasts — a ray to the seeker grazes a
  crinkled shoreline at shallow angles and miscounts crossings, giving a patchy
  overlay ("fast this time, but not correct"). Replaced with a **raster
  FLOOD-FILL 2-COLORING** in `rasterSea`: rasterize the clipped coastline into
  gap-free WALL cells (dense ½-cell segment sampling so a wall never leaks),
  label the connected components of non-wall cells (BFS 4-conn), build component
  ADJACENCY across walls (two distinct component labels among a wall cell's
  8-neighbours are separated by that wall → a land↔water FLIP), then 2-COLOUR
  from the KNOWN-land seeker's component and emit the water cells as unioned
  run-rectangles. Purely topological — winding-independent, immune to the
  ray-count noise AND to `turf.polygonize` failure (the v994 root cause), and
  correct for islands (each landmass is its own component coloured via the flip
  chain). Validated offline on synthetic open-coast / island / two-rivers /
  diagonal cases (all correct after the gap-free dense wall sampling).
- **`useRaster` is now GATED.** Body-of-water + same-landmass (the worker
  `seaFromCoast` / `landFromCoast` ops) pass `{useRaster: true}` — they only
  need a topologically-correct sea (open water = closer). The `coastline` 2 km
  strait rule (`coastlineStrait.ts`) does NOT — its 1 km erosion/dilation needs
  SMOOTH geometry, so it keeps the PRECISE polygonize path (the raster's blocky
  shore would break the morphological opening; the strait-rule tests confirm
  polygonize is right there, and a fully-interior lake ring is a documented
  polygonize limitation on that path → null → the caller falls back to
  unfiltered lines).
- **Measuring reference ICONS restored (v988 regression).** The
  `rasterizeIconBadge` → `addImage` → symbol-layer path (park / museum / any
  measuring subtype glyph) silently fell back to plain circle DOTS because the
  registration effect bailed at `!map` while the configure map was still
  initialising and — its deps not including map-readiness — never re-ran. Now
  `InlineLocationPicker` tracks a `mapReady` state (set in the map's `onLoad`)
  and the icon effect depends on it, so the glyph registers once the map exists;
  it still degrades to dots on a genuine rasterize failure, as designed.

**v996 — body-of-water sea: ROBUST ray-cast raster replaces the fragile
polygonize (`seaFromCoastline`).** v994's seeker-seeded flood-fill was correct in
theory but depended on `turf.polygonize` producing clean faces — which FAILS on
dense real-world coastline (NYC's harbour + tidal rivers are many separate
`natural=coastline` ways that polygonize can't node into faces), so the sea came
back null and open water STILL read "further" even though the coastline BAND drew
fine (v995's screenshots). Replaced polygonize as the PRIMARY sea builder with a
**ray-cast raster** (`rasterSea`): grid the play-area frame, and a cell is WATER
iff the segment from its centre to the KNOWN-land seeker crosses the coastline an
ODD number of times (each crossing flips land↔water). NO polygonize, NO winding
assumption — robust, winding-independent, and correct for islands (a ray through
an island loop crosses it twice = even = land; validated offline on a synthetic
harbour + island). Water cells are merged into horizontal run-rectangles and
unioned into a (blocky) polygon — fine for OPEN water, which is all it supplies;
the precise near-shore comes from the separately-buffered coastline lines.
Adaptive grid resolution (N chosen so N²×segments ≤ 9M ops, clamped 32–80) keeps
a dense metro coast fast. The polygonize/flood-fill path stays as a fallback. The
seeker-in-sea guard is skipped for the raster (it's seeker-authoritative by
construction). Fixes body-of-water open water AND `same-landmass` (both go
through `seaFromCoastline` / the `seaFromCoast` worker). The fully-interior lake
ring that the old polygonize couldn't resolve now resolves correctly (the
`coastlineStrait` test was updated: `[]` — a sub-2 km lake is not ocean-grade
coastline — instead of the old `null` fallback).

**v995 — body-of-water: the sea can never be silently dropped from the union
(`bufferAndUnion` hardening).** Follow-up hardening to v994's flood-fill sea.
`bufferAndUnionImpl` (`geometry/worker.ts`) unioned all parts AT ONCE and, on ANY
`turf.union` throw, fell back to `parts[0]` — the FIRST **buffered target** — so
an invalid simplified sea (or any bad part) silently DROPPED the sea polygon,
leaving open water reading "further" even when the flood-fill produced a correct
sea. Now the parts are assembled **water-areas FIRST** (the sea), then the
buffered targets, and the union is **INCREMENTAL**: the accumulator starts with
the sea and each subsequent part is unioned in with its own try/catch, so a
per-part failure skips only that part and the sea is ALWAYS in the result.
Validated end-to-end offline (synthetic continuous coast + inlet): open water =
closer, the land boundary sits at the seeker-distance `r` inland (NOT at the
shore), and the inlet is water — confirming v994's flood-fill + this union
produce the correct "closer to water" region. (The earlier screenshot showing
water "further" + the boundary hugging the shore was the pre-v994 state — the
sea polygon was null, which is BOTH why water read "further" AND why the boundary
sat at the shoreline instead of `r` inland; they're one root cause.)

**v994 — body-of-water sea ROOT-CAUSE fix: seeker-seeded flood-fill face
labeling (`seaFromCoastline`).** Even with the detailed coast (v993), open water
still read "further" — the sea polygon was coming back NULL. Root cause found by
instrumenting the face labeling on real NYC coast: `seaFromCoastline` tiled the
play-area frame into faces (coastline + frame edges) and labeled each land/water
by the OSM **right-of-way winding** (water = right of the way direction) sampled
at the face's interior — but on real data EVERY NYC face read the SAME sign
(Natural Earth's coarse winding doesn't match OSM's land-left/water-right, and a
big concave face's centroid-nearest-segment side is unreliable), so **0 water
faces → null → no sea → open water wrongly "further"**. Replaced the fragile
per-face winding test with a **SEEKER-SEEDED FLOOD-FILL 2-COLORING**: the seeker
is KNOWN land (a real player stands on land), the coastline separates land from
water, and two INTERIOR faces can only share a COASTLINE edge (a frame edge
borders exactly one face), so every face-adjacency is a land↔water FLIP. Seeding
the seeker's face land and BFS-flipping across each adjacency 2-colors the whole
tiling — **winding-INDEPENDENT and topological**, immune to the all-same-sign
failure, and it naturally handles NYC's archipelago (Manhattan-as-island, Staten
Island, Governors Island each seeded correctly relative to the mainland). The old
winding test is kept ONLY as a fallback for when the flood-fill can't seed
(seeker outside every face). Fixes body-of-water open water AND `same-landmass`
(both go through `seaFromCoastline` / `seaFromCoast` worker). Semantic change: a
seeker on the winding-"water" side is now trusted as land (sea drawn on the
opposite side) instead of returning null — the `seaFromCoastline` unit test was
updated to match (6 cases pass). The coarse 1:50m fallback is still hopeless for
a metro (only ~5 giant faces, one spanning Manhattan + the harbour), but the
detailed prewarmed coast (v993) has enough faces for the flood-fill to resolve.

**v993 — body-of-water sea uses the DETAILED prewarmed coast (not the crude
coarse ocean).** v987 folded open water back in as an area but used the coarse
bundled 1:50m ocean — a jagged ~13-vertex polygon that didn't follow the real
shoreline (the "wrong in weird ways" bays/inlets). We ALREADY prewarm the
detailed OSM coast (`/api/coast/<id>`), so the sea is now built from THAT:
`fetchAreaCoastlineLines()` → **`seaFromCoast`** (the off-main-thread worker op,
v984) → **`turf.simplify` ≈150 m** (invisible against a hundreds-of-metres water
buffer, but keeps the downstream UNBUFFERED union fast — the raw harbour sea is
tens of thousands of vertices, the historical union-timeout cause of v980-v985).
Tagged `__waterArea` so `bufferAndUnion` unions it AS-IS and excludes it from the
buffer radius (v987). Falls back to the coarse 1:50m ocean (v987) if the detailed
sea is unavailable/rejected — monotonic, never worse. **Union-timeout safety
net:** `bufferedDeterminer`'s body-of-water branch now RETRIES `bufferAndUnion`
WITHOUT the `__waterArea` sea if the first union fails, so a sea-union timeout
degrades to a partial overlay (ponds + rivers + coastline-lines band) instead of
NO overlay (the v982-v985 "no overlay" regression). Detailed coast is prewarmed
for warm cities, so this is Overpass-free there; a cold coastal city fetches it
live once (then warm).

**v992 — same-street is PREWARMED (Overpass-free for warm cities) via a new
`/api/streets/<id>` endpoint.** Follow-up to v991, which moved same-street off
the position-keyed `around:500` live query onto ONE cacheable `[highway]` poly
query — but the FIRST fetch in a cold area was still live Overpass. Now the
NAMED-highway geometry is prewarmed by the SAME relation-id pattern as
`/api/coast` / `/api/water`: **`GET /api/streets/<relationId>`**
(`handleStreetsByRelation`) derives the boundary extent server-side and rebuilds
`buildStreetsBboxQuery` (`STREET_FILTERS` = `["highway"]["name"]`, 2 km pad,
`[timeout:180]`, `out geom`) — served from R2. Warmed per-city by the cron
(**Phase 2f**, `prewarmStreetsForCity`, opt-out `STREET_PREWARM_ENABLED="false"`),
the laptop (`streetQuery`, byte-identical, `--skip-streets`, `/api/reference-filters`
sync via `streetFilters`), and on-demand `?warm=1` (`warmRelationStreets`).
Client (`src/maps/api/streets.ts`): `fetchPrewarmedAreaStreets()` fans the
endpoint over every play-area relation and returns raw elements (geometry + node
ids + tags); `matching.ts` same-street reads it FIRST — nearest NAMED street
within 120 m → union the same-name ways, entirely Overpass-free — and falls back
to the v991 live cacheable `[highway]` poly query (firing `?warm=1` so the NEXT
game is warm) for the unnamed-nearest / cold cases, then the degenerate
`around:500`. Named-only (the unnamed footway/service mass excluded) keeps the
prewarm feasible; the client's live path still handles unnamed nearest. NOT in
the star gate yet (like water/coast).

**v991 — same-street question: no more per-question LIVE Overpass (reliability
over speed).** The `same-street-or-path` matching question fired a
POSITION-KEYED `way["highway"](around:500,lat,lng)` query for step 1 — the exact
coords make a unique query string → guaranteed R2 cache MISS → LIVE Overpass on
EVERY same-street question (the rate-limit-and-fail risk the user flagged; same
anti-pattern as v640's `around:GPS`). Rebuilt so the WHOLE question is computed
CLIENT-SIDE from ONE CACHEABLE fetch: `findPlacesInZone("[highway]")` is a
poly-scoped query the worker caches in R2, so a warm play area serves every
same-street question Overpass-free. Nearest way (named OR unnamed), the same-name
union, and the unnamed intersection-to-intersection segment (rulebook p162) all
derive from that single fetch — the unnamed-segment intersection logic was
extracted into a pure `unnamedSegmentFromElements(way, seekerPt, otherWays)` that
reads shared node ids from the cached highway set instead of its own targeted
`way(id)→node(w)→way(bn)` query. The old small `around:500` live query survives
ONLY as a degenerate fallback when the area fetch returns nothing (a huge/failed
area) — the rare path, not the per-question default. Speed is not crucial (the
area fetch is heavier), reliability is: after one successful fetch it's an R2 hit
forever. NOT prewarmed yet (a `/api/streets/<id>` endpoint like water/coast is
the follow-up to make even the FIRST fetch Overpass-free for starred cities).

**v990 — same-landmass fallback no longer returns a CONTINENT.** When the
per-city land path (`fetchAreaLandPolygons`) fails (per-city coast unavailable /
degenerate), `same-landmass` (`matching.ts`) fell back to closing the bundled
1:50m coastline GLOBALLY — which yields whole CONTINENTS: a Manhattan seeker got
all of the Americas (~37M km²) as "one landmass", so EVERY hider matched (verified
offline). That's strictly worse than no answer. The fallback now builds a
FRAME-BOUNDED coarse land instead — clip the bundled coastline to the play-area
frame and close it against the frame via `seaFromCoastline` (the same
construction as the v987 body-of-water coarse ocean), then land = frame minus
sea. Verified: NYC now yields ~280 km² bounded land with the seeker correctly
inside (was 37M km²). Coarse (may not resolve a narrow strait like the East
River — that's what the per-city path is for), but bounded to the play area and
never a continent; if `seaFromCoastline`'s guard rejects (seeker-in-sea / no
in-frame coast) it degrades to "the whole play area is one landmass" (a sane
degraded answer), and a total failure leaves the honest "couldn't determine your
landmass" error. The NORMAL per-city path is unchanged.

**v989 — sea-level shows a reference NUMBER (the seeker's elevation).** The
`sea-level` measuring subtype resolved to `null` in `resolveFamily`
(`NearestReferencePreview.tsx`), so the configure card's "Your nearest
reference" box showed nothing — but sea-level's "reference" is the seeker's OWN
elevation, not a distance to a place (rulebook: closer to sea level = smaller
|elevation|). Added a `sea-level` family + `fetchNearestSeaLevel`, which samples
the prewarmed Terrarium DEM (`buildElevationField`, the SAME source the sea-level
elimination isobands) at the seeker's point and formats it in the player's units
("12 m above sea level" / "40 ft below sea level" / "at sea level"). Carried via
a new optional `NearestRef.detail` that overrides the distance readout in the
preview's measuring slot. Returns null (→ preview hidden) if the DEM is
unavailable, so nothing breaks off-grid.

**v988 — measuring reference ICONS are back, as a GPU symbol layer.** v981
replaced the measuring reference field's per-subtype ICON markers with plain GPU
circle DOTS because the icons were hundreds of React `<Marker>`s that froze the
main thread (the perf hit was the HTML markers, NOT the icons). Now the field
renders as ONE GPU **`symbol`** layer with the recognisable subtype glyph:
`rasterizeIconBadge` (`InlineLocationPicker.tsx`) draws the Lucide subtype icon
(`iconForSubtype`) into a circular badge `ImageData` via
`renderToStaticMarkup` → `<img>` → canvas, and `map.addImage`s it (keyed by
subtype + basemap brightness, re-registered on `styledata` since a style swap
wipes added images). The layer uses **`icon-allow-overlap:false`** so MapLibre
auto-declutters any count into a readable subset at each zoom — no manual cap,
zero React-marker cost. Fully guarded: the async rasterize/addImage sets a key
only on success; until then (or on any failure) the plain circle-dot layer
(v981) shows, so it degrades cleanly. `react-dom/server` folds into the existing
`vendor-react` chunk (no new large chunk; the picker is lazy-loaded anyway).
Matching/tentacles keep their labelled markers (few after the border/reach
filter).

**v987 — body-of-water: fold OPEN water back in as an AREA (coarse ocean) +
thermometer configure dialog redesign.**
- **Body-of-water open water.** v985 dropped the sea AREA entirely (buffer =
  ponds + rivers + coastline LINES only), so open water beyond the ~seeker-
  distance band read "further" — impossible, since open water IS water (the
  repeatedly-reported Hudson / harbour bug). The fragile per-city DETAILED sea
  (`seaFromCoastline` over the OSM coast) is what froze the app / timed out the
  worker's `turf.union` across v980–v985, so it stays out. Instead the
  elimination now rebuilds the **COARSE ocean** from the bundled 1:50m coastline
  (only ~13 vertices inside an NYC frame → `seaFromCoastline` runs instantly on
  the main thread, no timeout risk) and folds it into the buffer input tagged
  **`__waterArea`**. The geometry worker's `bufferAndUnionImpl` (`geometry/
  worker.ts`) now SPLITS tagged water areas from buffer targets: the coarse
  ocean is unioned in **AS-IS (never buffered)** and **excluded from the
  buffer-radius min**, so a coarse/imprecise sea shore can't shrink the "closer
  than my nearest water" radius (which must keep matching the nearest-reference
  label). The detailed coastline LINES band still fills the narrow tidal
  channels (East River) the coarse ocean is too coarse to resolve. Guarded
  degradation: if `seaFromCoastline` rejects the coarse sea (seeker-in-sea /
  degenerate / near-whole-frame), we fall back to lines-only (the v985
  behaviour) — a monotonic improvement, never a regression. Known remaining
  limitation: the exact centreline of a wide channel (>~seeker-distance from any
  detailed shore) that the coarse 1:50m ocean also doesn't reach can still read
  "further" — the full detailed sea is the only complete answer and it's the
  thing that froze, so it's deliberately not reintroduced.
- **Thermometer configure dialog** (`ThermometerConfigureDialog`) now mirrors
  the radar picker (v747): the 2-column preset grid became a prev/next
  **distance CAROUSEL** (one prominent target, ChevronLeft/Right cycle the
  size-gated presets; the `askOncePerQuestion` house rule skips used presets, a
  repeat shows the N× badge) plus a **travel-distance MAP** — a `ZonePreviewMap`
  circle of the chosen distance around your live GPS, so you see how far you'll
  have to move to finish (dashed placeholder until GPS resolves / a distance is
  picked). The "We'll request a fresh GPS fix…" hint was removed.

**v986 — trip planner: clamp implausible ACCESS/EGRESS walk legs (worker).**
MOTIS routes the access walk to its GTFS stop coordinate — sometimes a few
hundred metres off the nearest entrance / a far end of a long station — so a
~200 m straight-line gap could come back as a 10-min access walk, jarring next
to the direct-station card's honest 3-min estimate (the reported "walk to 66 St
is 3 min here but 10 min inside the Grand Central trip"). `dispatchPlan`
(`overpass-cache/src/travel/router.ts`) now runs `clampAccessEgressWalks` on the
returned journey: the FIRST and LAST legs, if they're walks whose routed
duration exceeds 2.2× the straight-line estimate AND 4 min, are shortened to the
estimate — the access walk by moving its `departAt` later (you leave later), the
egress walk by moving its `arriveAt` earlier (you arrive sooner). Transit legs'
schedules never move (only the first/last walk); mid-trip transfer walks are
left alone. Worker-side, auto-deploys with the overpass-cache build; validated
in production (sandbox can't reach MOTIS).

**v985 — body-of-water: drop the fragile sea POLYGON entirely (reliable
overlay).** The sea polygon (`seaFromCoastline`) was the recurring failure: it
froze the main thread (v976), and once moved off-thread (v984) the `turf.union`
of that many-thousand-vertex polygon TIMED OUT the worker → the whole
body-of-water buffer returned null → NO overlay drew at all (the v982-onward "no
overlay" regression). v985 removes the sea polygon from the buffer input: the
elimination is now `bufferAndUnion(water polys + rivers + per-city coastline
LINES)` — buffered by the seeker distance, a coastline line covers the
near-shore band on both sides AND narrow tidal channels/rivers (the Hudson, the
East River), so the overlay ALWAYS renders now. Trade-off: wide OPEN water
beyond the buffer band isn't covered as area (a known fidelity gap vs. the sea
polygon), to be re-addressed with a cheaper sea representation. Removed the now-
dead `seaFromCoastline`/`seaFromCoast` imports + `SEA_VERTEX_CAP`/`countCoords`
from this path (`seaFromCoastline` stays live via `coastlineStrait.ts` /
`same-landmass`).

**v984 — body-of-water NO-OVERLAY regression fixed + generalized off-thread
buffer (`bufferAndUnion` worker) + Hudson-as-"Coastline" label.**
- **Regression:** v982's double-slash URL fix made `fetchCoastline` actually
  RETURN data (the global 1:50m coastline). The body-of-water coarse-ocean
  fallback then ran `turf.lineToPolygon` over the WHOLE world's coastline
  (~100k vertices) — a multi-second stall that left the elimination with NO
  overlay (before the URL fix, `fetchCoastline` threw and this block was never
  reached). Fixed by CLIPPING the coastline to the play-area frame
  (`clipLinesToBbox`) BEFORE `lineToPolygon`.
- **Generalized off-thread measuring buffer.** New geometry-worker op
  **`bufferAndUnion`** (`geometry/worker.ts` + `client.ts`) does the SAME
  buffer-every-reference-by-the-seeker-distance-then-union that arcgis's
  `arcBufferToPoint` does, but with turf for ANY geometry (points/lines/
  polygons), so it runs in the worker. `bufferedDeterminer` routes
  **body-of-water** through it (ponds + rivers + the sea AREA) — arcgis choked
  on the sea's vertices (froze / returned null → no overlay); this computes the
  same region off the main thread. Falls back to arcgis if the worker is
  unavailable / returns null. (Point families still use `bufferPointsUnion`;
  coast/borders still use arcgis for now — `bufferAndUnion` can absorb them
  later.)
- **Hudson-as-"Coastline" label.** For body-of-water, the coast fold-in is the
  shore of ANY water — the sea OR a tidal river bank (OSM tags the Hudson's
  banks `natural=coastline`). Labelling that "Coastline" is wrong (rulebook
  p218: a river isn't a coastline), so the body-of-water nearest-reference now
  reads the neutral **"Shoreline"**; the dedicated `coastline` subtype keeps
  "Coastline".

**v983 — body-of-water open water: progressive sea simplification (fit the
buffer cap).** v980's single 220 m sea simplification could still blow past the
`SEA_VERTEX_CAP`, so a dense harbour (NYC) SKIPPED the detailed sea and fell to
the coarse 1:50m ocean — which misses the bays, so open water read "further"
(impossible). The sea now simplifies PROGRESSIVELY (0.002° → 0.004° → 0.008° →
0.012°) until it fits the cap; coarser tolerances still preserve the km-wide
OPEN bays (the narrow tidal channels they drop are covered by the coastline
LINES band), so the sea is included far more often. Only if even the coarsest
(~1.3 km) sea is over the cap do we fall to the coarse ocean.

**v982 — ROOT-CAUSE: bundled-geojson fetches were double-slashed (broke border
gate + same-landmass + coastline fallback) + measuring dots on GPU + neutral
picker header.**
- **The big one — `//file.geojson` bug.** `fetchCoastline` / `fetchBorders0Land`
  / `fetchBorders1States` / lakes built their URL as
  `import.meta.env.BASE_URL + "/coastline50.geojson"`. `BASE_URL` is `"/"`, so
  that's `"//coastline50.geojson"` — a PROTOCOL-RELATIVE url that resolves to
  the bogus host `https://coastline50.geojson/` and always FAILED (the geometry
  worker used the correct no-leading-slash form, which is why worker paths
  worked). This silently broke EVERY bundled-dataset consumer: the measuring
  **international/state-border availability gate** (fetch threw → null → tile
  stayed enabled — the repeated "border not disabled" report; matching's admin
  gate worked because it's Overpass-based), **same-landmass**'s global-coastline
  fallback (→ no overlay), the **coastline** subtype's fallback, body-of-water's
  coarse-ocean fallback, and the lakes mask. Fixed to
  `BASE_URL + "coastline50.geojson"` (single slash). One-line-per-file fix, big
  blast radius.
- **Measuring candidate dots → ONE GPU `circle` layer** (`InlineLocationPicker`)
  instead of hundreds of React `<Marker>`s — THAT was the measuring park freeze
  (not the buffer, off-thread since v978). `measuringDotsFC` feeds a single
  `circle` layer that renders any count with zero React overhead; matching /
  tentacles keep the labelled icon markers (few after the border/reach filter).
- **Subtype-picker header** uses the normal `text-foreground`, not the category
  colour (the green "MEASURING" etc.).

**v981 — measuring park FREEZE root cause (marker cap) + toaster removal +
back-arrow styling.**
- **The measuring park/POI freeze was NOT the buffer** (that's off-thread since
  v978) — it was `InlineLocationPicker` rendering HUNDREDS of React `<Marker>`s
  (one per reference; NYC has hundreds/thousands of parks), which froze the main
  thread while the configure dialog opened. `visibleCandidates` now CAPS the
  measuring dots to the nearest 120 to the pin (`capMeasuring`); the buffered
  "closer/further" region (the actual answer) still uses the FULL candidate set
  in the impact math, so only the on-map density hint is thinned.
- **"Fetching coastline data…" / "Fetching …border data…" toasters removed** —
  `fetchCoastline` / `fetchBorders0Land` / `fetchBorders1States` dropped their
  `loadingText`; these are internal steps of body-of-water / coastline /
  same-landmass / the border-availability gate, so the configure dialog owns
  the loading state and no separate toaster leaks the implementation detail.
- **Subtype-picker back arrow** enlarged to `w-12 h-12` (size-22 icon) with
  `gap-4`, matching the two-line title+description block beside it.
NOTE (border gating): the international/state-border availability geometry is
VERIFIED correct — 0 of the bundled Natural Earth border features intersect
NYC's bbox, so `computeBorderPresent` returns false → the tiles disable. A
"still enabled" observation is async-timing / stale-PWA-cache, not the logic.

**v980 — body-of-water: fold the DETAILED sea back in (bays no longer read
"further"), freeze-guarded.** v976 dropped the fragile/slow per-city sea polygon
for a coarse 1:50m ocean (frame minus bundled land) to kill the ~10 s freeze —
but the 1:50m coastline is too coarse to resolve a metro's bays, so NYC's Lower
Bay / harbour / Jamaica Bay sat OUTSIDE the coarse ocean and rendered "further
from water" (impossible — open water IS water). v980 re-adds the DETAILED
per-city sea (`fetchAreaCoastlineLines` → `seaFromCoast` worker, v897 per-face
right-of-way labelling, seeker-not-in-sea guarded) as the primary sea source,
with two guards that make it a SAFE monotonic improvement over the coarse
fallback: (1) the sea is built OFF the main thread (worker), (2) it's simplified
to ~220 m AND gated on a **vertex cap** (`SEA_VERTEX_CAP` = 4000) before it
enters the arcgis geodesic buffer — the raw tens-of-thousands-vertex harbour
coastline is what froze the buffer, so if even the simplified sea is still too
dense we SKIP it and fall back to the coarse 1:50m ocean (the pre-v980 no-freeze
behaviour, never a regression). The coastline LINES band (near-shore + narrow
tidal channels) is unchanged. So: warm coastal metros whose simplified sea fits
the cap get correct bays; anything heavier degrades to the coarse ocean rather
than freezing. Still main-thread-buffered (arcgis can't go in a worker), just
bounded — a further win would be to union the RAW sea instead of buffering it.

**v979 — false "couldn't send" banner during heavy question load + endgame
card copy/gate.**
- **The bogus "Couldn't send — tap retry" card that flashed while configuring
  a heavy question** (park / body-of-water) is fixed. `promoteLastQuestion`
  (`AddQuestionDialog`) adds the draft to the `questions` store (drag:true, no
  createdAt), closes the picker, then opens the configure dialog 150 ms later —
  but `configuringQuestionKey` (which tells `PendingAnswerOverlay` to exclude
  the in-configure draft) was only set via the pendingKey effect that fires
  once the configure dialog opens. During that gap — which stretches to SECONDS
  when a heavy question freezes the main thread — the overlay showed the draft
  as an unsent "couldn't send" card even though nothing was sent. Now the guard
  key is claimed IMMEDIATELY in `promoteLastQuestion`, covering the whole gap.
- **Endgame card (`StationTransitCard`)**: (1) the "Start endgame here" button
  is now hidden unless the seeker's live GPS is actually within the tapped
  zone's hiding-radius (+150 m) — you can't declare the endgame before arriving
  (rulebook p43), and the server would deny it anyway; with no GPS fix it still
  shows (server makes the call). (2) Dropped the stale "or refutes it if you're
  at the wrong place" copy — the endgame is server-authoritative now (v950/v951,
  no manual hider refute); the card explains the server checks your location
  against the hider's zone.
Still open (need on-device verification / deeper work): body-of-water open-water
in un-resolved bays still reads "further" (coarse 1:50m ocean misses NYC's bays;
needs a raw detailed-sea union, not a buffer); measuring point-family candidate
marker density; border/county gating re-verify after this deploy; same-landmass;
coastline math; sea-level number.

**v978 — measuring batch: point-family freeze fix (Web Worker), subtype
naming, border gating, county-border overlay.** From the NYC walkthrough.
- **Measuring point-family FREEZE fixed (park / mountain / rail station / any
  *-full POI)** — the "closer than my nearest X" cut is the union of a disk
  (radius = distance to the nearest reference) around EVERY reference, which
  arcgis did in ONE synchronous WASM `executeMany` over hundreds/thousands of
  point-circles → seconds-long main-thread freeze (the reported "freezes the
  app" + the stuck body-pointer-events "can't click anything" aftermath). New
  geometry-worker op **`bufferPoints`** (`geometry/worker.ts` + `client.ts`
  `bufferPointsUnion`) does it with pure turf (circles + union) OFF the main
  thread — same pattern as the hiding-zones union. `bufferedDeterminer`
  (`measuring.ts`) routes the pure-point case there (via `allPointCoords`);
  lines/polygons (coast/borders/water) stay on the geodesic arcgis buffer, and
  arcgis is the fallback if the worker is unavailable. Safe: the hider grades
  measuring by DISTANCE, so the sub-metre turf-vs-arcgis cut difference never
  changes an answer.
- **Subtype naming in the configure header** (`questionOverlayCard.tsx`) —
  `subtypeLabel` fell to a raw hyphen-replace for ids it didn't hard-code, so
  the header read "rail measure ordinary" / "peak" / "park". It now falls back
  to the canonical `SUBTYPES` label ("Rail station" / "Mountain" / "Park") via
  `findSubtypeMeta`.
- **State-border gating** (`subtypeAvailability.ts`) — `admin1-border` (state
  border) had NO presence gate (only international-border did), so it stayed
  enabled in NYC even though no state border crosses the play area. Both border
  gates now test the border LINES against the play-area POLYGON (not just its
  bbox — NYC's bbox spans the Hudson and clips the NY-NJ border + the coast,
  neither of which enters the land polygon), so international + state border
  disable when no such border is actually inside the area.
- **County-border overlay fixed** (`measuring.ts admin2-border`) — the query
  was `way["admin_level"="6"]`, but a county boundary's tags live on the
  RELATION (member ways are untagged), so it returned NOTHING → no overlay
  (while matching county worked, since it fetches relations). Now fetches the
  admin_level=6 RELATIONS and converts each boundary polygon to its outline
  line for the seeker-distance buffer.
Still open from the same batch (need on-device geometry verification):
same-landmass NYC (fragile/slow `seaFromCoastline`), same-street live-query
fragility, sea-level reference number, coastline math.

**v977 — matching configure-overlay correctness: geodesic Voronoi + station-
length label.** Two NYC-walkthrough bugs where the "same nearest X" matching
PREVIEW disagreed with the labelled reference / the actual cut.
- **Geodesic Voronoi in the overlay** (`questionImpact.ts`
  `voronoiCellAroundMe`). The configure preview drew the "same nearest" cell
  with PLANAR `turf.voronoi`, but the real ELIMINATION
  (`determineMatchingBoundary` → `geoSpatialVoronoi`, `d3-geo-voronoi`) is
  SPHERICAL. At a city's latitude a degree of longitude is much shorter than a
  degree of latitude, so planar lng/lat cells are stretched E-W — which pushed
  the seeker's geodesic-nearest reference (the LABELLED one) into a neighbour's
  planar cell. Symptoms in NYC: matching PARK drew the labelled nearest park as
  "not matching", matching GOLF marked a different course as "matching". The
  overlay now uses the SAME `geoSpatialVoronoi` as the elimination (spherical,
  tiles the whole sphere so the seeker is always in exactly one cell whose site
  IS the geodesic-nearest), so preview == label == answer. (Airport, museum,
  every point-family matching type benefits.)
- **Station-length / train-line label uses the NARROW station set**
  (`NearestReferencePreview.tsx`). v970 broadened the rail reference to the
  prewarmed all-mode set (light rail / halts / tram, rulebook p206) — correct
  for the MEASURING rail question, but the MATCHING station questions grade
  against the NARROW `[railway=station]` set (`matchingStationBoundary`), so
  their nearest-reference LABEL now disagreed with the cut: the label read a
  subway platform ("Malcolm X Boulevard", 19 chars) while the elimination keyed
  on a short heavy-rail station ("116 Street", 10 chars), making the drawn "same
  length" region look wrong. The rail-station family now carries a `broad` flag
  (true only for `rail-measure*`); the matching station types resolve to the
  narrow set, so label == cut again.
Known remaining NYC matching/measuring issues (deeper geometry, follow-up):
same-landmass + measuring point-family freezes (the heavy `seaFromCoastline` /
`arcBufferToPoint` on the main thread), same-street live-query fragility,
border-presence disabling, county-border/sea-level previews, coastline math.

**v976 — body-of-water sea rebuilt: drop the fragile per-city sea POLYGON
(fixes the ~10 s freeze + water-marked-"further" in coastal metros).** The v973
attempt (simplify the per-city sea before buffering) did NOT fix NYC — the app
still froze mid-load and open harbour/East-River water still rendered "further
from water" (impossible: it IS water). Root cause was the per-city sea POLYGON
itself: `seaFromCoastline` (node → polygonize → right-of-way face labelling over
the DETAILED OSM `natural=coastline`) is both FRAGILE (a dense harbour mislabels
faces or fails to polygonize → the sea is wrong or null) and SLOW (tens of
thousands of coastline vertices → the geodesic buffer freezes the main thread
for ~10 s even after simplification). `measuring.ts` body-of-water now DROPS that
construction entirely and folds the sea in from two reliable sources instead (no
polygonize, no single huge polygon):
- **(a) The COARSE OCEAN as an AREA** — the play-area frame MINUS the bundled
  Natural Earth 1:50m land. Small, always well-formed, covers the open
  sea/harbour/ocean as real area so it reads "closer", never "further". Accepted
  unless clearly inverted: a degenerate/whole-frame ocean, or a seeker DEEP
  (> ~2 km from the ocean edge = genuinely offshore) is rejected; a COASTAL
  seeker who falls just inside the coarse ocean due to 1:50m imprecision is
  tolerated (the old strict seeker-not-in-sea guard rejected Manhattan and
  discarded the whole sea).
- **(b) The per-city OSM coastline as LINES** (`fetchAreaCoastlineLines` →
  `highSpeedBase`) — the shore, buffered by the seeker distance covers near-shore
  land AND the NARROW tidal channels (the East River) that the coarse 1:50m ocean
  is too coarse to include as area. Cheap (one combined + simplified multiline).
This is body-of-water ONLY; the `coastline` subtype (2 km strait rule, v969) and
`same-landmass` keep their own per-city land geometry. The v973 sea-simplify code
and the `seaFromCoast` worker / `seaFromCoastline` imports were removed from this
path (both now unused by measuring.ts; `seaFromCoastline` stays live via
`coastlineStrait.ts`). NOTE: the 2 km inlet exclusion is a COASTLINE-question rule,
not a body-of-water rule — body-of-water counts ALL water (canals/inlets/harbour).
Geometry can't be verified in CI; validate on-device (NYC).

**v974/v975 — distances follow the selected unit system (slices 2 + 3).**
Completes the v972 unit-system unification so EVERY distance in the app —
not just the rulebook — renders in the player's chosen units with the
creators' clean rounded numbers.
- **v974 — the actual SIZES** (radar / thermometer / tentacle). Radar
  carousel presets are unit-aware (imperial: 0.25/0.5/1/3/6/10/25/50/100 mi)
  sharing stable tier `sig`s so the one-per-game rule + saved games survive
  a unit switch (`sigForRadius` matches EITHER system's form); a new radar
  question is seeded in the user's units. The three duplicated thermometer
  preset copies collapsed into ONE shared module (`thermometerPresets.ts`)
  used by the configure dialog, the on-map tracker overlay, and the card —
  labels + the live km threshold + the tracker readout all convert (imperial:
  0.5/3/10/45 mi). Tentacle radius stamped in the selected units
  (2 km → 1 mi, 25 km → 15 mi). `gameRadius`/`gameDistanceKm` in `units.ts`
  are the shared producers. Tests in `tests/units.test.ts`.
- **v975 — the DESCRIPTIONS.** Measuring/tentacle tile distances
  (`subtypes.ts`: "within 2 km", "within 25 km", "250 km/h") and every curse
  distance in `hiderDeck.ts` ("within 150 m", "2 km (S) / 10 km (M) /
  50 km (L)", "30 m", …) are now `{{km:}} / {{m:}} / {{kmh:}}` TEMPLATES
  rendered through `applyUnitTemplates` at display time — the subtype picker
  tiles (`AddQuestionDialog`), the card body (`CardTile.renderBodyText`,
  applied BEFORE the (S)/(M)/(L) size collapse so a size-varying distance
  converts then reduces), and the seeker/hider curse inbox
  (`CurseInbox` → `renderBodyText`). One metric-authored source now serves
  both systems everywhere.

**v973 — body-of-water measuring: fix the freeze + water-marked-"further"
bug.** The body-of-water elimination pushes the detailed per-city SEA polygon
(`seaFromCoastline` over the full OSM `natural=coastline` — tens of thousands
of vertices in a harbour metro like NYC) plus every river + named-water body
into ONE `arcBufferToPoint` call. Two failure modes, both reported: (1) the
arcgis geodesic buffer of that raw geometry blocks the main thread for
seconds (the freeze); (2) on a dense metro the buffer THROWS, and the v965
throw-retry re-runs with a coarse `turf.simplify` that COLLAPSES small water
polygons so they drop out of the buffered "closer" region — painting real
water as "further" (the screenshot). Fixes: **(a)** `measuring.ts` simplifies
the SEA polygon to ~33 m up front (negligible against a hundreds-of-metres
water buffer) before it enters the buffer, so the buffer runs fast and
succeeds on the first, un-simplified attempt — no freeze, no throw. **(b)**
`arcgisOperators.ts` `arcBufferToPointImpl`'s retry now simplifies ONLY heavy
features (≥ `SIMPLIFY_MIN_VERTICES` = 40 vertices) and rejects a simplify that
collapses a feature below a valid ring — so a small pond can never be dropped
even if the retry path is hit. Both the configure-preview overlay and the real
elimination cut share `bufferedDeterminer`, so both are fixed.

**v972 — unify the unit system into ONE Settings toggle + curated
conversions.** There used to be TWO independent unit controls — the Settings
"Miles / Kilometers" picker (`defaultUnit`, which also sets a question's
stored radius unit) and a SEPARATE Metric/Imperial toggle in the rulebook
viewer (`unitPreference`) — which could disagree. Now `resolvedUnits`
(metric/imperial) DERIVES from `defaultUnit` (miles → imperial, else metric),
the rulebook's own picker was removed, and `units.ts` is the single source of
truth. Conversion is CURATED, not raw `× 0.621371`: `GAME_DISTANCE_TABLE`
(meters → clean imperial) encodes the creators' rounded numbers (160 km =
100 mi, 80 km = 50 mi, 2 km = 1 mi, 250 km/h = 150 mph, 500 m = 0.25 mi, …),
so rulebook + card + tile distances read as tidy imperial values.
`imperialMilesForMeters` exposes the paired value for the question presets.
**This is slice 1 of the app-wide "distances follow the selected unit system"
work — the radar/thermometer/tentacle PRESET sizes + card/tile descriptions
follow in the next slice.**

**v971 — rulebook audit Section D: cosmetic polish.** The low-stakes
tail of the audit:
- **Measuring tile copy** — 8 `-full` measuring subtypes read "Closer to
  a zoo?" etc.; now "Closer or further to …?" (matching the rest), since a
  measuring answer is always closer/further (`subtypes.ts`).
- **Radar repeat badge** — in rulebook-repeat mode (`askOncePerQuestion`
  off) a radar size can be re-asked at N× cost; the size carousel now shows
  the same yellow "N×" badge the thermometer picker uses
  (`cards/radius.tsx`).
- **RotateHiderDialog copy** — surfaces the two rulebook facts the app was
  silent on: the next round starts from the last hider's spot, and the new
  hider gets up to 10 min to plan (rulebook p81; the v970 planning-window
  countdown makes the latter live in the lobby too).
- **Stale comments fixed** — "16 curses transcribed" → all 24
  (`hiderDeck.ts`); "five question categories" → six (`categories.ts`).
- Deliberately NOT changed: the radar preset labels stay metric (they ARE
  the rulebook's canonical sizes — the custom slider already honours the
  unit preference); round order stays deterministic-round-robin (a house
  rule, and RotateHiderDialog lets you pick anyone); the late-answer stall
  isn't frozen live (the SCORE is already correct); deck 55/21/24 is the
  real rulebook deck (the 50/25/25 "suggested" ratio is a design note);
  `natural=peak` includes hills (no better OSM tag); manual pause stays
  device-local (documented).

**v970 — rulebook audit Section B: eleven missing mechanics.** The follow-up
to v969's Section A — every rulebook rule the audit found unimplemented:
- **Golf driving ranges / mini golf excluded** (rulebook p182). New
  `isExcludedGolfFeature(tags)` (`constants.ts` — `golf=driving_range|
  miniature` or a driving-range/mini-golf NAME) applied in
  `apiLocationMatches` (all cached-partition paths) AND re-checked
  client-side on the matching/measuring `*-full` eliminations' LIVE query
  results — label and cut agree, and the Overpass filter string (= every
  city's refs cache key) is untouched (the v933 fountain pattern).
- **Jammed Door rolls 2d6** (rulebook p396). `DiceRoller` gained a `count`
  prop (N dice + summed `onSettle`); `curseDiceCount` (`curseMeta.ts`)
  returns 2 for Jammed Door (+ a "two d6" description fallback); the
  `CurseInbox` dialog passes it.
- **Egg Partner / Lemon Phylactery blocked during the endgame** (their card
  text). `curseBlockedDuringEndgame(description)` (`castingCost.ts`) +
  `CastCurseDialog` gates the cast once `endgameStartedAt` is armed, with an
  explanatory notice (Move already had its own gate).
- **Drained Brain can't ban the just-asked question** (rulebook p392). The
  picker disables (and `toggleDrainedQuestion` refuses) the ids of UNANSWERED
  `hiderInbox` entries, in the picker's own id format.
- **One-active-blocking-curse limit spans task + transit blockers**
  (rulebook p386 covers every curse "preventing the seekers from asking
  questions or taking transit", not just the 3 UI-enforced ask-blockers).
  `cursePreventsAskingOrTransit` (`curseEnforcement.ts`) pools the
  before-asking task curses + the movement/transit blockers (Jammed Door /
  U-Turn / Gambler's Feet / Right Turn); a TIMED blocker auto-expires via
  `blockingCurseExpired` + the new `activeBlockingCurseCastAt` atom, so the
  hider isn't stuck manually clearing a curse that ran out. Unit-tested
  (`tests/curseBlockers.test.ts`).
- **Rail Station (measuring) covers light rail** (rulebook p206: "includes
  light and heavy rail; metros/subways count"). New
  `fetchPrewarmedRailStationElements()` (`journey/stations.ts`) = the
  prewarmed all-mode area-stations union filtered to train/subway/tram — so
  halts, tram stops and PTv2-only light rail count, Overpass-free for warm
  cities. Used by the `rail-measure-ordinary` elimination (live fallback
  broadened to `station|halt|tram_stop`) AND the nearest-reference label
  (`fetchNearest` rail-station branch), so label == cut.
- **10-minute planning window between rounds** (rulebook p81). New
  persistent `planningWindowEndsAt` set to now+10 min after a COMPLETED
  round (`startNewRound` + the guest `applyRoundStarted`), cleared on round
  start/reset; the lobby shows a `PlanningWindowBanner` countdown above
  Start. Informational — the host still starts the round (enforcement is
  social), the countdown just makes the allowance visible.
- **Endgame "off transit" condition enforced** (rulebook p75). The server
  keeps each seeker's previous fix (`prevSeekerPos`, slid at ≥8 s spacing)
  and `seekerLooksOnTransit` estimates speed over the last usable pair
  (dt ∈ [8 s, 3 min]); a claim from a seeker at the zone but moving
  ≥ `ENDGAME_TRANSIT_SPEED_KMH` (18) is DENIED with the new
  `endgameDenied.reason:"transit"` (additive optional wire field) — client
  copy/notifications + the `EndgameOverlay` fail card show "get off transit
  first" via the volatile `endgameDeniedReason` atom. Can't-verify still
  allows (friends-game bias), and a wrong-place denial reads `"off-zone"`.
- **Unnamed street/path = intersection-to-intersection** (rulebook p162).
  The `same-street-or-path` step-1 query now fetches ALL highway ways (not
  just named); an unnamed nearest way routes through
  `unnamedStreetSegmentBoundary` (`matching.ts`): a targeted
  `way(id)→node(w)→way(bn)` fetch finds the way's nodes shared with other
  highway ways (= physical intersections), the segment bracketing the
  seeker's nearest point (way endpoints count as boundaries) is sliced out
  and 25 m-buffered like the named case. The hider grade shares the boundary
  (the generic `hiderifyMatching` tail), so answer and cut agree.
- **US 4th admin division → OSM level 7** (rulebook p169's own example is
  NYC boroughs, which are L7 — Queens borough L7 beside coterminous Queens
  County L6; the generic tier4→9 found nothing). `TIER_OVERRIDES.US =
  [4,6,8,7]` (`adminDivisions.ts`); the US L7 label reads "Borough /
  Township".
- **Micro-enclave borders** (rulebook p210 "Enclaves count!"). The
  measuring `international-border` case folds the play area's own OSM
  `admin_level=2` border WAYS (a light poly-scoped way query — local
  segments incl. enclave rings like Baarle/Llívia/Büsingen, never
  whole-country relations) into the bundled 1:50m lines; best-effort, any
  failure keeps the bundle alone. The impact overlay shares the geometry
  (v840's measuring-geom path).

**v969 — rulebook audit Section A: seven correctness fixes.** From the full
start-to-finish rulebook read (`src/content/rulebook.md`), the seven places
the app disagreed with the printed rules:
- **A1 — hiding radius follows game size.** The seeker-side `hidingRadius`
  context atom (0.5 km persistent default) was never derived from `gameSize`,
  so a LARGE game ran the seeker zone overlay/analysis + the hider grace
  auto-commit at 500 m instead of the rulebook's 1 km (the zone-COMMIT path
  already used `radiusForGameSize`). `rulebookHidingRadiusKm(size)` +
  `syncHidingRadiusToGameSize` (`gameSetup.ts`) sync the atom on boot (heals
  stale installs) and on every size change; the ZoneSidebar manual radius
  field still works within a session.
- **A2 — Randomize's substitute earns the card draw.** The substitute is
  "answered as normal" (rulebook p376), but the spatial-randomize path never
  called `presentDraw` — the hider was shorted the category's draw (photo
  randomize already drew). `ResponseCardActions.playRandomize` (`HiderView`)
  now settles the late rule (`settleLateAnswer` — overdue banks overtime, no
  card) and presents `QUESTION_DRAW_BUDGET[category]` when on time.
- **A3 — same-landmass ENCLAVE rule.** "A landmass entirely surrounded by
  the seekers' landmass counts as a match" (rulebook p174) — an island in a
  lake inside the seeker's landmass is a separate polygon, so containment
  graded it "no". `determineMatchingBoundary` drops the seeker polygon's
  interior rings (lake holes), so enclaves fall inside the boundary.
- **A4 — coastline 2 km STRAIT rule.** Rulebook p218: coastline is only
  where land meets the ocean / a great lake / water connected to them by a
  waterway never under 2 km across — OSM `natural=coastline` traces every
  tidal channel, so the East-River class of shoreline wrongly counted. New
  `src/maps/questions/coastlineStrait.ts` (`filterCoastlineByStraitRule`,
  unit-tested in `tests/coastlineStrait.test.ts`): build the sea polygon
  (`seaFromCoastline`), ERODE 1 km (sub-2 km water vanishes), keep only
  ocean-grade cores (frame-touching = open sea, or ≥500 km² eroded = great
  lake — a wide bay whose only connection was a narrow strait disconnects
  and drops), DILATE back, keep the 0.5 km coastline chunks adjacent to
  qualifying water. Returns `[]` = the area genuinely has NO coastline
  (narrow water only); `null` = couldn't compute → the measuring `coastline`
  case keeps the UNfiltered lines (safe fallback — includes the
  fully-interior-lake-ring case seaFromCoastline can't polygonize).
- **A5 — sea-level compares |elevation|.** "Closer to sea level" is DISTANCE
  from sea level, not signed height: a hider at −50 m vs a seeker at +10 m is
  FARTHER. `seaLevelRegion` (`elevation.ts`) now bands isobands on
  `absElevation` — identical wherever terrain is all above sea level,
  correct in the Death-Valley/Dead-Sea case.
- **A6 — thermometer presets are strictly the rulebook set.** The house
  presets 500m/2km/10km are no longer selectable (`validSizes: []` —
  entries kept only so a legacy saved game's sig still resolves a label);
  the official set is 1 km (all) / 5 km (all) / 15 km (M+L) / 75 km (L).
- **A7 — Spotty Memory small-game d6.** Rulebook p397: Small games have five
  categories, so a 6 is a REROLL. `spottyCategoryForRoll(roll, size)`
  (`curseEnforcement.ts`) maps 1–5 to the five Small categories (no
  tentacles) and returns null on a 6; `CurseInbox`'s die `onSettle` toasts
  "Rolled a 6 … Reroll!" and leaves the roll unconsumed. Medium/Large keep
  the fixed 6-face mapping.

**v968 — Transit Line route picker is PREWARMED (Overpass-free for warm
cities).** v966's route picker made two LIVE Overpass queries — a position-keyed
`rel(around:GPS)[type=route]…` listing (the uncacheable v640/v750 anti-pattern)
and a per-route detail fetch — so a starred city still hit live Overpass. Now
it's prewarmed by the SAME relation-id pattern as `/api/metro` (v701): **`GET
/api/transit-routes/<relationId>`** (`handleTransitRoutesByRelation`) derives the
boundary extent server-side and rebuilds `transitRoutesQuery` — all rail routes
(`relation[type=route][route~subway|train|light_rail|tram|monorail]; out tags
geom; >; out tags;`, member geometry + stop-node names) — served from R2.
Warmed by the laptop (`processTransitRoutes`, byte-identical builder, rides the
`DO_TRANSIT` gate, `--skip-transit-routes` to drop) and on-demand `?warm=1`
(`warmRelationTransitRoutes`). Client (`overpass.ts`): `fetchPrewarmedTransitRoutes`
reads the endpoint FIRST (memoised per relation id); `findTransitRoutesNear`
filters that set to the allowed modes + near the GPS, `fetchTransitRouteDetail`
extracts the picked route's stops+geometry from it — both fall back to the live
query on a cold / non-relation area (firing `?warm=1`). The prewarm covers RAIL
modes only; a bus/ferry-allowed game supplements the listing with a live
`around:` query for just those (bus routes are too heavy to bundle, same lesson
as `body-of-water`/`area-stations`). NOT in the star gate yet (like water/coast).

**v967 — Transit Line grades against the committed HIDING ZONE.** Follow-up to
v966: `hiderifyMatching` (same-train-line) now checks whether the hider's
COMMITTED `hidingZone` station is one of the route's stops (via the shared
`coordIsRouteStop`, 150 m) instead of re-deriving the hider's nearest station
from GPS — that's the station the hider actually declared, so it's what the
answer should key on. Falls back to the nearest-station check only when no zone
is committed (solo pre-commit). Same 150 m predicate as the seeker elimination,
so the map cut and the answer agree.

**v966 — Transit Line matching question rebuilt to the rulebook (seeker picks
the route they're riding).** The rulebook (`src/content/rulebook.md`, the
Matching → Transit section) defines this question as: *"the answer is yes if the
transit the seekers are currently riding would stop at the hider's station"* —
seekers must be on MOVING transit and it's about THEIR line's stops, NOT the
auto-computed nearest station's lines. The old implementation matched every
way/relation sharing the nearest station's `name`/`network`, which drew the
WHOLE subway network and was conceptually wrong. Rebuilt end-to-end:
- **Data model:** `baseMatchingQuestionSchema.transitRoute?` (`schema.ts`) —
  `{ id, name, ref?, mode, stops:[{lat,lng,name?}], geometry? }`. Declared on
  the base schema so it survives the wire (Zod strips undeclared keys); only
  same-train-line populates it. The whole question object already crosses the
  wire (`addQ`), so no protocol change.
- **Route picker (`TransitRoutePicker.tsx`):** lists the transit routes near
  the seeker's live GPS (`findTransitRoutesNear` — `rel(around:R,gps)[type=route]
  [route~subway|train|light_rail|tram|monorail]`, filtered to the game's
  `allowedTransit` modes) and, on pick, fetches that route's stops + line
  geometry (`fetchTransitRouteDetail` — `relation(id);(._;>;);out geom;`,
  extracting stop/platform member nodes deduped by 60 m + the way vertices) and
  bakes them onto `data.transitRoute`. Shows the picked route + a mini map of
  the line + stops. Rendered in `cards/matching.tsx` for same-train-line INSTEAD
  of the nearest-reference + location map. `AddQuestionDialog.handleConfirm`
  blocks sending until a route is picked.
- **Elimination + grading now key on the route's STOPS** (both `matching.ts`
  `matchingStationBoundary("line")` and `hiderifyMatching`, plus `ZoneSidebar`):
  a candidate/zone station is "matching" iff it's within 150 m of a route stop
  (`stationIsRouteStop`, bridging the `railway=station` node vs the route's
  stop_position/platform node); the Voronoi-cell union + `same` keep/complement
  is unchanged. `trainLineNodeFinder`/`trainLineForPoint` (the whole-network
  finder) are no longer used by same-train-line.
- Copy: subtype description → "Pick the line you're riding — does it stop at the
  hider's station?"; on-card label "Train line" → "Transit line".

**v965 — body-of-water measuring shows NO overlay (arcgis buffer throwing on
dense coast) — harden `arcBufferToPoint`.** In a dense coastal metro (NYC) the
body-of-water closer/further overlay drew nothing at all. Root cause: the
body-of-water buffer input is the heaviest possible geometry (all named water +
every river/canal line + the sea-as-AREA polygon from `seaFromCoastline`), and
the @arcgis `geodesicBufferOperator` THROWS on geometry that dense. v933 stopped
CACHING that failure (evict + rethrow) so it would retry — but the throw is
deterministic, so it retried forever and the overlay (and the real elimination,
same path) never appeared. `arcBufferToPointImpl` (`arcgisOperators.ts`) now (a)
filters non-finite feature distances and returns null on a fully-degenerate
input instead of buffering by `Math.min()` of an empty/NaN set, and (b) wraps
the geodesic buffer in a retry that turf-`simplify`s the input at progressively
coarser tolerances (0 → ≈33 m → ≈110 m, negligible against a hundreds-of-metres
buffer) so a dense metro still yields a region instead of throwing; only a throw
even at the coarse tolerance returns null. `bufferedDeterminer` (`measuring.ts`)
normalises that null to the existing `false` failure contract. This fixes both
the configure preview AND the elimination cut for body-of-water/coastline in
dense metros. NOTE: hardening targets the v933-documented throw; verify on the
live NYC state.

**v964 — "Retry now" held back until the first auto-reconnect fails.** The
Reconnecting banner (`ReconnectingBanner`) always showed "Retry now"; offering
it during a healthy in-progress reconnect just invites interrupting it (and the
auto-reconnect resolves nearly all drops within a second or two). The transport
now emits a `reconnectAttempt` event (separate from `status`, which dedupes
consecutive "reconnecting"→"reconnecting" and so can't carry the count) →
`transportReconnectAttempt` atom (`session.ts`); the banner shows the curtain
immediately (unchanged) but reveals the button only once `attempt >= 2` (the
first automatic retry has come back unsuccessful). Emitted on
`scheduleReconnect` (++), `handleOpen` (reset 0 on success), and a fresh
`connect()` (reset 0 so a prior game's leftover count can't pop the button
instantly).

**v963 — "Retry now" reconnect sent no resume (stayed offline) — socket
generation guard.** Follow-up to v962: clicking the Reconnecting banner's "Retry
now" flipped the status to "open" (banner hid, looked connected) but the device
stayed OFFLINE on every peer. Root cause: `transport.ts openSocket` attached its
`open`/`message`/`close`/`error` listeners WITHOUT checking the event came from
the CURRENT socket. When `forceReconnect` (the Retry path) closed a socket that
was still mid-connect and immediately opened a fresh one, the OLD socket's
delayed `close` ran `handleClose`, which nulled `this.socket` — now pointing at
the NEW socket — and scheduled a spurious reconnect. The new socket then opened
with `this.socket === null`, so `handleOpen`'s `this.socket?.send(resume)` was a
NO-OP: the connection opened (status → "open") but the server never received the
`resume` handshake, so it never re-registered the participant → offline
everywhere. (The auto-reconnect path avoided it because it force-reconnects a
zombie whose `close` never fires, so there's no orphan event.) Fix: a generation
guard — each socket's listeners run its handler only while `this.socket ===
socket`, so a superseded socket's events are ignored and can't null the live
socket or drop its resume.

**v962 — heartbeat zombie-socket detection (fixes "peer reconnected but this
device never sees it").** A seeker Android reconnected and sent a question, but
the hider iPhone still showed it offline and never got the question. Root cause:
the transport's 25 s ping loop (`transport.ts startPings`) SENT pings but never
checked that a pong came back, so a socket that died while the app stayed
FOREGROUNDED (an iOS background kill that fired no `close` event, or the DO
evicting+reloading and severing the socket) was never detected — the client held
a zombie that reads `readyState===OPEN`, so it never reconnected and missed every
server broadcast (presence updates AND questions). `ensureLive` only probed on
visibility/online/pageshow, which never fire for an app that stays open. Now each
ping cycle schedules the same liveness probe: if NO inbound (the server pongs
every ping) arrives within `LIVENESS_PROBE_MS` (4 s), the socket is treated as
dead and `forceReconnect()` fires — so a foregrounded zombie is caught within
~one ping interval and the reconnect's welcome snapshot resyncs the missed
roster + questions. (A ping `send()` that throws also forces the reconnect
immediately instead of waiting for a `close` that may never come.)

**v961 — iOS safe-area fixes: top banner under the status bar + footer gap.**
Two `viewport-fit=cover` safe-area bugs on the HIDER view: (1) the
`LocationPauseBanner` (the fixed top "Game paused / seekers must share location"
banner) used a plain `pt-3`, so its content sat UNDER the iOS status bar/notch
— now `pt-[max(0.75rem,env(safe-area-inset-top))]`. (2) `HiderShell` applied the
bottom safe-area inset as CONTAINER padding (`paddingBottom:
env(safe-area-inset-bottom)`), which lifted the bottom nav and left a strip of
page background BELOW it ("empty space under the footer"). Fixed by moving the
inset INTO `HiderBottomNav` itself (`pb-[env(safe-area-inset-bottom)]` on the nav
background, so it fills to the screen edge with content padded up — the same
pattern the seeker `BottomNav` already used) and dropping it from the shell
root; the nav's inset is gated on `!hasCards` since a held hand fan (which
reserves `FAN_HEIGHT_PX` and is fixed to the bottom edge) must sit flush above
the nav. Map-area-relative overlays (PendingAnswer/HiderUnanswered) and the
already-inset SpoofIndicator were unaffected.

**v960 — endgame success card uses game terminology.** The `EndgameOverlay`
success headline was "YOU FOUND THE ZONE" / "THEY FOUND YOUR ZONE"; changed to
the rulebook's own "endgame" language — eyebrow "Endgame started", headline
"YOU'RE IN THE ENDGAME" (seeker) / "THE ENDGAME BEGINS" (hider), with body copy
to match.

**v959 — endgame declaration is a MILESTONE: big success/fail animations, map
cuts to the final zone, no more toaster.** Reaching the endgame is a major game
beat, so it was beefed up from a quiet toast + small banner to a full-screen
moment on BOTH roles.
- **Removed the "Endgame declared — hider notified." toast** (both paths in
  `StationTransitCard.handleStartEndgame`).
- **New `EndgameOverlay`** (replaces the small `EndgameDeniedBanner`, now
  deleted; mounted on both maps, portaled to `<body>` at `z-[1075]`,
  `pointer-events-auto`): a full-screen animation for BOTH outcomes, role-
  specific copy. SUCCESS (`endgameSuccessAt`) — gold `jlGoExplode` card + a
  deterministic confetti ring ("YOU FOUND THE ZONE" / "THEY FOUND YOUR ZONE").
  FAIL (`endgameDeniedAt`) — red `jlFizzleShake`/`jlFizzleFlash` card ("NOT THE
  RIGHT ZONE" / "ENDGAME ATTEMPTED"), auto-clears after 6.5 s. Both dismiss on
  tap; a round-reset that nulls the trigger drops a lingering overlay.
- **Map cuts to just the final zone on SUCCESS.** New persistent `endgameZone`
  atom ({lat,lng,radiusMeters,name}) recorded when a claim is CONFIRMED —
  `seekerStartEndgame(zone)` sets it directly solo; in multiplayer the declared
  zone is stashed in volatile `pendingEndgameZone` and PROMOTED to `endgameZone`
  only when the server arms the endgame (setupChanged, seeker role), dropped on
  `endgameDenied`. The seeker `Map.tsx` draws an `endgame-focus` spotlight (dark
  world-minus-circle mask + a bright gold ring/glow) and `fitBounds` the camera
  to the zone. All three atoms clear in `roundReset`.
- **Confirm-dialog copy updated to the new (v950/v951) rules** — the SERVER
  validates the claim against the hider's secret zone; there's no manual hider
  confirm/refute. "Declare the endgame here? We'll check your location against
  the hider's zone… if you've truly reached it, the endgame begins and your map
  zeroes in on this zone; if not, you'll be told to keep searching."

**v958 — SEEK/GO overlay stuck-inert fix + train-line preview shows the LINE.**
- **The "ON THE HUNT!" (seeking-start) overlay was un-dismissable on the
  hider.** At the hiding→seeking transition `SeekingStartWatcher` fires BOTH the
  `SeekingStartOverlay` (a PLAIN div at `z-[1070]`) AND, for the hider,
  `maybePromptForNotifications` — which ~600 ms later opens the contextual
  `NotificationPrompt`, a Radix Dialog that sets `body{pointer-events:none}`.
  The plain SEEK overlay INHERITED `none` and went inert: "Got it" stopped
  working and clicks passed through to the Radix layer beneath ("things happen
  underneath"). Fix: both celebration overlays (`SeekingStartOverlay` + its
  sister `GoGoGoOverlay`) now force `pointer-events-auto` on their root, so a
  co-open Radix modal's body lock can't make them inert (same guard
  `NotificationPrompt` already applies to itself). The SEEK overlay sits above
  the prompt (1070 > 1060), so dismissing it reveals the prompt cleanly.
- **matching "train line" configure preview showed a station, not the line.**
  For `same-train-line` the preview plotted the nearest STATION as a candidate
  dot AND a reference teardrop (its `resolveFamily` kind is `rail-station`),
  reading as "a station on a line" even though v877 already draws the actual
  rail line (`trainLineFC`). Now `InlineLocationPicker` suppresses BOTH the
  candidate dots (`visibleCandidates` returns null for `same-train-line`) and
  the reference marker/label (still keeping `referencePoint` only to frame the
  map), so the highlighted LINE is the sole reference shown.

**v957 — GPS play-area auto-suggest prefers a starred area.** Follow-up to
v956: the wizard's GPS suggestion (`tryGpsSuggest`, `GameSetupDialog.tsx`) took
the top-ranked `geocode` result (`found[0]`) for the first reverse-geocoded
candidate that returned matches. It now `ensureWarmCitiesLoaded()`s first and,
among that candidate's matches, PREFERS a warm (starred/prewarmed) area
(`found.find(isWarmCity) ?? found[0]`) — so when a location resolves to several
options the auto-suggestion lands on the fast, reliable one (and never trips the
v956 non-warm confirm). Deliberately scoped to WITHIN the winning candidate's
specificity level (not across candidates) so it can't over-broaden a small-town
fix into a whole county/country.

**v956 — confirm before picking a non-starred (unwarmed) play area.** Picking a
play area that isn't prewarmed means the map + questions load live off Overpass
instead of R2 — slower and occasionally buggy — so the wizard now warns before
committing one. `PlayAreaStep.handlePickResult` (`GameSetupDialog.tsx`) routes a
NON-warm pick through a `NonWarmAreaConfirm` dialog ("Play <area> anyway?" —
explains it isn't prewarmed) instead of committing immediately; a warm pick
(and the case where the warm set hasn't loaded yet — `warmCityIds === null`, so
warmth is unknown → don't nag) commits straight through. When a STARRED area
with a **similar name** is present in the current search results
(`findWarmSuggestion` — normalized same-name or whole-word-prefix match, seed-
ranked first-hit), the dialog leads with a recommended "Use <warm area>
instead" button; the footer always offers "Use <area> anyway" + Cancel. The
dialog is at `z-[1070]` so it clears the lobby "Edit play area" dialog
(`z-[1060]`). Covers every `PlayAreaStep` surface (first-time wizard, edit-
settings modal, lobby area editor) since they all pick through `handlePickResult`;
GPS auto-suggest is exempt (it's an automatic suggestion, not a deliberate pick).

**v955 — stop repeated "Seeking phase started" pushes for an abandoned game.**
An idle iPhone kept getting "Seeking phase started" notifications (44m/1h/2h
apart) for a game that was long over. Two compounding worker bugs in the
`GameRoom` DO, both fixed: (1) **the room never idle-evicted.** `fetch()`
clears `idleSince` to null when a socket connects; if the DO was then evicted
from memory while that socket was still in-memory (no `handleSocketClose` ran),
the reloaded cold isolate saw `conns.size===0` but `idleSince===null`, so the
eviction check (`now - (idleSince ?? now) >= IDLE_EVICTION_MS`) was always 0 and
the zombie room kept alarm-ticking (and re-pushing) forever. `alarm()` now
stamps `idleSince = now` when it wakes idle with a null marker, so a stranded
room starts its 30-min eviction countdown. (2) **the seeking-start dedupe flag
was ephemeral.** `seekingStartPushedFor` (the `hidingPeriodEndsAt` value already
pushed for) reset to null on every DO eviction+reload, so the next alarm
re-fired the same transition's push. It's now PERSISTED (added to
`PersistedRoom` + hydrate + persist) AND `checkSeekingStartPush` gained a
**time-window guard** (`SEEKING_PUSH_WINDOW_MS`=5 min) — it only fires within
5 min of the actual hiding→seeking transition and otherwise marks the value
handled without pushing, so a stale room reloaded hours later can never push a
nonsensical "seeking started" long after the fact.

**v954 — lobby preload copy drops "offline".** The lobby preload section
header "Preload for offline play" → "Preload the map", and the compact bar's
"Preloading for offline play…" / "Ready to play offline" → "Preloading the
map…" / "Map ready" — the offline framing read oddly in the lobby.

**v953 — notification-coverage batch: Move push, smarter closing-in, dead-code
cleanup.**
- **Move powerup now pushes offline seekers.** `handleStart` (worker) detects
  `revealedStation` going null→set and Web-Pushes offline seekers ("Hider is on
  the move — …station"). The `setupChanged` broadcast only reached ONLINE
  seekers, so a backgrounded seeker missed the Move reveal.
- **"Seekers closing in" is now well-timed + velocity-gated.**
  `ClosingInWatcher` (client, foreground hider) replaced its fixed
  per-game-size thresholds with DYNAMIC ones: a fraction of the seekers'
  distance at seeking-START (the baseline — so a warning means "they've closed
  most of the gap" whether they started 2 km or 30 km out), floored to the
  PLAY-AREA scale (bbox diagonal). And it only fires when the nearest seeker's
  CLOSING SPEED toward the zone exceeds `FAST_CLOSING_KMH` (12) — a slow
  wanderer drifting across the threshold no longer trips it; a train/car
  bearing down does (GPS jitter filtered by a ≥15 s speed-sample window). A
  BACKGROUNDED hider is covered by a new server push — `checkClosingInPush`
  (alarm-driven) measures each seeker's closing speed across ticks and pushes
  the urgent band once/round to an offline hider when a seeker is close
  (game-size-scaled) AND closing ≥12 km/h.
- **Removed dead `pushEndgameToOfflineHideTeam`** (worker) — orphaned by the
  v950/v951 endgame rewrite.

**v952 — room codes back to 4 random letters.** Reverted the v951 word+digits
code to a simple 4-letter code (24⁴ ≈ 332k over the I/O-less alphabet). The
client validators stay `[A-Z0-9]{3,8}` (accept the 4 letters + any lingering
in-flight digit codes).

**v951 — endgame model finished (deny-not-arm + transient banner) + fun room
codes.**
- **Endgame is fully server-authoritative now.** A CORRECT claim arms the
  endgame (`endgameStartedAt` + `endgameConfirmedAt` via `setupChanged`) and the
  hider locks down; a WRONG claim **arms nothing** (so the seekers can re-try at
  the right station) and instead fires a transient **`endgameDenied`** message
  (`protocol/messages.ts`) to the claiming seeker + the hide team, plus a Web
  Push to the offline sides. Client: `seekerStartEndgame` no longer
  optimistically arms in multiplayer (it waits for the server's verdict — kills
  the false-"denied" flash); a new volatile `endgameDeniedAt` atom drives the
  transient **`EndgameDeniedBanner`** (mounted on both maps, role-specific copy,
  auto-clears ~9 s, reset per round). Because an armed endgame now always means
  "correct", the seeker `HiderTimer` badge is always the green "In the zone"
  (the "Awaiting hider" state is gone) and the hider's `HiderHome` banner is
  informational ("they reached your zone — lock down"), with the manual
  confirm/refute buttons REMOVED (the wire handlers + demo cases stay as
  back-compat; the demo broker auto-confirms since it's single-device).
- **Fun on-brand room codes** (`worker/index.ts`). Replaced the 3-letter code
  with a travel / hide-and-seek **WORD + 2 digits** (e.g. `FERRY73`,
  `TUNNEL08`, `JETLAG42`) — deliberately NOT a real place name. ~90 curated
  words (≤6 letters) × 100 ≈ 9k codes, comparable to the old space; still no
  collision check (a code lazily names the DO). Words are ≤6 letters so the
  code stays ≤8 chars, preserving the `[A-Z0-9]{3,8}` route/validator contract
  — the WS + photo routes already allowed digits; the two letters-only client
  validators (`Welcome`, `OnlinePlaySection`) were widened `[A-Z]`→`[A-Z0-9]`.

**v950 — server-authoritative endgame validation + push both sides.** The
endgame claim is now VALIDATED by the server (it holds both the hider's secret
committed zone AND every seeker's last GPS), so the hider no longer has to
manually confirm/refute. `handleStartEndgame` computes `seekerIsAtHidingZone`
(the claiming seeker's `lastPos` within `hidingZone.radiusMeters` +
`ENDGAME_ZONE_MARGIN_M` 150 m; can't-verify → allow) and stamps
`endgameConfirmedAt` immediately (correct) or leaves it null (wrong). It then
Web-Pushes BOTH offline sides: the HIDER learns the endgame was ATTEMPTED
(right → "Seekers reached your zone!", wrong → "Endgame attempted … not at your
zone"), and the SEEKER gets the verdict ("You're in the right zone!" /
"Not the right spot"). The client `setupChanged` handler mirrors it in-app:
on a fresh claim it reads the same-message `endgameConfirmedAt` to notify the
hider (attempted, correct-or-not) and the seeker (the denial; a correct claim's
"you're in the right zone" still comes from the confirmed-branch). The hider's
manual confirm/refute wire handlers remain as a back-compat fallback. **Remaining
polish (follow-up):** reword the seeker `HiderTimer` "Awaiting hider" badge to a
denial state and replace `HiderHome`'s now-redundant confirm/refute banner with
an informational "endgame attempted" banner.

**v949 — hider POI highlight no longer blinks (accumulate + clip to zone).**
`HiderPoiOverlay` replaced its whole feature set on every map `idle` from
`querySourceFeatures`, which only returns features in the CURRENTLY-RENDERED
tiles — so highlighted POIs (supermarkets/cafes) flickered in and out on
pan/zoom. Now the found POIs are ACCUMULATED (union, deduped by kind+coords)
and CLIPPED TO THE COMMITTED HIDING ZONE (haversine within `radiusMeters`+50 m),
so once a POI in the zone is seen it stays drawn — persistent like every other
toggled overlay. The union only ever grows (never shrinks on a pan away, which
was the blink); the accumulator resets when the highlight set or the zone
changes. No zone committed → accumulates everything seen (still no blink).

**v948 — hider curse parity, pending-overlay urgency, round-end push.**
- **Hider sees active curses exactly like the seeker.** `CurseInbox` gained a
  `source` prop (default `receivedCurses`); the hider map (`HiderBackgroundMap`)
  now mounts `<CurseInbox source={castCurses} />` — the same on-map purple
  pills / cards / dice / countdowns, sourced from the hider's cast-curse mirror.
  The drawer-buried `HiderActiveCurses` was deleted.
- **Hider "question pending" overlay is louder.** `HiderUnansweredOverlay` now
  runs a steady attention **pulse** (`jlPendingPulse` — scale + warm glow,
  motion-safe) the whole time a question waits, and the countdown **jitters**
  (`jlTimerJitter`) + turns red in the final minute before the answer window
  closes.
- **Round-end reaches a sleeping device.** Marking the hider found only
  broadcast `ended` to CONNECTED clients, so a backgrounded seeker got no memo
  and its timer kept ticking. `handleMarkFound` now Web-Pushes every offline
  seeker + hider ("Round over — hider found!"). And `applySnapshot` opens the
  `EndOfRoundDialog` when a device FIRST learns the round ended via a reconnect
  snapshot (its local `roundFoundAt` was null → now set), so reopening shows a
  clear round-over moment instead of a frozen timer. (`roundFoundAt` is
  persistent, so a dismiss survives later reconnects — no re-open.)

**v947 — iOS bottom gap, join-in-progress, team-wide GPS reminders,
thermometer/curse overlap.**
- **iOS empty space at the bottom (seeker).** The seeker shell used
  `h-svh` (SeekerPage), the SMALL viewport — so on iOS Safari with the toolbar
  hidden the shell was shorter than the screen and the page background showed
  as empty space below the bottom nav. Switched to **`h-dvh`** (dynamic
  viewport), which tracks the visible area as the toolbar shows/hides. (The
  hider shell is `fixed inset-0`, unaffected.)
- **Join-in-progress landed on SEEK! + locked (fixed).** A multiplayer guest
  joining an already-started game arrives with the clock armed (welcome
  snapshot) but NO role yet; the gate only checked `clockArmed`, so they
  skipped the lobby/RolePicker and were dumped into the seeking shell with a
  replayed SEEK! overlay. Now `SeekerPage` shows the pre-game branch when
  `needsRolePick` (`multiplayer && role === null`), regardless of the clock —
  so a joiner picks a role first. AND `applySnapshot` (a join/reconnect resync,
  never the live transition) stamps `gameStartFiredFor` (always, if the clock
  is armed) + `seekingStartFiredFor` (only if the hiding period already passed)
  so the GO-GO-GO / SEEK celebration never replays on a rejoin — a joiner still
  IN the hiding period keeps the SEEK beat for when it crosses zero.
- **GPS reminders are TEAM-wide** (rulebook: the seekers travel together, so
  one fresh signal covers the team). The client hider path already used
  `some()` over all seekers; the SEEKER path now also treats a teammate's fresh
  share as covering it (possible now that seekers see each other, v946). The
  worker `checkLocationReminders` was rewritten from per-seeker to team-level:
  it escalates only when the WHOLE team's freshest share is stale, then nudges
  every offline seeker; the per-seeker `locReminderSent` map became a single
  `teamLocReminder` flag, reset when any seeker shares.
- **Thermometer no longer overlaps the curse pills.** The in-progress
  thermometer tracker is much taller than the pending-answer card, so the curse
  pills' standard `pendingOverlayActive` dodge (150 px) still overlapped it. New
  `topOverlayTall` atom (set by `ThermometerOverlay`) drives a bigger dodge
  (~310 px mobile / 300 px desktop) so the pills clear the tall card.

**v946 — seekers see each other + seeking-start push + hider notify prompt +
hider zone-entry moved to the nav.**
- **Seekers see other seekers on the map.** The server fanned `loc` only to
  the hide team; now `handleSeekerLocation` fans to the OTHER seekers too
  (excluding the sender). The seeker `Map.tsx` renders them as player-colour
  initials avatars + name (reusing `playerColor`/`playerInitials`), mirroring
  the hider map. The client `loc` handler already stored any incoming location
  into `seekerLocations`, so it worked for both roles once the server fans it.
- **Seeker/hider PUSH when the hiding period ends.** `SeekingStartWatcher` uses
  `notify()` (foreground-only) driven by a visibility-gated interval, so a
  backgrounded/locked device got nothing when the timer expired. The DO alarm
  is already scheduled to fire AT `hidingPeriodEndsAt`; `alarm()` now calls
  `checkSeekingStartPush()`, which Web-Pushes every OFFLINE player once at the
  transition (seeker + hider variants), deduped on the `hidingPeriodEndsAt`
  value (`seekingStartPushedFor`). Fires right at natural expiry; within one
  ~60 s tick on an early end.
- **Hider "get notified" prompt at hiding-period end.** The contextual
  `HIDER_NOTIFICATION_PROMPT` (v812) moved from zone-lock-in (which consumed
  the one-shot too early, before questions can arrive) to the hiding-period-END
  moment in `SeekingStartWatcher` — "You'll get the first question soon" —
  mirroring the seeker's post-first-question ask.
- **Hider zone entry point → the bottom nav.** The on-map "SELECT A STATION"
  overlay (`HiderZoneHint`, deleted) was removed; the bottom-nav Zone slot now
  reads **"Select zone"** until a zone is committed, then **"Zone"** — tapping
  it opens the Zone drawer's station picker.

**v945 — tile pack download is CHUNKED-RANGED (fixes the 503 / range-walk on
big packs) + dropped the "keep the app open" seeker toast.**
- **Chunked-ranged pack download** (`tilePack.ts`). `loadTilePackForPlayArea`
  fetched the whole pack in ONE plain `fetch(url)` (no Range). For a big
  multipart pack (NYC ≈ 95 MB) that whole-object path failed two ways, so the
  preloader fell back to the slow per-tile z14 range walk: (a) the worker's
  `/tiles/<key>` serve does a whole-object `env.TILES.get(key)` which THROWS
  inside R2 for a large multipart object → 503; (b) the service worker's
  `/tiles/*.pmtiles` route sends a no-Range request straight through
  (`if (!range) return fetch(request)`), and streaming a 95 MB whole-object
  body through the SW is flaky on **Firefox** specifically (same Firefox/SW
  class as v748 — worked intermittently, 503'd via workbox's catch handler
  other times; Chrome always handled it). Fix: new `downloadPackRanged` pages
  the pack in **8 MB `Range: bytes=…` requests** — a first `bytes=0-N` learns
  the total from `Content-Range`, then it loops the rest and assembles one
  buffer. This uses the EXACT ranged path the live map already uses reliably
  (the worker's 206 branch + the v748-hardened SW ranged branch that only
  buffers 206s), so it works on every browser and never touches the fragile
  whole-object path. A server that ignores the range (small pack → 200)
  degrades to a straight whole-body read. `AbortSignal` still cancels a
  Stop-preload mid-download. The v944 `no city tile pack (status=…)` diagnostic
  stays — but `error` no longer means a starved fallback, since a large pack
  now downloads via ranges instead of failing whole.
- **Dropped the "keep the app open…" seeker toast** (`WakeLockController`).
  The one-time v938/v939 hint read as nagging; seekers notice on their own that
  live GPS needs the app foregrounded. The Screen Wake Lock (the actual
  mitigation) stays; only the toast + its `keepAppOpenHintSeen` atom were
  removed.

**v944 — lobby preload = ONE compact progress bar + tile-pack fallback
diagnostic.**
- **Compact lobby preload.** The lobby rendered the full three-row
  `PreloadChoicesPanel` (per-bucket blurbs + individual progress), which is
  noise pre-game — the player just wants "is the offline map ready?".
  `PreloadChoicesPanel` gained a **`compact`** prop → a new `CompactPreloadBar`:
  ONE combined progress bar whose percent is a **byte-weighted blend** of every
  enabled bucket's fraction (each bucket weighted by its `estimateMb`, so the
  Map bucket dominates), a single "Preloading for offline play… N%" /
  "Ready to play offline" / "Preload paused" label, and the same Stop/Resume
  control. The full breakdown stays in Settings (`PreloadChoicesPanelFull`, the
  old body, extracted verbatim). `GameLobbyDialog` passes `compact`.
- **Tile-pack fallback diagnostic.** `runMapPreload` (`preload.ts`) correctly
  PREFERS the city tile pack (`loadTilePackForPlayArea`) and only range-walks
  z14/z15 tiles when the pack fetch returns non-`loaded` — but a range walk on
  a STARRED city ("why isn't it fetching the pack from R2?") was undiagnosable.
  It now `console.warn`s the exact reason before falling back:
  `no city tile pack (status=absent|skipped|error, osm=<id>)`. `absent` = the
  pack 404'd in R2 (operator pack-build gap / stale pre-v725 star / the
  `mapGeoLocation.osm_id` the client requests ≠ the warmed relation id);
  `skipped` = the play area isn't an OSM relation. The client logic was already
  correct — this surfaces WHICH of those it is (a server/ops signal vs a
  relation-id mismatch) instead of silent range-walking.

**v943 — durability pass, Phases 2–4: scouted spots + active curses survive a
device dying; coverage audited.** Completes the 4-phase durability pass begun
in v942 (the server as the book-of-record for round-critical state a device
could lose — the concern is a tunnel / dead battery / swapped phone, NOT
anti-cheat). Full map in **MULTIPLAYER.md → "Durability"**.
- **Phase 2 — scouted spots.** The hide team's scouted-spots notebook
  (`scoutedSpots`, `hiderRole.ts`) is now a hide-team-secret synced blob like
  the deck/zone: new `CMsgSetScoutedSpots`/`SMsgScoutedSpots`, worker
  `handleSetScoutedSpots` (hider-only, fans to other hiders, persisted to DO
  storage + re-delivered on join/resume/role-claim, reset per round + on
  eviction), client bridge `scheduleScoutedPush` (microtask-batched,
  echo-guarded via `applyingRemoteScoutedSpots`, hider-only), inbound
  `case "scoutedSpots"`. Demo broker no-ops the message.
- **Phase 3 — active curses.** The server now stores the curses cast this round
  (`castCurses`, each stamped a monotonic `castId` in `handleCastCurse`) and
  re-delivers them to a SEEKER on join/resume/role-claim via a new
  `SMsgCurseBacklog` (`{t:"curseBacklog", curses}`) — so a seeker whose device
  died recovers every active curse cast on them, for display AND enforcement
  (Drained Brain / Spotty Memory / Urban Explorer). `CursePayload.castId?` +
  `ReceivedCurse.castId?` carry the id; the client merges the backlog into
  `receivedCurses` deduped by `castId` (no `notify()` — it's recovery), so a
  SURVIVING device (localStorage intact) keeps its acknowledged/dismissed flags
  instead of doubling curses. The fresh `curseReceived` cast now also dedups by
  `castId`. Persisted to DO storage; reset per round + on eviction.
- **Phase 4 — audit.** Swept every per-round atom (`roundReset.ts` is the
  authoritative set) and confirmed each game-critical value is server-backed:
  `GameState`/`SetupState` (welcome snapshot: setup, questions, `roundFoundAt`,
  endgame stamps, `seekersFrozenUntil`/`revealedStation`), plus the out-of-band
  secrets (`hidingZone`, `deckState`, `roundProgress`, `scoutedSpots`,
  `castCurses`) each re-delivered on rejoin + persisted. Derived state
  (`disabledStations`/`permanentOverlay`, `hiderInbox`, `activeBlockingCurse`)
  rebuilds from recovered data. Accepted local-only gaps (deliberately NOT
  backed — non-critical/ephemeral): celebration dedupe keys,
  `gameStartPosition` (Travel-times anchor), `spottyMemoryCategory`/
  `seekerOnTransit` (a dice roll / self-declared toggle), and the HIDER's
  `castCurses` mirror (informational — a reflection of their own actions; the
  game-critical direction, curses ON the seekers, IS backed).

**v942 — durability pass, Phase 1: the hider's SCORE survives a device
dying.** First of a 4-phase pass making the server the durable book-of-record
so no single device's loss (lost / broken / storage-cleared / handed to a
teammate) can destroy unrecoverable game state — the motivation is a phone
dying in a tunnel or on battery, NOT anti-cheat. Phase 1 covers the score
ledger + pause clock, which lived ONLY in the hider's localStorage: if that
device died mid-round the running hidden-time (Move bank `hiddenCreditMs`,
late-answer/pause debits `hiddenDebitMs`) was unrecoverable and no co-hider
could report it. Now it's a HIDER-owned synced blob — new
`RoundProgressShare` (`{hiddenCreditMs, hiddenDebitMs, manualPausedAt,
manualPauseWasHiding, gamePausedForLocationAt, locationGraceStartedAt}`) held
OUTSIDE `GameState` and relayed to the OTHER hiders + persisted, EXACTLY
mirroring the v832 deck sync: `readRoundProgress`/`applyRoundProgress`
(`gameSetup.ts`), microtask-batched echo-guarded (`applyingRemoteRoundProgress`)
hider-only push on any of the six atoms → `setRoundProgress` → server
`handleSetRoundProgress` (hider-only, fans to other hiders) → `roundProgress`
delivered on join/resume/role-claim so a recovered device adopts it. Cleared
per round (server rotate + client reset) and on eviction. Seekers never see
it (the hidden time is revealed at round end via `roundSummary`). Sync-the-
running-total (a sub-second change as the device dies could be lost — the
event-source alternative was deferred). Demo broker no-ops the message.
Phases 2–4 (scouted spots, curse backfill, audit + kill-and-rejoin test) to
follow.

**v941 — location reminders are DO-alarm-driven (fire when everyone's
offline) + "we're tracking GPS another way" opt-out.**
- **Alarm-driven reminders.** v940's reminder check rode message activity
  (the hider's ping), so if EVERY player backgrounds the app at once — very
  common mid-game — nothing fired. The DO now runs a self-perpetuating alarm:
  the single alarm slot is multiplexed by `scheduleAlarm()` to the SOONER of
  the seeking-phase location tick (`ALARM_TICK_MS`=60 s, so reminders escalate
  even with zero connections) and idle eviction (`idleSince + IDLE_EVICTION_MS`).
  `alarm()` runs `checkLocationReminders()` then either tears down a
  genuinely-idle room or re-schedules. `idleSince` is now PERSISTED (in
  `PersistedRoom`) so eviction timing survives the DO being evicted from
  memory between ticks — previously it reset to "now" on every
  re-instantiation and the room never evicted. `armEviction`/`cancelEviction`/
  `evictionAlarmSet` were replaced by `idleSince` + `scheduleAlarm` (called on
  every connection change + non-ephemeral message; `forceCloseRoom` deletes
  the alarm). Push still only nudges OFFLINE seekers.
- **"We're tracking GPS another way" opt-out** — groups often share location
  via a dedicated tracker, so the whole location rule can now be stood down
  room-wide. New `SetupState.locationTrackingExternal` + client atom
  (`gameSetup.ts`, persistent, reset on new GAME) + a dedicated
  `setLocationTracking` message (ANY participant may send it — unlike the
  host-only `hostPushSetup`; server `handleSetLocationTracking` stamps it +
  broadcasts setupChanged, and gates `checkLocationReminders`). When on:
  `LocationPauseWatcher` is dormant (no grace/pause), `LocationPauseBanner`
  hides. Toggled by the banner's "We're tracking GPS another way — stop these
  warnings" dismiss, re-enabled from Settings → App → "Location warnings"
  (both call `setLocationTrackingExternal`). Demo broker no-ops the message
  (single device). Turning it back OFF re-arms a clean staleness slate
  server-side so reminders don't instantly re-fire.

**v940 — lenient seeker-location freshness: reminder pushes at 5 & 10 min,
pause at 15.** The old rule was a flat 5-min-to-pause off a tight 60 s
freshness window — too aggressive (and prone to spurious fires under GPS
jitter / the app being briefly backgrounded). New escalation once a seeker
goes stale (no fresh `loc`): **90 s freshness** (was 60 s; the heartbeat is
30 s, so ~2 missed beats + skew are tolerated), a **reminder push at 5 min**
and **again at 10 min**, then a **visible 5-min countdown** (starting at the
10-min mark) that **pauses the game at 15 min**. The two reminders are
SERVER-driven (`GameRoom.checkLocationReminders` → `pushToParticipant`,
called opportunistically on message activity — the hider's ~25 s ping keeps
it ticking; gated to the seeking phase; only nudges an OFFLINE seeker, since
a backgrounded PWA is the case a push must reach and an online seeker sees
the banner) — the hider's device can't push a pocketed seeker, so this had
to move server-side. The eventual PAUSE stays client-authoritative on the
hider (`LocationPauseWatcher`, now 15 min). Constants: client
`LOCATION_SHARE_FRESH_MS` / `LOCATION_REMINDER_1_MS` / `LOCATION_REMINDER_2_MS`
/ `LOCATION_PAUSE_AFTER_MS` / `LOCATION_COUNTDOWN_MS` (`gameSetup.ts`), worker
hand-mirror `LOC_REMINDER_1_MS` / `LOC_REMINDER_2_MS` (keep in sync).
`LocationPauseBanner` shows a gentle "open the app so your location updates"
for the first 10 min, then the "game pauses in m:ss" countdown. Server
reminder state (`locLastAt` / `locReminderSent`) is ephemeral + per-round
(reset on `loc` + round rotate).

**v939 — Screen Wake Lock during an active round + seeker "keep app open"
hint.** The web platform has NO background-geolocation API, so a seeker's
`watchPosition` broadcast dies the moment the page stops executing (screen
off / app backgrounded). Mitigation: `useWakeLock(enabled)`
(`src/hooks/useWakeLock.ts`) holds a Screen Wake Lock while foregrounded and
re-acquires it on `visibilitychange → visible` (the platform releases it
whenever the page hides); all failures swallowed (unsupported browser /
request-while-hidden). `WakeLockController` (mounted once app-level, spans
the seeker↔hider route swap) enables it for the whole active round
(`hidingPeriodEndsAt` finite && `roundFoundAt == null`) — keeps the app alive
in-hand so live GPS + map + timers keep running. It CANNOT help once the app
is switched away / the screen is manually off (that needs a native app). It
also shows a **one-time seeker hint** (`keepAppOpenHintSeen`, persistent):
"Keep the app open so the hider sees your live location — phones stop sharing
GPS in the background." **Background reality (recorded for expectations):**
web PUSH works with the app closed (server-driven via the SW); live GPS does
NOT run when the app is closed/backgrounded/asleep — foreground-only, wake
lock is the only web mitigation.

**v938 — persistent GPS spoof (multi-device testing) + Unguided Tourist
image payload.**
- **The debug GPS spoof (`spoofedPosition`) is now PERSISTENT** (was
  volatile). Multi-device testing reloads constantly (PWA updates, the
  reconnect flow, the boot watchdog), and a volatile spoof got silently
  wiped on each reload — so a spoofed seeker + a reloaded hider ended up on
  different real/spoofed GPS, which read as a "gamebreaking" desync (radar
  centred on the spoof but the hider graded against real GPS). Persisting it
  keeps a test session consistent across reloads; the decode validates the
  stored value so a corrupt entry can't poison location. Guarded by a new
  always-visible **`SpoofIndicator`** chip (amber "GPS SPOOFED · tap to
  clear", app-level) so an active spoof can't be forgotten — a real user
  never reaches the debug panel that sets it. (Real 2-device games use real
  GPS on both ends, which was always correct — this only affected spoofed
  testing.)
- **Curse of the Unguided Tourist (+ Labyrinth) now require + deliver an
  IMAGE.** Their deliverable — the hider sends the seekers a Street View
  image / a photo of the drawn maze — is in the DESCRIPTION, not the casting
  cost, so `curseCostRequiresPhoto` (cost-only) missed it. New
  `curseCostDeliverableIsImage(description)` + `curseRequiresImage(cost,
  description)` union both signals; `CastCurseDialog` gates the cast on it
  and delivers the image through the SAME photo pipeline as the photo-cost
  curses (capture → R2 → `CursePayload.photoUrl` → CurseInbox). Unit-tested.

**v937 — two multiplayer clock-skew / reconnect timer bugs.**
- **Photo answer window desynced (seeker 10 min, hider 5 min) + reset on
  reconnect.** `HiderUnansweredOverlay` computed the deadline as
  `arrivedAt + ANSWER_WINDOW_MS` — a FLAT 5 min (so a photo's 10/20 min
  showed 5) keyed off the hider's LOCAL receive time (so reconnecting, which
  re-delivers the question, restarted the countdown). Now
  `createdAt + answerWindowMs(category, size)` — the seeker-stamped, synced
  `createdAt` gives an absolute deadline both devices agree on that survives
  reconnect. `settleLateAnswer` (the economy's late-penalty) was fixed the
  same way (was `arrivedAt`-based → wrong window start after reconnect).
- **"Seekers need to share their location" nag fired while the seeker was
  actively sharing (and online).** The hider's freshness check compared the
  seeker's reported `msg.ts` against the hider's `now` — a seeker even ~1 min
  ahead of the hider's clock made every fresh broadcast look older than the
  60 s window → spurious grace/pause. The `loc` handler now stamps `ts` with
  the HIDER's local receive time (skew-immune); every consumer of that field
  asks "how recently did we hear from this seeker," which receive-time
  answers correctly.

**v936 — photo-answer fixes (the "couldn't upload full-size photo"
regression + seeker photo-card cleanup).**
- **Photo upload 404'd for every 3-letter-code game** — a regression from
  v932: the worker's `POST /games/:code/photo` (+ the GET) route regex was
  still `[A-Z0-9]{4,8}`, so a 3-letter code didn't match → the full-res R2
  upload failed → `preparePhotoForSend` fell back to the tiny inline
  thumbnail and toasted "Couldn't upload the full-size photo." Widened both
  photo routes to `{3,8}` (matching the WS route). Photos already compress
  to ≤2560px/0.85 (~1–2 MB, well under the 8 MB cap), so the cap was never
  the issue — the route was.
- **A multiplayer SEEKER could delete a received photo** from the question
  card (the Remove/trash button rendered for everyone). Gated on
  `showManualCapture` (hide team / offline) — a seeker now views a received
  photo read-only.
- **The seeker's photo ASK dialog showed an empty dashed "placeholder image"
  box** (the "waiting for the hider" state) while still composing the
  question. Hidden in the configure dialog (`forceExpanded`); it still shows
  in the question LOG so the pending/waiting state is visible there.

**v935 — multiplayer reliability batch (live-testing bugs): GO-GO-GO
replay, no-push-on-answer, zombie reconnect + banner.**
- **GO-GO-GO / countdown replayed on the seeker when the hiding period
  ENDED.** `GameStartWatcher`'s value-keyed dedupe (`$firedFor === $endsAt`)
  only suppressed the SAME timestamp, so any mid-round value CHANGE
  re-triggered the start flourish — the hider ending the period early sets
  `hidingPeriodEndsAt` to ≈now (a new value), which under a hair of
  cross-device clock skew slipped past the `<= Date.now()` guard and fired
  GO-GO-GO on top of the SEEK! overlay. Now dedupes on "already fired THIS
  round" (`$firedFor !== null` — cleared to null by the per-round reset, so
  each new round still celebrates), immune to end-early, pause/resume
  deadline shifts, and reconnect snapshots. Plus a 1-min future margin as a
  belt-and-braces start-vs-end discriminator.
- **A locked/backgrounded seeker got NO notification when the hider
  answered.** The server pushed offline hide-team members on a new question
  but never pushed offline seekers on an ANSWER — and the in-app `qAnswered`
  → `notify()` only fires when the tab is visible. `handleAnswerQuestion`
  now Web-Pushes offline seekers (generalised `pushToOfflineRole`).
- **"Opened the app, won't reconnect" (zombie socket).** After a long
  background/suspend a WebSocket can read `readyState === OPEN` yet be dead
  (no `close` event fired), so `reconnectNow()` bailed at its
  `status === "open"` guard and never reconnected. The transport now runs a
  LIVENESS PROBE on resume (`ensureLive`): not-open → reconnect immediately;
  open → ping and, if no inbound traffic within `LIVENESS_PROBE_MS` (4 s),
  `forceReconnect()` (tracks `lastInboundAt`). Public `transport.reconnect()`
  + store `reconnectNow()` back a manual retry.
- **"Reconnecting…" curtain** (`ReconnectingBanner`, mounted app-level):
  while in an online game with a non-open socket (after a 1.5 s grace so a
  fast reconnect doesn't flash it), a full-screen dim + blur blocks the app
  so the player can't act against stale, un-synced state, with a "Retry now"
  button. Inert in demo mode / outside a game.

**v934 — offline players stay in the lobby roster (greyed), don't vanish.**
Follow-up to v932's persistence fix: a player who closed/backgrounded the
app was correctly kept in the server roster (marked `online:false`), but the
lobby's `seekers`/`hiders` filters (`GameLobbyDialog`) dropped them with
`p.online && …` — so their name DISAPPEARED from everyone else's lobby
instead of showing offline. The `RosterCard` already styles an offline row
greyed (`opacity-45`/`50`); the parent filter was pre-removing them before
they reached it. Now the filters key on role only, so a backgrounded/closed
player stays visible as an offline roster row (the reassuring, correct
behaviour). Platform note recorded for expectations: **web push works with
the app CLOSED** (server-driven via the SW), but **live GPS sharing does NOT
run when the app is closed/backgrounded** — `useSeekerLocationBroadcast` is
`watchPosition` + `setInterval`, both suspended when the page isn't
executing, and the web platform has no true background-geolocation API. A
seeker must keep the app foregrounded for their pin to update live; a Screen
Wake Lock is the available mitigation (keeps the screen on / page alive
while open) but can't help once the app is switched away or killed.

**v933 — body-of-water measuring: the "straight-line split" bug (a
measuring question drawing a single half-plane) + memoize-caches-failure +
fountain-as-nearest.** Root-caused from an NYC report where the closer/
further preview was a clean DIAGONAL LINE despite dozens of water
references — impossible for a measuring buffer, which unions a per-body
buffer into a blobby region.
- **`questionImpact.ts`: `water` wasn't gated like the other full-geometry
  families.** Its `loading` flag keyed on the centroid POINT-cache, so the
  overlay went "ready" the instant that cache loaded and drew the
  single-point perpendicular-bisector **half-plane** (the straight line,
  drawn relative to whatever centroid was nearest — e.g. a stray fountain)
  instead of waiting for the real buffered region. Fix: `water` now gates
  `loading` on `measuringReady` (the real buffer) AND is excluded from the
  half-plane fallback (`else if (nearest && family.kind !== "water")`), so
  it shows a loading state until the true blobby region lands — never the
  misleading line.
- **`measuring.ts`: `bufferedDeterminer` (lodash-memoized) cached
  FAILURES permanently.** A transient rate-limited water/coast fetch (→
  `false`) or an arcgis geodesic-buffer throw on NYC's heavy full coast +
  every river (→ rejected promise) got memo-cached for that seeker
  position, so every retry returned the poisoned value — silently
  degrading BOTH the preview (fell to the half-plane) AND the real
  elimination answer (buffered nothing) for the rest of the game at that
  spot (the same trap v868 fixed for matching). New
  `bufferedDeterminerFresh` wrapper (extracted `bufferedDeterminerKey`)
  evicts the memo entry on a `false`/rejected result so the next call
  recomputes; a genuine success is still cached. Wired into all real call
  sites (`measuringDraftBuffer`, the `adjustPerMeasuring` elimination,
  `measuringPlanningPolygon`). This also lets the sea/coast geometry
  (`seaFromCoastline`) retry after a transient failure, improving the
  "coastal area wrongly marked further" coverage.
- **Fountain-as-nearest-water dropped client-side.** OSM tags some
  fountains `natural=water` with a fountain-y NAME but no `water=fountain`
  subtag, so they pass `WATER_FILTERS` (which keys on the subtag) — NYC's
  "Madison Square Fountain" won as the 938 m nearest reference over the
  slightly-farther rivers, poisoning the buffer distance + the label. New
  `isFountainWaterFeature` (name `/\bfountains?\b/i` + area < ~1.2 ha, so a
  real "Fountain Lake" is never excluded) drops them in BOTH the
  body-of-water elimination polygons AND the nearest-water label
  (`NearestReferencePreview`). CLIENT-SIDE — no `WATER_FILTERS` change (that
  would orphan every city's `/api/water` cache and need an operator
  re-warm); the prewarmed geometry still contains fountains, we just ignore
  them.

**v932 — game/lobby PERSISTENCE fix (the "thrown out of my own lobby"
bug) + join flow polish + 3-letter codes.**
- **The `GameRoom` Durable Object now MIRRORS its state to DO storage**
  (`worker/GameRoom.ts`) and restores it in the constructor via
  `blockConcurrencyWhile`. Previously the entire room — `game`, `tokens`,
  `deviceToParticipant`, `hidingZone`, `deckState`, `pushSubscriptions` —
  lived ONLY in memory (`server.accept()`, not the hibernation API), so a
  DO evicted from memory seconds after its last WebSocket dropped came back
  a FRESH isolate with empty maps. On reopen the client's `resume` woke
  that empty isolate → `participantForDevice` missed → server replied
  `session_invalid` → the client `leaveGame()`d → the lobby autohost then
  minted a NEW empty room, dumping the host out of the game they'd set up
  (the reported "closed the app for a few seconds, reopened, out of the
  lobby, lost progress"). Fix: a `PersistedRoom` blob (Maps as entry
  arrays; `conns`/`lastPos` excluded — live sockets + ephemeral proximity
  re-establish on reconnect) is written after every mutating message
  (`dispatch` → `void this.persist()`, skipping the high-frequency
  `ping`/`loc`/`hiderLoc`) and loaded on cold start. Fire-and-forget
  `storage.put` is output-gate-safe (the isolate isn't evicted mid-write).
  On load every participant is marked `online:false` until its socket
  reattaches. The idle-eviction `alarm()` and `forceCloseRoom()` now
  `clearPersisted()` so a genuinely abandoned room (30-min idle / 18-h
  lifetime) is still reclaimed; `cancelEviction()` now unconditionally
  deletes the stored alarm (a stale alarm from a pre-eviction isolate could
  otherwise fire and tear down a resumed room). `handleResume`'s fast token
  path also works again post-eviction since the tokens map is restored.
  **This makes real games survive backgrounding/closing the app — the
  single most important reliability fix for the app's core promise.**
- **Join flow = a dialog over the landing page** (`Welcome.tsx`). "Join a
  game" opens a room-code `Dialog` (dark-scoped to match the always-dark
  landing) instead of swapping the whole screen; Continue connects as a
  guest (role null → shared lobby + `RolePicker`, identical to the host).
  The `?join=CODE` deep link prefills + opens it. Removed the redundant
  `toast.info("Joining game …")` (and its import) on the join path.
- **Game codes are now 3 letters** (`worker/index.ts` `CODE_LENGTH=3`, 24³
  ≈ 13.8k codes over the 24-letter I/O-less alphabet) — far easier to read
  out / type. WS route regex widened to `{3,8}` and every client validator
  (`Welcome`, `OnlinePlaySection`, `MultiplayerBoot`) accepts 3–8 so an
  in-progress game's older 6-char code still joins. No collision check (a
  code lazily names the DO); a clash inside the small concurrent-game
  window is improbable and rehost reclaims by device.

**v931 — preload progress + Stop/Resume in the lobby.** Preload already
STARTED on lobby open (the `GameLobbyDialog` open-effect fires
`preloadDuringHidingPeriod` for host+guest, seeker+hider) — but the detailed
per-bucket progress only showed in Settings, and there was no way to halt it.
Now the lobby renders the full **`PreloadChoicesPanel`** (`showStatus`, area
estimate from `estimateTotalAreaKm2`) with the map byte/percent bar + transit
step bar, plus a **Stop / Resume** control. `preload.ts` gained
`stopPreload()` / `resumePreload()` + a persisted **`preloadPaused`** atom
(`gameSetup.ts`): Stop aborts the in-flight **map** download (the heavy MB-scale
transfer — a module-level `AbortController` whose `signal` now threads into
`loadTilePackForPlayArea` + `preloadTilesForPlayArea`, both already signal-ready;
an aborted run does NOT stamp a completion timestamp so it reads resumable) and
sets `preloadPaused`, which every start path now honours
(`preloadDuringHidingPeriod`, `runPreloadForBucket`, `runMapPreload`, and by
extension the lobby-open effect + `GameStartWatcher`). Resume clears the flag and
re-runs the enabled buckets — completed work is a cache hit and the tile-walk
skips tiles already in the SW range cache, so it CONTINUES rather than restarts.
References/transit have no abort signal yet (lighter, cache-keyed) — a Stop lets
their current query finish but blocks any restart. The metered-link opt-in
checkbox stays as the top row so a cellular download never begins silently.

**v930 — multi-device stability: no forced reload, role-picker clipping,
seeker-location spoof (from real-game testing).**
- **PWA no longer reloads you out of the lobby.** `registerType` was
  `"autoUpdate"` (`vite.config.ts`), which wires a generated
  `activated → window.location.reload()` that fired the instant a new deploy's
  SW was detected (the 60 s / on-focus poll in `PWAUpdatePrompt`) with NO state
  check — during the 2–3 min deploy cadence it hard-reloaded players "out of
  nowhere", ejecting them from the lobby/game. Now **`"prompt"`** mode: `sw.ts`
  no longer `skipWaiting()`s on install (the new SW WAITS), and `PWAUpdatePrompt`
  decides — `isSafeToReload()` (`currentGameCode === null && hidingPeriodEndsAt
  === null`) auto-applies an update when IDLE (preserving v777 auto-update-on-
  deploy on the landing/setup screens), otherwise defers and auto-applies the
  moment the user becomes idle (leaves the room / round ends), with the existing
  "Reload to update" prompt as the manual escape hatch.
- **Guest role-picker no longer clips off the top.** The shared `DialogContent`
  vertically centers with `translate-y-[calc(-50%+…)]`; the `RolePicker`'s plain
  `translate-y-0`/`top-4` override didn't reliably beat that arbitrary value via
  twMerge, so a tall picker stayed centered and its TOP clipped above the
  viewport. Forced the top-anchor with `!important` + a safe-area-aware
  `max-h`/`top` so it sits below the notch and scrolls.
- **Seeker location (incl. a spoof) now reaches the hider reliably.** The
  seeker broadcast (`useSeekerLocationBroadcast`) dropped any fix inside the 5 s
  min-gap and never retried it. A SPOOFED location fires the geolocation watcher
  exactly ONCE (real GPS is suppressed while spoofing), so a spoof set within
  5 s of a prior broadcast was silently lost and the 30 s heartbeat only resent
  the stale pre-spoof fix. Added a **trailing-edge flush**: a fix deferred by the
  gap is remembered and sent when the gap elapses (a newer fix supersedes it),
  so the latest position — spoof or real — is always eventually broadcast.
  (Single-device DEMO mode still can't surface a spoofed seeker — the demo
  broker drops the local `loc`; that's a testing artifact, not a real-game bug.)

**v929 — Move powerup is now fully automatic + card copy fixes.** From a
per-card audit of every powerup/curse (all the changelog's claimed payloads —
photo/film/rock/destination/Drained-Brain/Spotty/Urban/Chalice/discard-costs —
verified genuinely wired end-to-end). The two gaps were both on **Move**, which
the app now handles automatically instead of instructing the hider to do it
manually:
- **Reveals the hider's station to the seekers** (Move's defining mechanic:
  "send the seekers the location of your transit station"). New
  `revealedStation` atom (`gameSetup.ts`) + `SetupState.revealedStation`
  (`protocol/state.ts`); `playMovePowerup` (`roundActions.ts`) captures the
  committed `hidingZone` BEFORE clearing it and sets `revealedStation`, synced to
  seekers via `hostPushSetup` (the server relays the whole `SetupState`, so no
  worker change — rides the welcome snapshot for late joiners too). The seeker
  map (`Map.tsx`) drops a brand-red pin + "Hider was here · <station>" label, and
  the seeker gets a "Hider is on the move" notification.
- **Syncs the seeker freeze.** `seekersFrozenUntil` was a hider-LOCAL atom, so
  the seeker device never showed `SeekerFrozenBanner`. It's now a
  `SetupState.seekersFrozenUntil` field (applied in `applySnapshot` +
  `setupChanged`), so seekers actually see "hold position" during Move's fresh
  hiding period. Both cleared per round (`roundReset.ts`).
- (Deferred, still manual: the Unguided-Tourist / Labyrinth "send an image"
  deliverables — could reuse the photo-cost pipeline; and the self-attested
  hider bonus-award conditions.)
- **Card copy fixes (`CardTile.tsx` `renderBodyText` + `hiderDeck.ts`):** the
  size-triplet tokenizer's trailing shared-unit capture was EATING the word after
  a badge when the values already carried their own unit — so "…10 km FROM you"
  (Bridge Troll), "…20 min <verb> a maze" (Labyrinth), "…20 min BONUS" (Endless
  Tumble) all silently lost a word. Now that word is re-emitted. Labyrinth's verb
  changed "drawing"→"creating". Curse titles render hyphens as NON-breaking
  (`‑`) so "U-Turn" no longer wraps at the hyphen.

**v928 — automatic curse-description length ramp (`CardTile.tsx`).** Replaced the
Cairn-only 3.6cqw special-case with a continuous length→font-size ramp so ANY
long curse fits the fixed card body without clipping:
`descFs = clamp(3.6, 4.5, 4.5 − (len − 350)·0.00224)`. Short curses stay 4.5cqw;
the ramp starts at 350 chars and hits the 3.6cqw floor by ~750 (Cairn). Verified
Curse of the Hidden Hangman (521 chars, previously clipped) now fits at ~4.1cqw,
and Cairn (751) at the floor.

**v927 — debug card gallery gets a full-size Carousel view (`DebugCardsPage`).**
The `/debug/cards` gallery gained a **Grid / Carousel** view toggle (beside the
game-size preview toggle). Carousel steps through every unique template (36:
time-bonus → powerups → curses) ONE at a time at a large size
(`w-[min(80vw,340px)]`), so a card reads exactly as in the hand — prev/next
chevron buttons, left/right arrow-key nav, a card-name + `i / n` counter, and a
clickable dot strip. Deep-linkable via **`?view=carousel`**. Read-only like the
rest of the page (`CardTile` is a pure renderer).

**v926 — per-powerup card tuning + bigger casting cost (`CardTile.tsx`).**
Curse **casting cost** bumped to **4.5cqw**. `PowerupBody` gained per-card
overrides: the default powerup has header **margin-top 8cqw / bottom 4cqw** and a
**4.5cqw** description; **Duplicate** = icon **50cqw**, header mt **6** / mb **2**;
**Move** = icon **50cqw**, header mt **4** / mb **2**, description **4.2cqw** (so
Move's long "send the hiders your transit station" paragraph fits). The
description's old `marginTop` was dropped — the header's `marginBottom` now owns
the title→body gap.

**v925 — join flow mirrors the host flow + card sizing pass.**
- **Joining a room now lands on the SAME lobby + RolePicker as hosting**
  (`Welcome.tsx`, `App.tsx`). The old bespoke inline roster/role picker inside
  Welcome (`join-lobby` mode + `RosterGroup` + `handlePickRole`) was REMOVED.
  Now "Join a game" is just a room-code form; on Continue, `handleJoin` connects
  as a guest (`joinAsGuest` — sets `currentGameCode` + `displayName`=cast name +
  `localIsHost=false` synchronously) with **`playerRole` kept null** and flips
  **`welcomeSeen=true` + `setupCompleted=true`**, then navigates to `/`. That
  satisfies exactly the host's gating: `GameRouteGate` admits the shell, the
  hoisted `GameLobbyDialog` opens (guest's `hidingPeriodEndsAt` arrives null via
  `applySnapshot` pre-start), and the shared `RolePicker` opens on top (role null
  + code set) — where the guest picks display name + role, identical to the host.
  The lobby autohost effect no-ops for the guest (`if ($code && $mp) return`).
  **Deep-link (`?join=CODE`) now works on a FRESH device:** `GameRouteGate`
  preserves the `?join=` param when bouncing an unseen user to `/welcome`, and
  Welcome reads it on mount to prefill the code + jump to the join form. (The
  invite link is `/?join=CODE` from `InviteSheet`.)
- **Card sizing tweaks (`CardTile.tsx`):** icons are **55×55 cqw** (explicit
  w+h again, not aspect-derived) with **margin-top 2cqw**; the general card
  padding is **8cqw** all round (time-bonus, powerup, curse); non-curse headers
  are **12cqw** (curse stays 8cqw); `tracking-tight` removed from every card
  header; the time-bonus size-letter band is `4cqw` / `1cqw 0 1cqw` padding; and
  the curse description is **4.5cqw**, dropping to **3.6cqw for Curse of the
  Cairn** (its rock-tower paragraph is too long to fit larger).

**v924 — card icon framing (zero-padding viewBoxes) + title line-breaks +
thicker curse text (`CardTile.tsx`).** (1) **Icons fill their box with NO
built-in padding** — the authored SVGs had large empty margins in their
viewBoxes, so the icon box was much bigger than the visible glyph (throwing off
the time-bonus title's vertical centering). Each icon's viewBox is now TIGHT =
its real content bounding box (measured via headless-Chromium `getBBox`) + 5
units (half the stroke width, so strokes aren't clipped), and the container is
sized to that box's **aspect ratio** so `meet` never letterboxes. `ClockHexIcon`
+ `PowerupGlyph` now take a single `w` (cqw WIDTH); height = `w * aspect`.
Current sizes: time-bonus `w=74`, powerups `w=54` — tune freely now that box ===
glyph. (2) **Powerup titles break like the printed cards** (`powerupTitleLines`):
comma names break at the comma ("Draw 1, Expand 1" → "DRAW 1," / "EXPAND 1";
"Discard 2, Draw 3" → "DISCARD 2," / "DRAW 3"), everything else one word per
line ("Veto Question" → "VETO" / "QUESTION"; "Duplicate Another Card" →
"DUPLICATE" / "ANOTHER" / "CARD") — instead of width-based auto-wrap. (3) **Curse
header + casting cost thicker** — both already `font-black` (900, the heaviest
weight M PLUS Rounded 1c ships), so a same-colour `WebkitTextStroke` (0.022em /
0.02em) fattens the glyphs past it to match the printed ink weight. (4) **Badge
numbers stay Poppins Bold** — `ICON_FONT` reverted from M PLUS Rounded 1c (a v923
regression) back to Poppins, and **Poppins 600/700/800 is now actually loaded**
via index.html (it was silently falling back to system-ui — the app aliased
`font-poppins` to Inter Tight and never loaded real Poppins).

**v923 — card typography + framing pass to match the physical cards
(`CardTile.tsx`).** (1) **Rounded thick header font everywhere** — every card
title (time-bonus "TIME BONUS", powerup name, curse name) + the minute badge
number/labels switched from `font-inter-tight`/`font-poppins` to **`font-display`
= M PLUS Rounded 1c** (already loaded via index.html at 700/800/900), the heavy
rounded face the printed cards use. (2) **Time-bonus icon bigger + title
centered** — `ClockHexIcon` now takes explicit `w`/`h` cqw (was one square
`cqw`); `TimeBonusBody` renders it at **w=100 h=80** and vertically CENTERS the
"TIME BONUS" title in the gap between the icon and the minute badge (a `flex-1
items-center` row instead of `margin-top:auto` on the badge). (3) **Halved card
corner radius** — the `CardTile` root `borderRadius` cu(4)→cu(2). (4) **Curse
card spec** — `CurseBody` name cu(6.3)→**cu(8)**, padding cu(4.7)→**cu(10)**,
description margin-top cu(3)→**cu(8)**, casting-cost line `font-bold`→**`font-black`**.
(5) `ICON_FONT` (the SVG draw/keep badge numbers) → M PLUS Rounded 1c too. All
sizes stay cqw so the mini hand cards scale in lockstep.

**v922 — bigger card icons + headers (match the physical cards).** Follow-up
to v921: the authored icons + titles were too small versus the printed cards.
Bumped in `CardTile.tsx`: `ClockHexIcon` cqw 52→74, `PowerupGlyph` cqw 46→66,
the "TIME BONUS" title cu(9.3)→cu(13), and the powerup title cu(7)→cu(9.5). All
still scale-invariant (cqw), so the mini hand cards scale in lockstep. Curse
titles unchanged (already print-sized in v920).

**v921 — hider card icons replaced with the user's authored SVG art
(`CardTile.tsx`).** The v918/v919 hand-drawn 100×100 icon approximations were
swapped for the user's Figma-authored icons (design sources in
`design/card-icons/*.svg`). Each glyph now carries its OWN authored viewBox
(time-bonus 317×288, veto 297×301, move 327×280, randomize/duplicate 321×319,
discard/draw + draw+expand 316×307) rendered by `PowerupGlyph`/`ClockHexIcon`.
**Colours:** veto is brand red (`CARD_RED #DC3D38`, matching the physical card),
every other powerup + the time-bonus line/fill is navy (`NAVY #1F2F3F`) — no
pure black. **What stays dynamic:** the time-bonus clock WEDGE (colour + sweep
per `TIER_METER` tier — red 38° → blue 170°); the fanned-cards draw/keep badge
NUMBERS (`cardsGlyph(cards, drawLabel, deltaLabel)` renders bold Poppins `<text>`
over the authored badge circles, so one glyph serves every combo —
discard1draw2 +2/-1, discard2draw3 +3/-2, draw1expand +1/+1; the design SVGs bake
these as paths, the app renders them live). `TWO_CARDS`/`ONE_CARD` consts hold the
two card-art variants. Everything else is fixed authored geometry (the 11
time-bonus tick rects live in `TB_TICKS`, the omitted 12th is behind the "+"
badge). Removed the old `knockoutRect`/`pinPath`/`renderPowerupGlyph` helpers.
Icons still scale with the card via cqw (`ClockHexIcon cqw={52}`,
`PowerupGlyph cqw={46}`, bumped from 40/36 to compensate for the authored
viewBoxes' larger padding). Verified against `/debug/cards`. NOTE: the curse
cards were NOT touched — v920's `CurseBody` typography is already correct on
master; a report that the live gallery shows old tall variable-height curse
cards is a STALE PWA cache (a pre-v912 shell), not a code regression (the
v891 boot watchdog / a hard reload clears it).

**v920 — curse card typography matched to the print.** `CurseBody` fixes: the
"CURSE OF THE …" name is much bigger/bolder (`cu(4.7)`→`cu(6.3)`), the whole
**casting-cost line is bold** (was just the "Casting cost:" label) and its
divider `border-t` was removed, and the description bumped a hair
(`cu(3.7)`→`cu(4)`). Inline S/M/L values still collapse to the active game size
via `renderBodyText` (the card shows only the current size's number, e.g.
"M20 MIN"). Matches the reference deck photo.

**v919 — card art matched to the physical close-ups (second fidelity pass).**
Rebuilt from five close-up reference photos, correcting everything v918 got
wrong. **Time Bonus** (`ClockHexIcon`): the hexagon shell is TILTED (irregular
vertices) while the clock face stays upright inside it — 12 short radial ticks +
a colored pie wedge from 12 o'clock (`TIER_METER` now carries explicit
`sweepDeg`/colour per tier: red 38° → orange 65° → amber 100° → green 130° →
blue 170°) — and the big solid-navy "+" badge sits overlapping the hexagon's
LOWER-LEFT edge with a white knockout ring (not a centre hub). Title stacked
"TIME"/"BONUS". The minute badge is now the printed card's CALENDAR style
(colored rounded-rect border, solid colored header band with the size letter in
white, white body with the big colored number over "MIN") — and per the user's
direction the digital card shows ONLY the active game size's badge (the printed
card shows all three because it can't know the size). **Powerups**: the fanned-
cards glyph (`cardsGlyph`) now matches the print — tilted hexagon, three fanned
knockout-outlined cards, an OUTLINED white circle bottom-left with the draw
count ("+2"/"+3"/"+1") and a SOLID navy circle top-right with the hand delta
("-1"/"-2"/"+1"); **Veto** is the printed "ø card" — an all-red tilted hexagon
with a rotated card inside and a slash through both, white knockouts;
**Randomize** is an isometric die (2 pips top face, 1 pip right face, "?" on the
left face); **Move** is two pins in a hexagon (outline pin behind, solid pin
with a white dot in front); **Duplicate** is two knockout-outlined cards with a
"+" on the front copy. Shared helpers: `knockoutRect` (fat white understroke →
colored outline, the print's white separation rings) + `pinPath`. Verified
against the debug gallery via headless-Chromium screenshots.

**v918 — hider cards redrawn to resemble the PHYSICAL cards (icons + layout).**
The cqw scaling (v912) was right but the `CardTile` art didn't look like the
printed cards. Redrawn to match: (1) **Time Bonus** — the clock-hexagon icon
moved to the TOP (was a scaled-solid hexagon at the bottom) and rebuilt as
`ClockHexIcon`: a hexagon with clock tick marks + a colored **pie WEDGE** whose
sweep grows with the bonus tier (`pieSlice`/`pointOnCircle` helpers,
`30 + fillFrac*220`°) + a navy "+" hub — then the "TIME BONUS" title, then the
**three S/M/L minute badges** pinned at the bottom (`SizeMinutesBadge` restyled
to colored yellow/orange/red chips with letter + big number + "MIN"; the active
game size is navy-ringed — digital-aware, but all three show for fidelity). This
reverses the earlier single-collapsed-number layout in favour of matching the
printed card. (2) **Powerups** — the generic Lucide icons were replaced by custom
per-powerup SVG glyphs (`PowerupGlyph`/`renderPowerupGlyph`): **Veto** = a RED
prohibition sign in a red hexagon; **discard1draw2 / discard2draw3 / draw1expand**
= overlapping cards with a draw badge (+2/+3/+1) top-left and a keep/expand badge
(1/2/+1) top-right (`cardsGlyph`); **randomize** = a die face with a "?";
**duplicate** = a card copied to a second card ("+"); **move** = a location pin in
a hexagon. All SVG (viewBox-based) so they scale with the card's cqw sizing. Curse
layout (name → description → casting-cost) already matched and is unchanged.
Removed the dead `HexFrame`/`scaleHexPoints`/`TimeBonusHexIcon`/`PowerupHexIcon`/
`POWERUP_ICON` + the Lucide icon imports (only `Check` remains).

**v917 — committed-zone card = scouting hub (bigger snapshot map + transit
modes).** Follow-up to v916. The committed-zone card in the Zone drawer
(`HiderHome` `HidingZoneSection`) was rebuilt: (1) a **full-width zone map**
(`w-full h-44`, up from a 128px square) so streets read for scouting, rendered
as a **static PNG snapshot** — `ZonePreviewMap` gained a `snapshot` prop that
captures the settled view via `toDataURL` on `onIdle` (+ `preserveDrawingBuffer`),
caches it in a bounded module `snapshotCache` keyed by lat/lng/radius/padding/
theme/satellite/tile, and renders a cheap `<img>` (the same "save the map as an
image" behaviour the question-log outcome maps use; the react-map-gl default
import was renamed `MapGL` so `new Map()` for the cache doesn't collide). (2)
**Transit-mode glyphs** — the committed station's modes now ride the zone:
`HidingZone.modes?` + `ZoneStation.modes?` added, `confirmAndCommitZone` stores
`station.modes`, and the two pickers (`HidingZoneSection` onPick + `HiderZoneHint`)
pass `modes:[s.mode]` from the picked `FoundStation`; the card renders
`TRANSIT_ICONS[mode]` glyphs (deduped). (3) **Coordinates removed**, (4) **zone
name bigger** (`text-xl`→`text-2xl`), (5) **radius icon removed** (the Radar glyph
— kept just the "0.5 km radius" text next to the mode glyphs). A map-picked zone
(no station) has no modes → shows just the radius; old committed zones lack
`modes` and degrade the same way.

**v916 — committed-zone (scouting) drawer polish.** Once the hider commits a
zone but keeps the timer running, the Zone drawer is effectively their scouting
hub. Five tweaks: (1) the drawer **subheader is committed-aware** (`HiderBottomNav`)
— "Scout your zone and mark potential hiding spots." whenever `hidingZone !== null`
with the timer still running (was stuck on "Select a station…" because it only
switched once the hiding period was OVER via `inZoneStage`); the seeking-phase
"Explore your zone and find your final hiding spot." stays for `inZoneStage`.
(2) The **"End timer" button is right-aligned** (`justify-end`, was centered) so
it sits under the header's countdown badge. (3) The drawer header's **`border-b`
divider was removed**. (4) The committed-zone card's **`ZonePreviewMap` is bigger
+ more zoomed** (`w-20 h-20`→`w-32 h-32`, `padding 6`→`2` so streets read for
scouting). (5) The **zone name is larger** (`text-base`→`text-xl`) with a "Your
zone" eyebrow, and the card now shows the **hiding radius** (Radar icon +
`hidingRadius`/`hidingRadiusUnits`, e.g. "0.5 km radius") as relevant
roam-distance info above the coords.

**v915 — sound disabled app-wide (master kill switch) while clips are sourced.**
`src/lib/sound.ts` exports `SOUNDS_ENABLED: boolean = false`: `play()` is a hard
no-op, `installSoundUnlock()` never arms the audio-unlock listeners / preload,
and `AppSettingsDrawer` hides the "Sound" toggle row (so there's no dead
control). All the v911–v913 wiring (recipes, `SOUND_FILES` sample path, the
per-beat `play()` calls) is untouched — flip `SOUNDS_ENABLED` to `true` to bring
audio back, at which point the persisted `soundMuted` toggle works normally
again. Intended to pair with registering real clips in `SOUND_FILES` (see
`public/sounds/README.md`).

**v914 — play-area preview framing is device-consistent + not over-zoomed-out.**
`PlayAreaPreviewMap` (the lobby header preview + wizard/summary previews) framed
with a large pixel `framePadding` — the lobby passed **`framePadding={72}` into an
`h-[200px]` map**, so 144 px of the 200 px height was padding, leaving ~56 px to
fit the whole play area → wildly over-zoomed-out (NYC's 5 boroughs shown with
Scranton→Long Island around them), AND because 144 px is a device-DEPENDENT
fraction of the variable-width container, the zoom differed on every screen (the
reported "zoom changes across devices"). Fixed by framing with a **geographic
margin** instead: `marginBounds(bbox)` expands the fitted bbox by
`FRAME_MARGIN_FRAC` (0.16 = play area + 16% context, with a small absolute floor
for degenerate spans) and `fitBounds` uses a tiny fixed `FRAME_PIXEL_PAD` (12).
The framed extent is now geographic (play area + 16%) so it's the same on every
device (only aspect ratio still varies, unavoidable with any fit) and no longer
over-zoomed. Applied to ALL five fits (combined-boundary, primary-tighten,
initial bbox, committed-added-areas, candidate-widen). The now-unused
`framePadding` prop was removed (only the lobby passed it).

**v913 — warmer synth + plug-and-play sampled-audio path.** Two changes to
`src/lib/sound.ts` after "the synth is too 8-bit" feedback. (1) The procedural
recipes were WARMED UP: softer attacks, low-pass-rounded tones (added `lp` to
the tone primitive), sine/triangle blends instead of raw saw/square, and a
**shared convolution reverb** (`ConvolverNode` fed a synthetic decaying-noise
impulse; each synth voice sends a wet copy through it) so the sounds read as
polished UI blips rather than chiptune. Still synthetic — samples are the real
path to realism. (2) A **sampled-file source** now takes priority per beat:
`SOUND_FILES: Partial<Record<SoundName,string>>` (EMPTY by default → no 404
probes) registers a file per beat; `preloadSoundFiles()` (fired on the unlock
gesture) decodes them into `AudioBuffer`s, and `play()` uses the buffer if
present (played DRY — produced files don't want the synth reverb), else the
synth. So dropping a CC0 file into `public/sounds/` and adding one line to
`SOUND_FILES` upgrades a beat to real audio, with automatic synth fallback if a
file is missing/fails. **`public/sounds/README.md`** documents the drop-in flow
+ recommended free sources (Kenney.nl CC0 is the best fit — dice/card/UI packs,
no attribution, commercial-OK; Mixkit/Pixabay for the fanfare). No files are
bundled yet — every beat still uses the (warmer) synth until files are added.

**v912 — cards are ONE scale-invariant layout (mini = full card shrunk, like a
resized photo).** Supersedes the v910 vertical-centering. `CardTile` no longer
has a re-laid-out `compact` variant that changed font/icon sizes and hid the
description — it renders ONE canonical layout at any display size using CSS
**container-query units** (`cqw` = 1% of the card's own width). The card root is
a query container (`style={{ containerType: "inline-size", borderRadius:
cu(4) }}`) and EVERY font-size / padding / icon / gap below is a `cqw` value
(`cu(n)` = `${n}cqw`, numbers chosen as px÷3 so a ~300 px full card matches the
old absolute sizes) — so a mini hand card is the full carousel card mathematically
shrunk, not a different layout. Icons (`HexFrame`/`TimeBonusHexIcon`/
`PowerupHexIcon`) take a `cqw` size; the inline `SizeBadge` is sized in `em`
(relative to the surrounding cqw description) so it scales too. Layouts are now
**top-anchored to match the physical cards** (revert of v910's centering, which
diverged): TimeBonus = "TIME BONUS" title → big minutes → hex meter; Powerup =
hex icon → title → description; Curse = "CURSE OF THE …" name (left) → description
→ casting cost pinned at the bottom (the v306 overflow-scroll safety net is kept
on the description). The empty lower area on a sparse card is authentic to the
real cards (they're top-anchored with whitespace). The `size?: CardTileSize` prop
is kept (deprecated no-op) so old `size="compact"` call-sites still typecheck.
Applies everywhere `CardTile` renders (draw picker, hand carousel, hand grid,
discard pile, fan miniature, debug gallery).

**v911 — procedural sound engine (first audio in the app).** The app had NO
audio. `src/lib/sound.ts` is a self-contained **Web Audio synthesis** engine —
every SFX is generated in code (oscillators + gain envelopes + noise bursts),
so there are **zero asset bytes, no licensing, offline-safe**. One lazy shared
`AudioContext` + master gain (0.45), resumed on the first user gesture via
`installSoundUnlock()` (called once from `main.tsx`, outside React — mirrors the
theme / body-pointer-events / debug-tap installers). A persisted
`soundMuted` atom (`jlhs:soundMuted`, **default OFF = sound on**) gates
everything; `play(name, opts?)` is a no-op while muted, while the tab is
backgrounded (OS notifications own that channel), or where Web Audio is
unavailable, and never throws. Six recipes wired into the highest-impact beats
(the "starter set"): **countdownTick** (rising pluck per 3-2-1 step) + **go**
(warm ascending triad + sub thump) in `GoGoGoOverlay`; **elimination** (downward
"cut" whoosh) in `Map.triggerEliminationFlash` — fires as the ruled-out slice
flashes; **roundEnd** (major-arpeggio fanfare) once per `EndOfRoundDialog`
reveal; **cardDraw** (light swish) on `DrawPickerDialog.confirmSelected`;
**dice** (rattle + settle) on `DiceRoller.roll`. A **Sound On/Off toggle**
(Volume2/VolumeX) sits in `AppSettingsDrawer`'s App section next to Theme. More
beats (curses, timer warnings, endgame claim, question-sent) can hang off the
same `play()` dispatcher — add a `SoundName` + recipe and call it. Upgrading to
sampled audio files later reuses the same engine surface.

**v910 — card body content is vertically centered (fills the tall 5:7 card).**
`CardTile`'s three bodies (`TimeBonusBody`/`PowerupBody`/`CurseBody`) were
top-aligned, so a sparse card (TIME BONUS · 3 MIN, or VETO QUESTION + two
lines) clustered its content at the top and left the lower ~half of the poker
(5:7) card an empty white void — glaring at the draw picker's ~76%-width card
size (looked like a badly-proportioned oversized card). All three now vertically
center: TimeBonus adds `justify-center`; Powerup/Curse wrap their icon/name/
description group in a `min-h-full flex flex-col justify-center` inside the
existing `overflow-y-auto` scroll box, so short content centers and a long
description still scrolls from the top (the v306 safety net is preserved). Curse
keeps its left horizontal alignment (the "CURSE OF THE …" name leads); the
casting-cost stays pinned at the card bottom. Applies everywhere `CardTile`
renders (draw picker, hand carousel, hand grid, discard pile, fan miniature).

**v909 — hand card-play carousel is a translate-track peek-carousel (exact
centering).** `HandCarousel` (`HiderHandFan`) — the full-screen sheet that
opens when the hider taps their hand fan — replaced its horizontal scroll-snap
row (v299–v311's rAF-scroll-polling saga) with the SAME translated peek-carousel
`DrawPickerDialog` uses (v901): the active card is centred at `CARD_BASIS_PCT`
(80%) of a `max-w-md` container so neighbours PEEK (scaled `0.86` + dimmed) at
the edges, a horizontal SWIPE flicks between cards with a live finger-follow
(`dragDx`) snapping past `SWIPE_THRESHOLD` (45 px) on release, tapping a peeking
neighbour centres it, and the dots jump to any card. `focusIndex` is now driven
DIRECTLY by swipe/tap/dots (no scroll position to read back), so the centred
card and the action row below it are always exactly aligned — the scroll-snap
version landed a few px off-centre, leaving the "New question"-style action row
misaligned. Removed `trackRef`, the on-open `scrollLeft` jump, the v311 rAF
`scrollLeft` polling effect, and the resync effect's re-anchor scroll (the
length-resync now just clamps `focusIndex`). Vaul drawer chrome, the close/back
handling, and the discard/draw resync are unchanged.

**v908 — time-bonus add-on on the hider timer + end-of-round pills styled
like the card.**
- **In-hand time-bonus add-on** (`HiderMapTimer`): both timer boxes (golden
  "Hiding time remaining" + white "Hidden for") now show a small hourglass
  pill `+Nm` — the sum of the hider's held time-bonus cards
  (`tallyTimeBonusMinutes($hand, $gameSize)`) — so the hider sees the credit
  their hand will add at round end, live. Self-hides at 0.
- **End-of-round bonus pills** (`EndOfRoundDialog`) resemble the TIME BONUS
  card (Hourglass icon + minutes) instead of bare "+N", and stack in a column
  just to the RIGHT of the hidden-time clock (was centred ABOVE it), keeping
  the v851 `jlBonusChip` pop-in-then-float animation.

**v907 — Drained Brain blocks 3 specific QUESTIONS, not 3 categories.**
Rulebook: "Choose three questions in different categories." The app was
blocking 3 whole CATEGORIES. Now the cast picker (`CastCurseDialog`) selects
3 specific questions, one per category: radar/thermometer are a single
question (a bare-category row), matching/measuring/tentacles/photo expand to
pick ONE subtype (`getSubtypes`). Each pick is a question id — a bare
category id (`"radius"`) or `"<category>/<subtype>"`. Rides the new
`CursePayload.disabledQuestions` / `SharedCursePayload.disabledQuestions`
(legacy `disabledCategories` kept for older casts). `computeAskingRestrictions`
(`curseEnforcement.ts`) splits them into `disabledCategories` (bare ids —
whole category off) + `disabledSubtypes` (`"cat/sub"` — that one question
off); `AddQuestionDialog` disables the matching category tiles AND the
specific subtype tiles ("Blocked by Curse of the Drained Brain"). One
question per category enforced at pick time (a second pick in a category
replaces the first); exactly 3 to cast.

**v906 — hider sees the curses they've cast (active-curse mirror).** The
seeker's `CurseInbox` shows received curses; the hider had no view of what's
active on the seekers. New hider-side `castCurses` atom (`seekerInbound.ts`,
same `ReceivedCurse` shape, persisted, reset per round alongside
`receivedCurses` in `roundReset`), appended by `recordCastCurse(payload)`
whenever the hider casts (BOTH the multiplayer and link paths in
`CastCurseDialog`, so it works in every mode). `HiderActiveCurses.tsx`
renders them (name + description + any payload target + a manual "Mark
cleared" per curse, since clears are a real-world action) in `HiderHome`'s
seeking view; self-hides when none. Local record only — no wire sync (it
reflects THIS hider's casts).

**v905 — Pause actually freezes every timer (`useNow` pause-freeze).** The
manual "Pause game" repaid time on RESUME (`resumeGame` shifts
`hidingPeriodEndsAt` / answer windows / freeze forward) but the LIVE timers
kept ticking during the pause — worst of all the hiding countdown, whose
components (`HiderTimer`, `HiderMapTimer`) rolled their OWN private
`Date.now()` interval instead of the shared clock, so they bypassed any
freeze (the reported "pause doesn't pause the hiding timer" bug). Fix: the
shared **`useNow`** clock (`src/hooks/useNow.ts`) now FREEZES at the
pause-start instant while `manualPausedAt` (or the location-share pause) is
set — it reads the pause atoms and re-ticks the instant a pause toggles — so
EVERY countdown that reads it stops. Migrated all the private-interval timer
components onto `useNow`: `HiderTimer`, `HiderMapTimer`, `HiderGracePrompt`,
`HidingCountdownBadge`, `HiderUnansweredOverlay`, `HiderZoneHint`,
`SeekerETACard` (the answer-window / curse "clears in" / `cards/base` timers
already used `useNow`, so they now freeze too). Combined with `resumeGame`'s
deadline shifts, every timer freezes live during the pause and continues
exactly where it stopped on resume — no double-count (frozen `now` +
deadline-shift cancel). The full-screen `GamePausedOverlay` curtain (its own
count-UP timer deliberately keeps running) blocks interaction throughout.
Still LOCAL-scoped (a synced multiplayer pause would ride `SetupState`) — the
paused device freezes completely.

**v904 — Mediocre Travel Agent destination payload.** The hider now names the
place they're sending the seekers to (a free-text destination near the
seekers) in `CastCurseDialog`; `curseCostRequiresDestination(castingCost)`
(`castingCost.ts`, `/vacation destination/i`) gates a text input, required
before casting in multiplayer. Rides `CursePayload.travelDestination` /
`SharedCursePayload.travelDestination` → server/demo relay verbatim →
`receivedCurses` → `CurseInbox` shows "Destination: …".

**v903 — two more curse payloads: Cairn rock-count + Ransom Note photo.**
- **Curse of the Cairn** now carries `rockCount` — the number of rocks the
  hider's tower reached, the target the seekers must match. New
  `curseCostRequiresRockCount(castingCost)` (`castingCost.ts`, `/\brock
  tower\b/i`, unit-tested) drives a +/- stepper in the casting-cost box of
  `CastCurseDialog`; required before casting in multiplayer. Rides
  `CursePayload.rockCount` / `SharedCursePayload.rockCount` → server/demo relay
  verbatim → `receivedCurses` → `CurseInbox` shows "Build a rock tower N rocks
  high."
- **Curse of the Ransom Note** now delivers the hider's proof PHOTO (a picture
  of the physical ransom note). `curseCostRequiresPhoto` was extended to match
  the ransom-note casting cost (`/ransom note/i`), so the existing photo
  capture/upload flow (Zoologist/Luxury Car) fires for it too.

**v902 — matching answer-map shows the reference IDENTITY, not distance.**
On the hider's answer-comparison map (`HiderMap`), the seeker's-nearest and
hider's-nearest reference markers (`RefPointMarker`) were labelled with the
DISTANCE ("Seeker · 3.8 km") — but for a MATCHING question the distance is
irrelevant; what matters is WHICH reference each is nearest to. The marker now
shows the reference NAME for matching ("Seeker · Newark Airport", truncated,
`max-w-[9rem]`) and keeps the distance for measuring (where the number is the
point). `RefPointMarker` takes a preformatted `detail` string; `fmtRefDistance`
extracted for the measuring side.

**v901 — draw-picker peek carousel + swipe.** The draw picker
(`DrawPickerDialog`) went back to a CAROUSEL feel: the active card is centred
at `CARD_BASIS_PCT` (76%) of the container so each neighbour PEEKS at the
edges (scaled `0.86` + dimmed), and a horizontal SWIPE flicks between cards
with a live finger-follow (`dragDx`), snapping on release past
`SWIPE_THRESHOLD` (45 px). Tapping a peeking neighbour centres it; a swipe
suppresses the trailing tap so it never accidentally selects. Keeps the v886
lock-on reliability (translated track, not free-scroll) + the prev/next arrows
+ dot indicators + the fly-to-hand `position:fixed` escape. The confirm button
shows only under the ACTIVE card (`isSelected && isActive`).

**v900 — photo brush tool + zoomable answer map + POI drawer + lobby/text
polish.**
- **Photo black-out is now a BRUSH, not a rectangle** (`PhotoCensorDialog`).
  A `redact` op is a freehand STROKE — a polyline of points + a radius (both
  in original-image coords, radius a fraction of image width), painted with
  round caps/joins (`paintStroke`); one pointerdown→up = one undoable stroke,
  a tap = a dot. Non-destructive stack + crop + confirm-flatten unchanged;
  icon → `Paintbrush`, copy → "Brush over anything identifying…".
- **Hider answer-comparison map is zoomable** (`HiderMap`) — `scrollZoom` /
  `doubleClickZoom` / `touchZoomRotate` / `dragPan` all on (the one-shot
  `fitBounds` is `idledOnce`-guarded, so the user's zoom sticks).
- **Hider map-drawer POI list only shows while the search box is focused**
  (`HiderMapDisplayControls` `HiderPoiSection`) — it no longer pushes the
  transit-overlay toggles off-screen when collapsed; list rows
  `onMouseDown`-preventDefault so a tap doesn't blur-close before the toggle
  fires, and the input's blur is delayed 120 ms.
- **Highlighted POIs visible down to z10** (`HiderPoiOverlay`) — dot/ring
  radius interpolation extended to zoom 10, labels `minzoom` 14→12.
- **Measuring disabled text: "None in the play area"** (dropped the "or near"
  — only in-area references count) for the presence-gated HSR / international
  border tiles.
- **Lobby SHARE section vertically centered** (`GameLobbyDialog`) — `pt-7 pb-4`
  → `py-4`.

**v899 — holedMask → worker + cancel phantom-answered fix + measuring
disabled-reason text.**
- **`holedMask` (the world-scale dimming mask) runs in the geometry Web
  Worker** (`holedMaskViaWorker`, geometry `worker.ts`/`client.ts`), used by
  `Map` (its already-async, generation-guarded elimination effect) and
  `HiderBackgroundMap` (its deferred compute). The `turf.difference` of a
  world rectangle minus a dense play-area multipolygon blocked the tab for a
  beat every time an answer shrank the remaining area; now it's off-thread
  with a transparent main-thread fallback (`operators.holedMask`) if the
  worker is unavailable. (Attempted the same for the @arcgis/core geodesic
  buffer that drives the body-of-water/coast measuring cut, but arcgis in a
  worker duplicates ~2.5 MB of a browser-centric lib whose worker-safety
  can't be verified here — reverted; that freeze stays on the main thread for
  now.)
- **Cancelling a question dialog no longer reveals a phantom "answered"
  card.** A never-sent draft could count as pending for ONE render (before
  `configuringQuestionKey` excluded it), latching a STICKY answered card
  behind the configure dialog that showed on Cancel. `PendingAnswerOverlay`
  now only transitions to "answered" for a question that was actually SENT
  (`createdAt` stamped); a draft that leaves the pending set with no
  `createdAt` is a discarded draft → shows nothing.
- **Measuring disabled-reason text fixed + genericised.** High-speed rail /
  international border are presence-gated (measuring needs just ONE reference
  in/near the area — the gate was already correct), but the disabled text
  fell through to the count-based "Only one … not enough" string, which read
  as the matching ≥2 rule. They now say "None in or near the play area — this
  can't narrow the map," and every disabled reason is GENERIC (no longer names
  the question type): "Only one in the play area — not enough to ask this,"
  "None in the play area to ask about," "…in one region…".

**v898 — lobby game-size dropdown polish.** The host's size popover
(`GameLobbyDialog`) had oversized, centred pills on a white `bg-popover`
card that didn't match the map's trigger pill. The option pills now match
the trigger exactly (`text-sm px-3 h-10 shadow-md`), the popover is
`items-start` (left-aligned) with NO background/border/shadow
(`bg-transparent border-0 shadow-none p-0`), so the size options read as
bare pills floating over the map.

**v897 — body-of-water: inland area wrongly "closer to water" fixed
(`seaFromCoastline` face labelling).** The measuring body-of-water elimination
folds the SEA in as an AREA built by `seaFromCoastline` (v770/v776), which
tiles the play-area frame into faces (coastline + frame edges) and labels each
face land/water by the OSM right-of-way rule. The OLD labeller **flooded**:
for every coastline segment it sampled a point ~44 m to the RIGHT and marked
whichever face CONTAINED that sample as water. In dense real-world coast
(NYC's harbour + tidal rivers) a single stray or mis-directed segment sampled
into a big INLAND face and flagged the whole thing water — so an inland area
far from any water sat inside the seeker-distance buffer and got marked
"closer to water" than the seeker (the reported SW-NYC bug). Rewritten to
label **each face by its OWN geometry** relative to the coastline nearest to
IT: take a STRICTLY-interior point of the face (centroid if
`ignoreBoundary`-inside, else the largest triangle's centroid via
`turf.tesselate` — a boundary/corner centroid classifies degenerately), find
the nearest coastline segment(s), and sum the per-unit-length signed
perpendicular offset over every segment at the minimum distance (summing at a
shared VERTEX is the angle-bisector rule, correct at convex AND reflex
corners); > 0 ⇒ water side. A distant mis-directed segment can no longer
influence a face it doesn't bound, so an inland face is classified by its real
nearest shore → land. Same guards (seeker-not-in-sea, degeneracy, near-whole-
frame) and null-fallback contract; runs on the main thread AND in the geometry
Web Worker (both import this module). Unit-tested (`tests/seaFromCoastline.ts`,
6 cases incl. the concave L-shape corner).

**v896 — performance pass (countdown hitch + re-render fan-out + radar
trig).** From a two-agent perf review; the safe, high-ROI, low-risk wins:
- **Countdown hitch:** the pre-game `GameLobbyDialog`'s `PlayAreaPreviewMap`
  is PAUSED (replaced by its placeholder) while the game-start flourish runs
  (`mapReady && !$overLobby`), so during the 3-2-1 only the in-game shell's
  MapLibre context is initialising — not two live GL contexts fighting the
  main thread.
- **Re-render fan-out fixes:** (1) `HiderBackgroundMap`'s seeker-label
  collision effect rAF-COALESCES map `move`/`zoom` (one recompute per frame,
  not per event) and Set-DIFFs the result so an identical label set is a
  no-op `setState`; (2) `Map`'s per-question marker JSX is a memoized
  `questionMarkerList` (`useMemo` on `$questions`) instead of a `flatMap` on
  every render; (3) `useSelfPositionWatch` THROTTLES GPS fixes — a fix that
  moved <6 m and is <4 s old is dropped, so stationary GPS jitter (a fix/sec)
  no longer re-renders both map subtrees + every `lastKnownPosition`
  subscriber each tick.
- **Radar sweep trig:** the pending-radar `radar-sweep` overlay built its
  perimeter fan with a `turf.destination` call per segment per frame
  (~25 geodesic calls × targets × 60 fps); replaced with inline
  equirectangular trig (`kmPerDegLat`/`kmPerDegLng` + sin/cos), same visual,
  a fraction of the cost.
- **Deferred (needs its own green-light):** move `holedMask` (the world-scale
  `turf.difference` elimination mask, `operators.ts`) and the seeker Voronoi
  into the geometry Web Worker; throttle `useQuestionImpact` during pin-drag.

**v895 — hider POIs reworked: native basemap field + highlight-dots +
searchable type list.** Replaces the v888/v894 custom-dot field.
- **The POI FIELD is now the basemap's NATIVE Protomaps `pois` layer**
  (icons + names) rather than custom dots. `protomapsMapLibreStyle(theme,
  {keepPois})` keeps the `pois` layer (normally dropped in
  `curatedBasemapLayers`); `HiderBackgroundMap` builds its style with
  `keepPois:true` and toggles the layer's `visibility` at runtime
  (`setLayoutProperty`, re-applied on `styledata`) from the `hiderPoiShow`
  master toggle.
- **DOTS are now ONLY for HIGHLIGHTED types** — `HiderPoiOverlay` draws bold
  group-coloured dots + labels for the kinds in `hiderPoiHighlightKinds`
  (multi-select, was a single `hiderPoiHighlightKind`), read from the pmtiles
  `pois` source-layer (Overpass-free), so "where are all the supermarkets"
  pops over the native field.
- **Map-drawer POI control** (`HiderMapDisplayControls` `HiderPoiSection`): a
  "Show places" master toggle (native field) + a **searchable dropdown LIST**
  of every POI type — a search box filters the list, and tapping a row toggles
  that type into the highlight set (checkbox + group-colour dot). A "Clear N
  highlighted" reset appears when any are on. Active-count badge counts a
  non-empty highlight set.

**v894 — game view LOADS during the countdown again (lobby hoisted, no
reload) + lobby size-pill sizing.**
- **The map is loaded by the time the GO-GO-GO card is dismissed.** v889
  fixed the "lobby reloads mid-countdown" bug by keeping the lobby mounted
  through the flourish and mounting the in-game shell only ON DISMISS — which
  reintroduced v828's "the game view is still loading when I close GO-GO-GO".
  Root fix: **`GameLobbyDialog` is now HOISTED to the top of `SeekerPage` /
  `HiderPage`** — rendered ONCE, ABOVE the pre-game↔in-game branch — so arming
  the clock at Start can swap to the in-game shell (which mounts + LOADS the
  map DURING the 3-2-1 countdown, restoring v828) WITHOUT remounting the lobby
  or reloading its `PlayAreaPreviewMap`. The branch guard is back to
  `!clockArmed`; the shell is held `opacity-0` while `flourishActive` and fades
  in (0→1) as the App-level GoGoGo cover fades out. The lobby is a body-portaled
  drawer whose own `open` state (kept open through the flourish via
  `gameStartOverLobby`) drives visibility, so one stable instance is correct.
  `GameLobbyDialog` was removed from BOTH branches in each page and mounted once
  above them; the singletons + other modals (RolePicker, GameSetupDialog,
  GameStartWatcher — remount-safe via `gameStartFiredFor`) stay per-branch.
- **Lobby size-pill sizing:** the game-size pill got an explicit `h-10` so it
  matches the transit-icon pills + edit button (all 40px) — they were subtly
  different heights (the pill was text-driven `py-2` ≈ 36px vs the 40px
  `GLASS_PILL`s).

**v893 — subtype-picker header cleanup, flat question cards in
drawers/dialogs, more-intense countdown dim/blur.**
- **Subtype-picker drawer header (`AddQuestionDialog`):** the category
  icon block was REMOVED; the title + description are now a COLUMN beside
  the back button, so the "Is your nearest ___…" line aligns with the
  "MATCHING" title instead of hanging at the far-left edge.
- **`QuestionOverlayCard` gained a `flat` prop** — drops the `shadow-xl`
  lift (keeps the border). The heavy shadow reads well when the card floats
  OVER the map (the on-map overlays keep it) but looks wrong inside a
  drawer/dialog/list, so those callers pass `flat`: the add-question
  category + subtype picker tiles (`AddQuestionDialog`), the collapsed
  question card + configure-dialog header (`cards/base.tsx`), the hider
  Questions-drawer awaiting/answered cards (`HiderQuestionLog`), and the
  hider answer-dialog banner (`HiderView`). The on-map overlays
  (`PendingAnswerOverlay`, `HiderUnansweredOverlay`, `ThermometerOverlay`,
  `HiderZoneHint`) keep the shadow.
- **Countdown dim/blur made more SEVERE** (correcting v892's speed-up which
  wasn't the ask): backdrop opacity now 0.4 → 0.66 → 0.85 across 3/2/1
  (was 0.12/0.34/0.58), blur 3 → 6 → 9 px (was 0.5/1.5/2.5), GO at 0.97 /
  blur-10; transition eased back to 400ms — the lobby dissolves hard behind
  the countdown.

**v892 — lobby header polish, settings cleanup, follow-me fix, faster
countdown dim, preload total reconciliation.**
- **Lobby header (`GameLobbyDialog`, pre-game):** House Rules section
  removed; the play-area name + its edit pencil MERGED into one top-right
  chip (host taps it to edit; the top-left name chip is gone); transit-edit
  button enlarged to the transit-icon size (`GLASS_PILL` 40px); Share/Copy/QR
  buttons enlarged to match (`GLASS_PILL_BTN`); map zoomed out
  (`framePadding` 40→72); more top padding on the share section
  (`pt-3`→`pt-7`); the game-size popover tightened to just the pills (`w-auto`,
  ring-selected, no checkmark/empty space); **QR dialog lifted to z-[1060]**
  (it was opening BEHIND the lobby drawer at the default z-[1050] — the "QR
  button does nothing" bug, same class as v797). **Pause game moved here**
  from Settings — a warning-styled button above Leave game, shown only while
  a game is running.
- **`AppSettingsDrawer`:** Pause removed (now in the lobby); more space
  between How-to-play / Rulebook (`space-y-2`→`space-y-3`).
- **`PWAInstallButton`:** the UA-sniffed "To install on iOS, tap Share → Add
  to Home Screen" hint was REMOVED — it showed on any browser spoofing an iOS
  UA (Firefox desktop in responsive/mobile mode) and a static instruction
  isn't an install action. Now shows ONLY a real captured `beforeinstallprompt`
  button or the installed chip, else nothing (matches v881's landing philosophy).
- **Units:** dropped the **Meters** option (`UnitSelect` → Miles / Kilometers).
- **Theme toggle:** the segmented control now shows **Auto / Light / Dark**
  text labels beside the icons (was icon-only; "System" relabelled "Auto").
- **Follow-me fixed (seeker + hider):** panning the map now turns Follow Me
  OFF (via `onDragStart` on both `<Map>`s — only a USER drag fires it, not the
  programmatic follow `easeTo`), so it stops fighting a manual pan. While ON it
  still recenters on each GPS fix.
- **Seeker Questions drawer:** removed the yellow "HIDING PERIOD" warning
  banner.
- **Game-start countdown:** the backdrop dim+blur ramps MUCH faster (CSS
  transition 650ms→220ms) so each 3-2-1 step snaps in.
- **Preload total reconciled (`PreloadChoicesPanel`):** the footer summed
  pre-download ESTIMATES while each row showed ACTUAL bytes once downloaded, so
  an NYC game read "Estimated total ~63 MB" under a "Map — Downloaded 94 MB"
  row. The total now sums actual bytes for downloaded buckets (estimate only
  for not-yet-loaded ones) and relabels "Total downloaded" once nothing is an
  estimate.

**v891 — boot watchdog: blank-screen self-heal for a stale PWA shell.** An
installed PWA whose service worker serves a STALE app shell (a cached index
referencing chunk hashes the latest deploy already replaced) fails to load
the entry bundle → React never mounts → BLANK black/white screen, and NO
in-app error boundary can help because no app code ran (the reported "Chrome
PWA shows a blank screen while Firefox on the same phone works" — same JS, so
it's environment/cache-specific, not a code bug). Existing `lazyWithRetry` +
`MapErrorBoundary` only help AFTER the entry bundle loads; there was no
boot-level safety net. Added an inline watchdog in `index.html` (runs before
the module script so its listeners are armed): `main.tsx` sets
`window.__APP_BOOTED` + calls `window.__cancelBootWatchdog()` the instant the
entry executes; if that never happens within 12 s — or a SCRIPT/module-chunk
`error`/`unhandledrejection` fires before boot — it drops the service worker
+ every Cache Storage entry and hard-reloads ONCE into a fresh, consistent
shell. `sessionStorage`-guarded so it can never loop (a fresh shell that
still fails is left alone). Only a failed SCRIPT counts (a failed font/CSS
LINK is non-fatal → no false-positive cache nuke). The watchdog is precached
into the shell, so future stale states self-heal; a CURRENTLY-bricked PWA
recovers once its SW picks up this build (or via a manual "clear site data" /
reinstall).

**v890 — debug: "Fill hand with random curses" button.** `DebugPhaseControls`
`fillHandWithCurses(6)` adds a batch of DISTINCT random curses to the hider
hand (slices the shuffled curse pool) so the whole cast flow — dice, discard
cost, photo/film capture, Drained Brain picker — can be exercised in one go.
Ignores the hand cap; syncs over the wire via the deck bridge like the other
debug draws.

**v889 — start-round countdown: the lobby no longer RELOADS mid-flourish;
it dims + blurs progressively, then GO-GO-GO bursts.** The bug: the instant
the hiding clock armed, `clockArmed` flipped and `SeekerPage`/`HiderPage`
swapped the pre-game branch for the in-game shell — which REMOUNTED
`GameLobbyDialog` (mounted in BOTH branches), reloading its
`PlayAreaPreviewMap` right as the 3-2-1 played (the "lobby sort of reloads
in the middle of the countdown"). Fix: the branch guard is now
`if (!clockArmed || flourishActive)`, so the SAME lobby instance stays
mounted through the entire flourish (no remount → no reload); the in-game
shell mounts only when the flourish ENDS (on dismiss), fading in
(`animate-in fade-in`) as the GoGoGo cover fades out — the map paints fast
because the lobby's preview already warmed the basemap HTTP cache + boundary.
This intentionally supersedes v828's "mount the shell hidden during the
countdown" (which required the branch swap that caused the reload + ran a
second live GL context mid-flourish). `GoGoGoOverlay`'s backdrop now
PROGRESSIVELY dims + blurs across the countdown (`opacity` 0.12→0.34→0.58 at
3/2/1, blur 0.5→1.5→2.5 px, 650 ms CSS transitions between steps) then
deepens to 0.96 / blur-4 as the GO card explodes — the lobby slowly
dissolving behind the flourish rather than snapping. Move-powerup GO-GO-GO
is unaffected (it leaves `gameStartOverLobby` false → `flourishActive`
false → plays over the live map). The v820 self-healing gate is intact.

**v888 — hider POI overlay from the basemap pmtiles (+ drawer search) and
"film a bird" duration-capture curse.**
- **Hider in-zone points-of-interest overlay, Overpass-free.** The basemap
  pmtiles carry a `pois` source-layer we drop from the RENDERED style
  (`protomapsStyle.ts:286`) but the tile data is still there and queryable.
  `HiderPoiOverlay.tsx` reads it via `map.querySourceFeatures("protomaps",
  {sourceLayer:"pois"})` — ZERO network (for a starred city it's the offline
  tile pack). Once the hider COMMITS a zone, the useful POI field (food /
  shops / civic / culture / nature groups) is drawn AUTOMATICALLY, clipped
  to the committed zone's radius circle (`hidingZone` centre + radius,
  haversine + 50 m margin). Viewport-scoped (recomputes on map `idle`),
  deduped by kind+coords, group-coloured dots + name labels; purely
  informational (no hit layer, so it never blocks tapping a hiding zone).
  Mounted on `HiderBackgroundMap`. `src/lib/hiderPois.ts` is the catalog —
  the exact POI `kind` set the Protomaps basemap encodes
  (`@protomaps/basemaps` pois filter), grouped/coloured (food / shops /
  civic / culture / nature / transit). State: `hiderPoiShow` (master toggle,
  default on) + `hiderPoiHighlightKind` (the searched kind to emphasise),
  both persistent. The `transit` group is excluded from the always-on field
  (those are the Hiding-zones overlay) but stays highlightable.
- **Map-drawer POI section + HIGHLIGHT search** (`HiderMapDisplayControls`
  `HiderPoiSection`): a "Places in my zone" master on/off, plus a SEARCH
  field that HIGHLIGHTS one kind (e.g. supermarkets) — matching POIs pop
  (bigger dot + ring + always-labelled) while the rest of the field dims, so
  the hider sees where all the X in their zone are at a glance. Active
  highlight shows as a clearable chip; contributes +1 to the map-options
  active count only while a highlight is set. Shows a "commit a zone to see
  places in it" hint pre-commit.
- **"Film a bird" duration-capture curse** (Curse of the Bird Guide). The
  app can't ship 15 min of video, but the curse is about the DURATION (the
  seekers must film for at least as long), so `curseCostRequiresVideo()`
  (`castingCost.ts`, `/\bfilm\b/i`) drives an in-app STOPWATCH in
  `CastCurseDialog` (Start when the bird's in frame → Stop → captured time).
  In multiplayer the timer is required + the elapsed seconds ride
  `CursePayload.filmSeconds` (new optional field, mirrored in
  `SharedCursePayload`) → server/demo relay verbatim → seeker's
  `curseReceived` carries it into `receivedCurses` → `CurseInbox` shows
  "Film a bird for at least m:ss" in the banner + dialog. Solo/link keeps it
  self-attested (stopwatch offered, not gated). New helpers unit-tested
  (`tests/castingCost.test.ts`).

**v887 — Cast Curse dialog cleanup, photo-cost curses deliver a photo,
randomize is response-only.**
- **Cast Curse dialog is app-only + vertical buttons** (`CastCurseDialog`).
  The link-era Copy-link / Share-again buttons were removed (the `copyLink`
  fn dropped, the cancelled/failed retry-hint text updated) — a curse is sent
  through the app automatically (over the wire in multiplayer). The footer is
  now a vertical `flex flex-col gap-2`: a single **Cast curse** (`Send`) /
  **Discard fizzled curse** (`Trash2`) action on top, **Cancel** (was "Not
  now") below.
- **Photo-cost curses now DELIVER the hider's photo to the seekers.** Curse of
  the Zoologist ("A photo of an animal") and Curse of the Luxury Car ("A photo
  of a car") have a photo casting cost the app couldn't fulfil before. New
  `curseCostRequiresPhoto(castingCost)` (`castingCost.ts`, `/\bphoto\b/i`;
  "Film a bird" is a video, deliberately excluded) drives a capture UI in the
  casting-cost box (`Camera` button → shared `PhotoCensorDialog` crop/censor →
  `preparePhotoForSend` → R2 upload). In multiplayer the photo is REQUIRED
  before casting and its R2 URL rides `CursePayload.photoUrl` (new optional
  field, mirrored in `SharedCursePayload` for the `?c=` link — URL only, never
  an inline data URI) → server relays verbatim → seeker's `curseReceived`
  handler carries it into the `receivedCurses` entry → `CurseInbox` renders it
  in the notification banner + the dialog. Solo/link games keep it a
  self-attested action (capture offered but not gated — no room to send it
  to). Server + demo broker pass the payload through unchanged.
- **Randomize can't be played standalone from the hand** (`HiderHandFan` +
  `HiderHandPanel`). It's a RESPONSE card — it swaps the question you're
  answering for a random one — so the hand's `case "randomize"` no longer
  discards it for no effect; it toasts "Randomize is played in response to a
  question — open the question you want to answer and play it from there."

**v886 — draw-picker stepper + GPS-on-open uses lastKnownPosition + title
contrast.**
- **Draw picker is an index STEPPER, not a scroll carousel.** The v884
  scroll-snap carousel snapped unreliably ("doesn't lock on"). Replaced with a
  translated single-card track + prev/next arrows + dot indicators
  (`DrawPickerDialog`) so the view always locks onto exactly one card. Multi-
  keep draws auto-advance to the next un-kept card; the fly-to-hand still
  escapes the viewport overflow via `position: fixed`.
- **"PICK N CARDS" title is white** with a drop-shadow — it's a transparent
  dialog over the dimmed map, where the dark title was unreadable.
- **Hider answer GPS-on-open now snapshots `lastKnownPosition`** (the atom the
  MAIN map's "You" dot reads, which respects a GPS spoof) instead of a raw
  `navigator.geolocation.getCurrentPosition` — the raw call returned the real
  device GPS (bypassing a spoof / racing the spoof-patch install), so the
  answer dialog disagreed with the map ("map says NYC, dialog says Sweden").
  The snapshot also feeds `HiderMap` via `overridePos`, so the comparison map +
  nearest-reference distances use the SAME position that grades. Falls back to
  a fresh fix only when nothing is known yet; a manual override still wins.

**v885 — hider answer GPS-on-open + radar-preview framing.**
- **The hider's answer is graded against the GPS fix taken when the answer
  dialog OPENS** (`HiderView`), not a continuously-tracked position. On open it
  does a fresh `getCurrentPosition` and LOCKS that as the grading `hiderPos`
  (`posLockedRef`); `HiderMap`'s live watch only fills it as a fast fallback
  until the snapshot lands, then movement is ignored for grading — so the
  answer reflects where the hider was when they opened the question.
- **Radar answer-map framing fixed** (`HiderMap`). The dialog animates open, so
  the first `fitBounds` could run against a mid-transition canvas size and mis-
  frame the radius circle + hider pin. The fit now `map.resize()`s before
  framing and re-runs once the map first settles (`idledOnce` added to deps),
  with a bit more padding, so the radius circle and the hider position are both
  correctly framed.

**v884 — draw-picker carousel + veto-label fix + global debug gesture + card
tests.**
- **Draw-picker cards are a horizontal CAROUSEL** (`DrawPickerDialog`) instead
  of a grid. At poker (5:7) proportions two+ cards side-by-side on a phone
  became too small and clipped their descriptions; each card is now ~one-at-a-
  time width (`w-[78%] max-w-[15rem]`, scroll-snap) so ALL content fits. The
  fly-to-hand animation escapes the carousel's `overflow-x-auto` via
  `position: fixed` at the card's measured rect (`CardCell` `flyRect`).
- **Veto no longer mislabels as "further".** A vetoed measuring question has no
  `hiderCloser`, so `answeredDetail` (`cards/base.tsx`) read the absent field as
  a false verdict → "Hider is further". Now `answeredDetail` early-returns
  "Vetoed — no answer" / "Randomized" BEFORE the per-type switch (guards every
  consumer), and the hider's `HiderQuestionLog` skips the meaningless outcome
  map for a vetoed/randomized-away question. (The seeker side already honoured
  `vetoed`; this was purely the hider's log.)
- **Debug panel gesture is GLOBAL + no launcher.** The floating debug chip was
  REMOVED (`DebugPhaseControls` — users could tap it by accident). The panel
  now opens ONLY via `installDebugSecretTap` (`main.tsx`): a passive,
  capture-phase document listener that opens the panel on 5 quick taps in the
  top-CENTRE region of the screen — works on EVERY screen (not just where the
  wordmark shows) and never blocks any UI. The wordmark reverted to plain
  branding.
- **Hider-card unit tests** (`tests/hiderCards.test.ts`, 9): deck composition
  (55 time-bonus + 21 powerups + curses, all 7 powerup kinds), time-bonus tally
  incl. the passive Duplicate copying the max bonus, and curse asking-
  restrictions (Drained Brain / Urban Explorer / Spotty Memory / dismissed).

**v883 — lobby header redesign (contained map) + hidden debug gesture.**
- **Lobby header rebuilt** (`GameLobbyDialog`). The full-bleed map + dimming
  scrim + wizard-in-a-lobby (v863–v879) is REPLACED by: a **SHARE section on
  top** (room code + Share/Copy/QR in its own section), then a **CONTAINED map
  preview** (rounded/bordered like the play-area picker, `h-[200px]`,
  `framePadding=40`) with the **play-area name top-left**, the **size pill +
  transit icons along the bottom**, and a **corner Edit button** — and **NO
  dimming scrim** (labels sit in their own small solid chips). The **separate
  inline edit modes are BACK**: a size popover (opens upward), a transit-mode
  editor Dialog, and a focused play-area editor Dialog (the map's corner
  pencil) — the single "open the whole wizard" Edit button was dropped. **House
  Rules moved back into the lobby body** (out of the wizard). The wizard's
  v879 "Rules" tab was removed (`GameSetupDialog` back to Play area / Transit /
  Size).
- **Debug panel is now a hidden gesture** — the top-centre HIDE+SEEK wordmark
  must be tapped **5 times in quick succession** (`useDebugSecretTap`, 700 ms
  window) to open it; a single tap does nothing. Applied to both
  `SeekerTopBar` + `HiderTopBar`. The visible floating launchers also default
  to hidden now (`debugLauncherHidden` default flipped to `true`), so the panel
  isn't trivially discoverable during a demo.

**v882 — sea-level question gets a configure-map preview.** The `sea-level`
measuring subtype previously drew NO closer/further overlay (v840 left it null
— "elevation contour, not a distance buffer"). But we PREWARM the elevation DEM
(Terrarium z11 tiles, the laptop's `processElevation`), which is exactly what
the elimination reads, so the preview can use the same geometry. New
`resolveFamily` kind `sea-level` (`questionImpact.ts`): the measuring effect
calls `seaLevelRegion(turf.bbox(playArea), lng, lat)` — the SAME "closer to sea
level than the seeker" region the elimination buffers — and the existing
`real`/yes-no clip treats it like the other full-geometry families (it's in
`noPointSet` + the `measuring-geom`-style `loading` gate). So preview == cut,
Overpass-free for a warmed city. (Returns null at an elevation extreme, same as
before — nothing to cut.)

**v881 — landing "Install app" button only shows a real one-tap install.**
`InstallAppButton` (landing, `Welcome`) used to fall back on iOS Safari to a
manual "tap Share → Add to Home Screen" TOAST, which read as broken (it's
instructions, not an install). Now the button renders ONLY when a real
`beforeinstallprompt` is captured (Chrome/Edge/Android + desktop Chromium) —
the iOS-manual toast path was removed, so on browsers with no programmatic
install the button simply doesn't appear rather than offering a dead action.
(The Settings-panel `PWAInstallButton` keeps its passive iOS text hint — a
static instruction in a settings list, not a dead CTA — so it's untouched.)

**v880 — debug question-inject fix + compact committed-zone card + big
top-of-map grace prompt.**
- **Debug "inject question to hider inbox" now works in demo / multiplayer.**
  It wrote `hiderInbox` directly, but in MP the inbox is a bridge-managed
  MIRROR of the synced `questions` store (rebuilt on every snapshot), so the
  entry got wiped on the next `welcome`/`snapshot` AND was un-answerable (the
  broker/server had no matching questions key). `injectInboxQuestion`
  (`DebugPhaseControls`) now, when `multiplayerEnabled`, sends the SAME
  `{t:"addQ"}` a real seeker sends (real-convention `key` in `[0,1)`) →
  broker → `mergeIncomingQuestion` upserts BOTH stores, so it persists +
  round-trips; solo keeps the direct `hiderInbox.set`.
- **Committed-zone card compacted** (`HiderHome`): a small SQUARE
  `ZonePreviewMap` on the left + the zone name beside it; the lock-icon block
  and the large read-only map below were removed.
- **Grace-period prompt is a big TOP-of-map card** (`HiderGracePrompt`,
  mounted on `HiderBackgroundMap`; the small bottom-corner grace box was
  removed from `HiderMapTimer`). It shows the urgent countdown PLUS the single
  most relevant zone to commit — the one the hider is standing INSIDE
  (distance ≤ hiding radius) or, failing that, the CLOSEST candidate
  (`fetchAreaStations` nearest-first, distance-gated 25 m) — one-tap "Lock in"
  via the shared `confirmAndCommitZone`.

**v879 — leaderboard name fix + timer names + lobby header redesign + station-
length binary + sea/coast worker offload.** A demo-prep batch:
- **Leaderboard hider-name attribution fixed.** Past-round names shifted to the
  NEXT hider (Round 1 "Sabrina" showed the round-2 hider, etc.). Root cause:
  `startNewRound` (`roundActions.ts`) resolved the name from the LIVE roster,
  but the "New round" button rotates roles to the incoming hider BEFORE the
  append runs — so every stored row got the wrong name. Fix: snapshot the
  just-finished hider's name at ROUND-END into a new volatile atom
  `roundEndHiderName` (`gameSetup.ts`) — set in the `ended` handler
  (`multiplayer/store.ts`, all devices, roster still pre-rotation) and the
  offline mark-found path (`HiderTimer`), cleared per round in
  `resetSharedRoundState`. `startNewRound` + `EndOfRoundDialog` now PREFER the
  snapshot over the live roster.
- **Timer player names + hider "next to overtake".** Both timers show the hider
  NAME on each time. The seeker `HiderTimer` leaderboard rows carry the name
  (live row = current hider, past rows = stored `hiderName`). The hider
  `HiderMapTimer` now shows the NEXT time to overtake (the smallest past time
  still LONGER than the current hidden time, ranked one better) ABOVE the live
  clock — replacing the old unreachable "1st below" row — with the name.
- **`same-length-station` is now BINARY** (`same`/`different`), auto-computed
  like every other matching type — the 3-way `lengthComparison` path was
  removed (boundary, memo key, grading, `adjustPerMatching`, `ZoneSidebar`
  filter, `HiderView` `AutoGradedLengthAnswer` deleted, matching card toggle).
- **Sea/coast geometry offloaded to the Web Worker (freeze fix part 2).** New
  `seaFromCoast` op (`geometry/worker.ts` + `client.ts`) runs the heavy
  `seaFromCoastline` off the main thread; `measuring.ts` body-of-water/coastline
  routes through it with the sync main-thread fallback.
- **Lobby header redesign.** Reverted the frosted-glass map buttons to the
  normal secondary style; zoomed the header map out (`framePadding` prop on
  `PlayAreaPreviewMap`); the top scrim is now fully solid from the top through
  the room code then fades; removed the "Players" subheader; the single
  bottom-right map Edit button (sized to match the transit pills) opens the
  full game-settings wizard dialog (`setupDialogOpen`) — the separate "Edit
  area"/inline transit+area editors were removed; HOUSE RULES moved into the
  wizard as a new "Rules" tab (`GameSetupDialog`); the Leave button reverted to
  the default size with a bit more footer space.
- **Debug: +7 min screenshot buttons** for current + past hidden times (beside
  the existing +30).

Prewarm note (answering "what do I need to run for v864+"): the laptop
prewarmer's `processCity` already warms ALL families — refs, area-stations,
water, coast, admin, metro, tile-pack — for BOTH primaries and (`--adjacents`)
neighbours by default; NONE of the v864-v878 elimination-logic changes require
re-running `build-city-adjacents.mjs` (that only bakes the adjacency SET, not
elimination geometry). Coast/water/admin/metro remain deliberately OUT of the
star gate, so re-run with `--force` for a large city to refresh those families
after an Overpass soft-timeout.

**v878 — draw the actual train LINE on the same-train-line configure map.**
The matching "train line" question's configure preview showed only the pin's
nearest STATION dot; now it also draws the rail LINE that station sits on. New
`findTrainLineGeometry` (`overpass.ts`) reuses the EXACT 2-step
name/name:en/network query `trainLineNodeFinder` uses (so the drawn line matches
the grading) but keeps the LineString features instead of extracting node ids —
`trainLineNodeFinder` / the elimination path is untouched. `trainLineForPoint`
(`matching.ts`) mirrors `matchingStationBoundary`'s nearest-station lookup then
fetches the line; `InlineLocationPicker` fetches it off the elimination path for
`same-train-line` and draws it as a white-casing + purple-core line under the
pin. Returns [] on any failure (nothing drawn, never throws).

**v877 — body-of-water / coastline elimination ignored the big river/bay
(NYC East River) — root-caused + fixed.** Both the body-of-water and coastline
measuring questions (elimination AND the configure overlay, which share the
geometry) degraded to the coarse bundled 1:50m coastline in NYC, so the East
River / harbour was invisible and the buffer built off a tiny inland waterway
("English Kills"). Root cause: `fetchAreaCoastlineLines()`'s live fallback
(`coast.ts`) queried `natural=coastline` scoped to the **land-clipped,
inward-simplified play-area `poly:`** — but OSM coastline ways trace that exact
waterline, so the tidal-river/harbour coastline sits on/just outside the polygon
and the `poly:` filter EXCLUDES it → no coast → `seaFromCoastline` empty → coarse
bundle. **Primary fix:** the live fallback now queries `way["natural"="coastline"]`
over the play-area **BBOX** (2 km-padded, matching the `/api/coast/<id>` prewarm
builder), so the East River etc. is captured. **Secondary fix:** body-of-water's
last-resort band (`measuring.ts`) reuses the DETAILED per-city coast lines
(hoisted `cityCoastLines`) when `seaFromCoastline` fails, instead of dropping to
the coarse bundle — mirroring the coastline subtype. The nearest-water LABEL
(`fetchNearestWater` → `fetchNearestCoastline`) folds in the same coast, so label
+ elimination now agree (both were degrading together — NOT a display mismatch).
Same-landmass (which also reads `fetchAreaCoastlineLines`) gets the better NYC
split for free. (Deeper follow-up: add coast to the prewarm star gate so warm
coastal metros serve `/api/coast/<id>` from R2 and never hit the live path.)

**v876 — tentacles configure card: hide the redundant "Location Type"
dropdown.** The subtype is already chosen in the picker step + named in the
card header, so the dropdown is hidden for a normal tentacle question (matching
matching/measuring, v611). Kept in the tree (rendered only when
`data.locationType === "custom"`) so the "custom" tentacle-locations editing
path + its imports stay intact — no orphaned code.

**v875 — same-landmass geometry offloaded to the Web Worker (freeze fix, part
1).** The `same-landmass` question / configure preview froze the UI for seconds
in a dense coastal metro because `fetchAreaLandPolygons` (`coast.ts`) ran the
heavy `seaFromCoastline` (node/polygonize/right-of-way-label/union) + the
world-frame `turf.difference` SYNCHRONOUSLY on the main thread (the reported
NYC same-landmass freeze + the dialog tear-down + "loading animation freezes").
It now runs in the existing geometry Web Worker: new `landFromCoast` op
(`geometry/worker.ts` imports the turf-only `seaFromCoastline`; `geometry/client.ts`
exports `landFromCoast`), and `fetchAreaLandPolygons` tries the worker first,
keeping its IDENTICAL main-thread computation as the fallback (correctness never
depends on the worker existing). Same async contract — callers already `await`
it. NOTE: body-of-water's `seaFromCoastline` (measuring elimination) still runs
on the main thread — a follow-up `seaFromCoast` worker op will offload it too.

**v874 — hider nav matches seeker + player-colour seeker markers.**
- **Hider bottom nav** (`HiderBottomNav`) now matches the seeker's exactly: the
  bordered/filled tile buttons (`bg-secondary border`) became the seeker's FLAT
  muted buttons, and the hider's primary action (**Zone**) is the filled brand-
  red centre CTA (`flex-[1.4]`, uppercase label) mirroring the seeker's "New
  question". Hand fan below is untouched.
- **Seeker map markers** (`HiderBackgroundMap` live seeker pins) use each
  player's **identity colour + initials avatar** (`playerColor`/`playerInitials`,
  the lobby/leaderboard palette) instead of a red footprints circle, and the
  name pill is **collision-hidden** — a greedy shortest-first pass drops any
  label that would overlap another seeker's avatar or an already-placed label,
  recomputed on pan/zoom.

**v873 — Questions-drawer "New" no longer breaks the first question + subtype
header styling.**
- **First question from the Questions drawer read "not sent."** The drawer's
  "New" button hosted an `AddQuestionDialog` whose OWN vaul drawer was nested
  inside the Questions vaul drawer — a stacking/orphan bug. On MOBILE the New
  button (drawer header + empty state) now CLOSES the Questions drawer and bumps
  a shared `addQuestionSignal` (`context.ts`); the always-mounted BottomNav
  `AddQuestionDialog` (`respondToSignal`) opens in response — never nested.
  Desktop (sidebar isn't a drawer) keeps the direct `AddQuestionDialog` wrapper.
- **Subtype-picker drawer header aligned to the tile/overlay chrome** — the
  small grey icon + plain "Matching" label became the `QuestionOverlayCard`
  look: a bigger solid category-colour icon block + a big bold UPPERCASE label
  in the deepened category colour (`deepColor` now exported from
  `questionOverlayCard`).

**v872 — demo broker: can't mark found on round 2 (fixed).** The demo broker's
`found` handler only injects `ended` when `s.state.roundFoundAt === null`, but
its `rotateHider` (new-round) handler reassigned roles WITHOUT clearing the
per-round server state — so on round 2 `roundFoundAt` still held round 1's
timestamp, the `found` was ignored, no `ended` fired, and the timer ticked
forever (dialog closed, nothing happened). `rotateHider` now nulls
`roundFoundAt` + the endgame stamps, mirroring the real server
(`GameRoom.handleRotateHider`, which already did this — only the DEMO path was
affected, i.e. screenshot/demo mode; real 2-device games were fine).

**v871 — screenshot-prep polish (leaderboard colours + debug time buttons).**
- **HiderTimer seeking leaderboard colours** — the 1st-place rank badge was a
  muted gold `#D6A92B` while EVERY past-round time box was a vivid gold
  `#F2C63C`, so a 2nd-place time read as gold and 1st looked pale. Now the 1st
  badge is the vivid gold and the past-round time box is **placement-tinted**
  (gold 1st / silver 2nd / bronze 3rd / neutral), so only the leader reads gold.
- **Lobby leaderboard** (`GameLobbyDialog LeaderboardSection`) adopts the same
  show-style placement blocks (gold/silver/bronze/neutral) instead of the red
  "1" circle, matching the EndOfRoundDialog + HiderTimer leaderboards.
- **Debug "Hidden time (screenshots)" section** (`DebugPhaseControls`): two
  buttons that pad the hidden-time clock for marketing shots — **+30 min ·
  current round** (adds to `hiddenCreditMs`, folded into the live seeking timer)
  and **+30 min · past rounds** (bumps every `roundLog` entry's `hidingMs`).

**v870 — measuring gating + locale labels + tentacle candidate filter.**
- **Reference-in-area gating** (`subtypeAvailability.ts`) for two measuring
  types whose reference must be INSIDE the play area (rulebook p17) else they
  buffer the WHOLE area as "closer" (NYC reports): **high-speed rail** (nearest
  line 5000 km away in England) and **international border** (nearest ~500 km in
  Canada). New presence gates: HSR = the play-area-clipped Overpass
  `[highspeed=yes]` (same query the elimination uses → NYC returns none);
  international border = the bundled Natural Earth admin_0 lines tested against
  the play-area bbox (no network). Both follow the v842 coast-presence shape —
  `null` (unknown / fetch failed) stays AVAILABLE so a valid city is never
  wrongly hidden; keyed by play-area signature.
- **Admin-span gate fixed for the ZERO case** (from v868): `computeAdminSpan`
  returned `regions.length` when no region covered the interior, which kept a
  meaningless tile enabled. It now returns the true `seen.size`, so "City / Town
  (OSM 8)" (and any level with no in-area region) is correctly disabled.
- **Measuring admin-division border LOCALE labels** (E): "1st admin div.
  border" / "2nd admin div. border" now read as the play-area country's tier-1 /
  tier-2 division + " border" (US → "State border" / "County border") via
  `localizeAdminSubtype` (picker, `AddQuestionDialog`) + `adminBorderLabel`
  (card header, `questionOverlayCard`) — the same `adminDivisions.ts` mapping the
  matching admin tiles use. Internal ids unchanged.
- **Tentacle candidate filter** (`questionImpact.ts`): the configure map plotted
  the WHOLE play area's POI field for a tentacle question; now it only plots the
  references WITHIN the tentacle radius (the question is "of the ones in reach,
  which are you nearest to"), matching the drawn tentacle circle.

**v869 — photo + hider-answer flow fixes (NYC demo feedback).**
- **Photo censor dialog opened BEHIND its launcher (app-locking bug).**
  `PhotoCensorDialog` used the shadcn default `z-[1050]`, but it's always
  launched from INSIDE the hider answer dialog (`z-[1060]`) or the Questions
  drawer (vaul `z-[1055]`) — so after the OS file picker returned, the "Review,
  crop & censor" dialog mounted behind the launcher, invisible, while its
  DismissableLayer froze the app (same class as v797/v800). Its content +
  overlay are now `z-[1070]`.
- **Seeker photo card showed a stale manual "Attach photo / Mark answered".**
  In multiplayer the HIDER captures + sends the photo over the wire and the
  seeker RECEIVES it automatically (`photoUrl` on the answered question — the
  path was already fully wired). The manual-attach UI was a pre-multiplayer
  remnant that made the seeker card look broken. `cards/photo.tsx` now gates the
  attach/mark-answered controls on `showManualCapture = isHideTeam ||
  !inMultiplayer`, so a multiplayer SEEKER sees a read-only "waiting for the
  hider to send a photo" state; manual capture stays for the hide team and for
  solo/offline.
- **Hider answer reads like the radar answer (auto-compute + Send, not a
  toggle).** `AutoGradedBinaryAnswer` (matching Match/No-match + measuring
  Closer/Further) now shows the auto-computed verdict in the same "Your answer"
  box as radius/thermometer with the single Send CTA, and DEMOTES the
  Match/No-match toggle behind a small "Not right? Change your answer" link. The
  two-button toggle still appears up-front only when auto-compute produced NO
  verdict (honest fallback). (The 3-way `AutoGradedLengthAnswer` + tentacles
  answer get the same radar-style treatment in the next patch.)

**v868 — matching/measuring question-correctness batch 1 (NYC demo feedback).**
Five targeted fixes from a walkthrough of NYC question types:
- **Consulate (matching) — nearest reference drawn in the "not matching"
  region (impossible).** `questionImpact.ts` filtered the Voronoi SITE set
  against the elimination-masked remaining area (`$maskData`), while the
  nearest-reference LABEL (`nearestFromCache`) filters against the FULL play
  area — so a consulate in already-eliminated land was dropped from the
  overlay's sites and the labelled pin fell into a neighbour's cell. New
  `useFullPlayAreaPolygon()` filters the candidate SITES against the full area
  (the mask still CLIPS the drawn yes/no regions), so the labelled nearest is
  always a site and lands in its own "matching" cell.
- **Admin "City / Town (OSM 8)" in NYC — toast storm + "all mirrors timed
  out".** NYC has no `admin_level=8` boundary inside it (it's level 5, boroughs
  level 6), so the prewarmed L8 field contains no boundary CONTAINING an in-area
  point. `findAdminBoundary` (`overpass.ts`) treated warm-but-no-containing as a
  reason to fall through to LIVE Overpass (poly + `is_in`), hammering the
  mirrors. Now a WARM miss is AUTHORITATIVE "no zone" and returns undefined —
  only a COLD miss goes live. AND the v841 admin-span gate now returns the TRUE
  span (`seen.size`) instead of the `regions.length` fallback, so "City / Town
  (OSM 8)" is correctly DISABLED in NYC (span 0 — nothing to cut).
- **Same-landmass / heavy-question "empty preview on reopen".**
  `determineMatchingBoundary` (lodash `memoize`) pinned a silent-draft failure's
  resolved-`undefined`, so every reopen returned undefined → no overlay ever
  drew. The memo-key resolver was extracted (`matchingBoundaryMemoKey`) and
  `matchingDraftRegion` now EVICTS the entry when a silent draft resolves
  `undefined` (a transient/cold failure — `false` stays cached as a valid "point
  type, no region"), so a reopen recomputes once the geometry warms.
- **"High-speed rail" rename** — the on-card label "Shinkansen" →
  "High-speed rail" (`questionOverlayCard.tsx`); internal id
  `highspeed-measure-shinkansen` unchanged (save-game compat).
- **Low-poly radar mask** — `modifyMapData`'s zone-radius-buffer dilation used
  `turf.buffer` at its default `steps:8`, producing a coarse ~20-gon circle;
  now `steps:64` (the underlying `arcBuffer` circle was already smooth).
Remaining NYC-walkthrough items queued for the next passes (heavier / need
their own work): draw the actual train LINE (matching train-line); worker-offload
the sea/coast geometry so same-landmass / body-of-water don't FREEZE the app +
tear the dialog down (also fixes the "loading animation freezes" + "slow question
closes with 'couldn't send'"); measuring sea/coast elimination correctness
(body-of-water ignoring the big river/bay, coastline math, sea-level preview);
presence-gating for high-speed-rail + international-border (no in-area reference →
disable); and locale labels for the measuring 1st/2nd admin-division borders.

**v867 — lobby header fades into the THEME background + foreground text; wizard
play-area card cleanup + GPS dot.** Follow-up to the v866 navy header. **Lobby
header (`GameLobbyDialog`):** the readability scrim is now **theme-aware** — the
map fades into the drawer's own background `hsl(var(--sidebar-background))` (light
in light mode / dark in dark mode) instead of a hardcoded navy: a solid top band
(room code) clearing by 30%, open map through the middle (30–50%), then a solid
bottom band ramping from 50%→100% where the settings sit. Transparent stops use
the SAME colour at `/0` (not the `transparent` keyword) to avoid the fade-to-grey
premultiply artifact. Room code / icons dropped hardcoded `text-white` + dark
drop-shadows for the normal **foreground** colour; the header controls
(`GLASS_BTN`/`GLASS_PILL`, spinner, focus rings) moved from white-on-dark frosted
glass to subtle **foreground-tinted** chips (`bg-foreground/10` +
`border-foreground/20` + `text-foreground`), and the transit pills + size badge
were **enlarged** (`GLASS_PILL` h-8→h-10, transit icon w-4→w-5, `SizeBadge`
text-xs→text-sm). The **play-area NAME was removed** from the header (the map
identifies the area); the host's area-edit affordance survives as a labelled
"Edit area" button (its the sole trigger for the v838 area-editor dialog).
**Wizard selected play-area card (`PlayAreaStep`, shared by `SetupPage` + the
`GameSetupDialog` modal):** dropped the redundant trailing **checkmark** and the
**game-size badge** (MEDIUM/…) from the selected summary (size is chosen on the
SIZE step; the badge stays in the search-results rows where it aids picking). And
**`placeTypeLabel` no longer mislabels rural municipalities as "City"** — Photon
derives an admin relation's `type` from POPULATION (so a Swedish *kommun* comes
back "city"), but the NAME states the real tier, so a new `ADMIN_NAME_TIERS` table
maps a division word in the name (kommun/kommune/gemeinde/comune/…→Municipality,
county/län/fylke→County, province/region/district/…) to the correct English
label, overriding Photon's guess; names with no tier word keep the old
Photon-`type` fallback (so "Paris"/"Berlin" still read "City"). **GPS "you are
here" dot on the play-area preview map (`PlayAreaPreviewMap`):** it now renders
the shared `SelfPositionMarker` at `lastKnownPosition` (the wizard's GPS-suggest
flow now publishes its fix to that atom), so the player sees where they are
relative to the area they're picking — in the wizard preview, the lobby header,
and the summary card. No fix → no dot (correct degraded state).

**v866 — lobby header map: taller + dim to navy top & bottom.** The pre-game
`GameLobbyDialog` play-area header (v863) grew from `h-[200px]` to `h-[280px]`
(both the `PlayAreaPreviewMap` and its loading placeholder) so the play area
reads clearly between the two dimmed bands, and the readability scrim dimmed to
the **`bg-jetlag` navy `#1F2F3F`** (`rgba(31,47,63,…)`) instead of the old
near-black `rgba(15,22,32,…)` — a solid navy top band (room code) clearing by
50%, open map through the middle, then a 0.40 navy bottom band (settings).
Superseded next patch by v867's theme-aware fade.

**v865 — NYC trip planner "walking-only" fixed: stale MOTIS `METRO` enum poisoned
every request.** The reported "trip planner always falls back to a walking estimate
in NYC even though the subway departures board shows trains" was NOT a coverage gap
(Transitous/MOTIS covers NYC via the MTA GTFS in the Mobility Database) — it was a
stale mode enum. `MOTIS_MODE_MAP.subway` (`overpass-cache/src/travel/adapters/transitous.ts`)
was `["SUBWAY", "METRO"]`, but MOTIS **renamed `METRO` → `SUBURBAN` in 2.5.0** (the
version the public Transitous instance runs), so `METRO` is no longer a valid `Mode`.
A NYC no-bus game (`req.modes=["subway","train","tram","ferry"]`) therefore emitted
`transitModes=WALK,SUBWAY,METRO,RAIL,…` — an INVALID enum value in the KNOWN
`transitModes` parameter, which makes MOTIS reject the ENTIRE `/api/v1/plan` request
with a 400 → `planViaMotis` hit `if (!resp.ok) return null` → `dispatchPlan` fell
through to the unconditional walking backstop. (The departures board is a separate
endpoint, so it kept working — the misleading "transit clearly exists" signal.) The
comment at the `transitModes` set-site was the trap: "an unknown param is ignored by
older MOTIS" is true for an unknown PARAMETER but NOT for an invalid ENUM VALUE inside
a known one. Three fixes: (1) **`subway: ["SUBWAY"]`** — drop the stale `METRO`; `SUBWAY`
is the stable enum and suburban/S-Bahn rail (what MOTIS now calls `SUBURBAN`) is not the
subway anyway — it's covered by the `train` RAIL family. (2) **Defense-in-depth retry**
(`planViaMotis`): if the modes-constrained request returns non-OK (most likely a 400 from
a stale/invalid `transitModes` enum), retry ONCE WITHOUT `transitModes`. `parseMotisPlan`
already picks a mode-compliant transit-bearing itinerary out of MOTIS's full ranked list
(honouring `req.modes`, v766), so dropping the hint costs only ranking — and a future
stale enum can never again silently collapse the planner to a walking estimate. (3)
**`classifyMode` handles `SUBURBAN`** → train (parse-side; benign today since an unknown
mode already falls to the always-passing generic `"transit"`, but it labels current-MOTIS
suburban-rail legs correctly). Unit-tested (`tests/travelPlan.test.ts`: `motisTransitModes`
never emits `METRO`). Applies to BOTH the public Transitous instance and a self-hosted
MOTIS box (they share `planViaMotis`/`parseMotisPlan`). Worker change — auto-deploys with
the `overpass-cache` Workers Build. **Not live-verifiable from CI (egress blocks
api.transitous.org); confirm in production via `/api/travel/plan?debug=1` for a NYC
origin/destination** — the walking fall-through should be gone.

**v864 — matching configure map plots only the nearest reference + its Voronoi
border (not the whole POI field).** A matching question's answer is just "same"
(the pin's NEAREST reference — whose Voronoi cell IS the same-region) or
"different" (everything else), so plotting every park/POI on the configure map
(`InlineLocationPicker`) was noise. New `matchingBorderIndices(candidates, anchor)`
returns the nearest reference PLUS the references whose Voronoi cells BORDER it —
exactly the ones that draw the same/different boundary — and the `visibleCandidates`
memo uses it for `impactMode === "matching"` (falls through to the prior
remaining-area filter on any failure / no pin / <2 candidates). Display-only: the
elimination MATH in `useQuestionImpact` still uses the full candidate set.

**v863 — lobby header IS the play-area map (settings overlaid on a dimmed map).**
The pre-game `GameLobbyDialog` header is now the play-area `PlayAreaPreviewMap`
itself (`h-[200px]`, full-bleed — its inner rounded/border stripped via
`[&>div]:!rounded-none [&>div]:!border-0`), with the room code + Share riding on
top and the game settings (size pill + transit glass pills + Edit) seated on a
**bottom-weighted scrim** (`linear-gradient` ~34%→14%→72% dark, top→bottom) so
the map reads up top while the controls stay crisp on the dark band. Controls use
frosted `GLASS_BTN`/`GLASS_PILL` (white + `bg-white/15` + white hairline +
backdrop-blur); the size pill (`SizeBadge`) and Share button keep their solid
colours. Play-area Edit is a pencil beside the city name; transit Edit a glass
pencil at the row end (host only). Replaces BOTH the separate room-code header
(v857/v860 — the inverse-theme trick is gone, obsolete under the scrim) and the
scrollable GAME SETTINGS section (v857). Mid-game manual reopen shows a compact
room-code bar (no map). `resolvedTheme` import dropped.

**v862 — distinct player colours within a room (fixes two players sharing a
colour).** The v861 per-id hash could collide, so two players sometimes wore the
same colour. `assignPlayerColors(ids)` (`playerColor.ts`) now assigns over the
WHOLE room: each id prefers its hash colour but linear-probes to the next free
one on a clash, so colours stay tied to the player yet never collide (guaranteed
distinct while players ≤ pool size 8; `MAX_PARTICIPANTS=5`). Deterministic across
devices (ids processed sorted; the id set is identical everywhere). `GameLobbyDialog`
computes the map once over all `$participants` and passes it to both `RosterCard`s;
the bare `playerColor(id)` stays as the no-roster fallback (e.g. a lone map pin).

**v861 — per-player identity colours in the lobby roster (show-style).** Each
participant gets a stable colour + an initialed avatar on their roster row
(`GameLobbyDialog` `RosterCard`), inspired by the Jet Lag standings screen where
every competitor owns a colour. `src/lib/playerColor.ts` is the shared source:
`playerColor(id)` hashes the (server-assigned, room-shared) participant id into a
pool → the SAME colour on every device with no extra wire sync; `playerInitials`
builds the avatar text. The pool is the show palette but **deliberately excludes
the brand red** (`--primary` is reserved for buttons / seeker chrome, so a player
never wears it) and every colour passes white-text contrast. Deliberately shared
so the same colour can later mark a player on the **leaderboard rows + live
seeker map pins** — exactly where the show uses them (not wired there yet).

**v860 — lobby room-code header: inverse theme + tighter top padding.** The
`GameLobbyDialog` room-code header now renders in the INVERSE theme of the app —
a DARK header in light mode, a LIGHT header in dark mode — for contrast against
the body. Done with the CSS-variable indirection the theming caveat calls for:
the header div gets the OPPOSITE `.light`/`.dark` class (`resolvedTheme === "dark"
? "light" : "dark"`), which re-scopes the shadcn tokens for that subtree so the
sidebar bg/text AND every child token colour (muted label, outline buttons,
border) all flip together, plus an explicit
`bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]`. Top
padding dropped `pt-5` → `pt-1` (0.25rem).

**v859 — RolePicker hider copy.** The hider tile description changed to "Answer
questions and play cards to slow the seekers down." (was "…play the hider deck.
Team up — multiple players can hide together.").

**v858 — lobby section subheaders aligned to the Map-options style.** The lobby's
`Game settings` / `Players` / `House rules` subheaders were `text-sm font-display
font-extrabold tracking-[0.12em]`; they now use the SAME style as the
`MapOptionsPanel`'s `BASEMAP` / `OVERLAYS` / `TRANSIT OVERLAYS` labels —
`text-[11px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground`
(`GameLobbyDialog` + `HouseRulesSection`) so the two drawers read as one system.

**v857 — lobby restructured around the ROOM CODE.** The lobby is about the game
ROOM, so the **room code + Share/Copy/QR actions are now the fixed header**
(`GameLobbyDialog`, `shrink-0` with a `border-b`; the standalone city-name title
+ its `useFitFontSize` were removed — the map carries the city). The scroll body
is three labelled sections in order: **Game settings** (size + transit + the
play-area map — moved back OUT of the header into this scrollable section),
**Players** (roster), **House rules**. The body's old SHARE subheader + share
card were removed (share lives in the header now); `HouseRulesSection`'s header
was restyled to match the other section subheaders (`text-sm` display-extrabold,
no top border). Supersedes the v855/v856 header experiments.

**v856 — lobby: map pinned in the header + PLAYERS/SHARE sections + inline row
actions.** Follow-up to v855. (1) **The play-area map moved OUT of the scrollable
body INTO the fixed header** (`GameLobbyDialog`, alongside the title + size/transit
row, `shrink-0` with a `border-b` under it) — so the "game info" block never
scrolls; only the roster + share scroll beneath it. (2) **Two labelled sections
replace the single "Invite & players" subheader**: **PLAYERS** (subheader → the
Seekers/Hiders roster) then **SHARE** (subheader → the room-code/Share/Copy/QR
card, now BELOW the roster again). (3) **The roster row's switch-teams + rename
buttons sit right beside the player's name** — the name span dropped `flex-1`, so
the buttons no longer float to the far right of the card.

**v855 — lobby two-section restructure + host icon.** Pre-game lobby
(`GameLobbyDialog`) reorganised into two clear sections: (1) **game
info/settings** — the title, size/transit row, and the map preview now read as
one block (the header dropped its `border-b` divider + most of its bottom
padding, so the transit row flows straight into the map with no rule between
them); (2) **invite & players** — introduced by a new `Invite & players`
subheader below the map, under which the **share/room-code card moved to sit
JUST BELOW the map** (was at the bottom of the roster block) followed by the
Seekers/Hiders roster. The **top-right header Share button was removed** (the
share card carries Share/Copy/QR). The hider empty state dropped its "— the seat
is open" tail ("No hiders yet."). The roster **host badge icon changed from
`Crown` to `Shield`** — the crown reads as a leaderboard/high-score marker, so
the host now gets a distinct owner glyph.

**v854 — hiding-zone label default max chars 12 → 15.** Roomier default before a
station label truncates (`stationLabelMaxChars`, `debugState.ts`); the debug
slider still tunes it live, and anyone who already set it keeps their value.

**v853 — server-authoritative "with the hider" range-check on Mark Found
(Track 2 of the v852 proximity guards).** The tighter within-distance check
v852 deferred (the seeker's device never holds the hider's coordinate — it's the
game's secret). Done server-side so the secret never leaks: (1) **The hider
pushes its live GPS to the SERVER ONLY** — new `hiderLoc` message
(`protocol/messages.ts` `CMsgHiderLoc`, `worker/GameRoom.ts handleHiderLocation`
stores it in `lastPos`, **never fanned to anyone**, unlike the seeker `loc`).
Owned by the new `useHiderLocationBroadcast` hook (mirrors
`useSeekerLocationBroadcast` — watchPosition + 30 s heartbeat, gated on role
hider + multiplayer + a live game; no user toggle since it's server-only +
ephemeral). (2) **`found` gains an optional `force` + a soft proximity check.**
The server also stores every seeker's `loc` in `lastPos`; on a `found` claim
(`handleMarkFound`), `markFoundIsTooFar` computes the distance from the marking
seeker's last GPS to the NEAREST hider's last GPS and, if it exceeds
**`FOUND_PROXIMITY_METERS` = 50 m** (both positions fresh within
`FOUND_POS_STALE_MS` = 3 min), replies `SMsgFoundFar` to that seeker ONLY
instead of broadcasting `ended`. Missing/stale data on either side → allow
(can't verify; friends game). (3) **Seeker side** (`HiderTimer.handleMarkFound`)
no longer ends optimistically in multiplayer — it sends the claim and waits for
the server's `ended` (→ the normal `ended` handler ends on this device too) or
`foundFar`; on `foundFar` (`multiplayer/store.ts`) it shows a **soft "Are you
with the hider? … GPS says you're pretty far …" `appConfirm`** (NO distance
leaked — the hider's position stays secret) and, on confirm, re-sends
`found` with `force:true`. Offline/solo still ends locally. `lastPos` clears on
round reset; demo broker no-ops `hiderLoc` (single-hider demo has no seeker to
range-check). **`FOUND_PROXIMITY_METERS` is the one knob** to loosen if urban
GPS proves too tight in play.

**v852 — endgame/found proximity guards (Track 1: the seeker-local, no-wire
half).** Two rulebook-p43 anti-cheat/anti-mistake checks around the endgame. (1)
**Start-endgame-in-zone geometric gate** (`StationTransitCard.handleStartEndgame`):
the endgame begins only once the seekers physically REACH the hider's zone, so
declaring it now checks the seeker's live GPS (`lastKnownPosition`) against the
TAPPED zone's hiding-radius circle (`hidingRadius`/`hidingRadiusUnits` → metres +
`haversineMeters`). GPS is noisy in the dense cores this game is played in, so a
generous **100 m margin** keeps a genuine in-zone declaration from being falsely
blocked; only a CLEARLY-outside position (>radius+100 m) gets a warning confirm
("Your GPS puts you about N m outside … Start anyway?", destructive, still
overridable — the hider can refute a wrong claim regardless). No GPS → no block
(can't verify). (2) **Mark-found confirmation** (`HiderTimer.handleMarkFound`):
ending the round was a single instant tap; it now `appConfirm`s first
("…physically reached the hider … This freezes the score and ends the round.").
"Mark hider found" already only appears AFTER the endgame is declared, so found
inherits the zone-level proximity guarantee from check (1). **A tighter
"within-50 m-of-the-hider" enforcement on found is deliberately NOT here** — the
seeker's device never holds the hider's coordinate (it's the game's secret;
`hideZone`/`hidingSpot` fan to other hiders only, seekers get `loc` from seekers
only), so a real distance check needs a wire-level flow (hider-side validation or
server-authoritative). **Shipped in v853** (server-authoritative, 50 m soft
warning); the mark-found self-confirm here stays as the always-present first
gate.

**v851 — bonus tally synced over the wire + individual floating bonus chips.**
Follow-up to v850's `EndOfRoundDialog` in-hand bonus tally, which read the LOCAL
hider hand — correct on the hider's own device / solo, but a REMOTE seeker sees
an empty hand → 0 bonus AND can't compute the base hiding time either (Move
credit + late-answer debit are hider-local). (1) **The hider now PUBLISHES its
authoritative round result over the wire.** New `roundSummary` message
(`protocol/messages.ts` `CMsgRoundSummary`/`SMsgRoundSummary`, carrying
`{baseMs, bonusPieces:number[]}` — pieces are the individual bonus contributions
in MINUTES). On the `ended` broadcast the hider (`multiplayer/store.ts` `case
"ended"`) computes `baseMs` (Move credit − late debit) + `timeBonusPieces(hand,
size)`, sets the new volatile atoms `roundEndBaseMs`/`roundEndBonusPieces`
(`gameSetup.ts`), and sends `roundSummary`; the server (`GameRoom.handleRoundSummary`)
relays it to every OTHER client (hider-authored only, validated + clamped);
seekers adopt it via the new `case "roundSummary"`. `EndOfRoundDialog` +
`roundActions.startNewRound`'s leaderboard append both PREFER the synced values,
falling back to the local computation. `resetSharedRoundState` clears the atoms;
`demoBroker` accepts `roundSummary` as a store-only no-op. (2) **`hiderDeck.ts`
`timeBonusPieces(hand, size)`** — the per-card bonus list (one entry per
time-bonus card + one per held Duplicate = the max bonus); `tallyTimeBonusMinutes`
is now its sum. (3) **Individual floating chips** — during the tally, each bonus
PIECE pops in as its own chip above the clock (new `jlBonusChip` keyframe:
overshoot in, then float up + fade), staggered across the count-up. So one 10-min
+ two 15-min bonuses show three separate chips popping in sequence.

**v850 — show-inspired leaderboards + in-hand bonus-time tally (`EndOfRoundDialog`
+ `HiderTimer`).** Taking cues from the Jet Lag show's standings screen (solid
placement colours instead of metal textures; player NAMES instead of photos):
(1) **`EndOfRoundDialog` "Hider found!" bonus tally** — the round's hidden time
is split into a BASE clock + the hider's in-hand time-bonus cards
(`tallyTimeBonusMinutes`). The big readout starts at the base and, ~550 ms after
the reveal, the bonus **counts UP** onto it over 1.5 s (rAF ease-out, `tallyMs`
state), with a "+N min hand bonus" chip fading in — like the show's tally. No
bonus → no animation. The final total still drives the ranking. (2) **Leaderboard
rows restyled** — a solid **placement block (1st gold / 2nd silver / 3rd bronze /
neutral)** + the time + the hider's name, ranked longest-first (replaced the
Crown+number rows). (3) **`HiderTimer` seeking leaderboard** rank badges got the
same gold/silver/bronze placement colours (were all one gold).

**v849 — "Loading hiding zones…" pill stays up until the zones actually paint.**
The seeker overlay's `isLoading` flag clears once the candidate CIRCLES are
computed (compute effect), but the zones don't appear until a SEPARATE render
effect runs the heavy `styleZoneStationsAsync` union → `showGeoJSON` (the paint)
— so the pill vanished seconds before the zones showed. New toaster-only atom
`hidingZonesRendering` (`context.ts`) spans compute-start through paint: set true
alongside `isLoading` at compute start, cleared in the render effect's `finally`
after `showGeoJSON` (and on the selection / remove / failure paths). The toaster
reads `(isLoading || hidingZonesRendering) && displayHidingZones`. Deliberately
NOT used to gate any control (so a stuck-true value can't disable anything, the
`isLoading` v276 trap).

**v848 — seeking-timer leaderboard: live clock stays big + always visible + a
climb flourish.** Follow-up to v847: the LIVE current-round row is back to its
full prominent size (`text-3xl` + the wider red accent, was shrunk to
`text-2xl`), and it's ALWAYS rendered with its TRUE rank even when it ranks below
3rd — the board shows the top 3, then appends the current entry if it isn't
already among them (so the live clock never drops off the map). Past entries stay
the smaller gold pills. Added a **one-shot climb flourish**: whenever the live
row's rank decreases (it passes a past time), it plays a lift + scale pop with a
warm golden ring (`jlRankClimb` keyframe in `globals.css`); the rank is tracked
via a pre-early-return `useMemo`/`useRef` so drops and the initial mount don't
fire it.

**v847 — seeking-timer "time to beat" is now a ranked top-3 leaderboard.** The
seeker map's bottom-right timer used to show the live "Hidden for" clock ALWAYS
on top + a single gold "1st" best-past-time pill below it — so a longer past
time sat visually BELOW the shorter live time. `HiderTimer` now merges the LIVE
current-round time with the past-round times (`roundLog`), sorts longest-first,
and renders the **top 3** as ranked rows (`1st`/`2nd`/`3rd`): the live entry
(white box, red accent, "Hidden for") climbs as it grows and takes the 1st spot
the moment it passes the best past hide; past entries are the gold pills. Round 1
(no past times) still shows just the big live clock. Removed the now-unused
`timeToBeatMs` memo. `currentElapsedMs` is exposed from the display calc so the
live time can be ranked.

**v846 — `RotateHiderDialog` de-co-hidered + rocket icons removed.** Now that
every hider is equal (v829), the rotate dialog dropped ALL main-hider / co-hider
language: title "Start new round"→**"Rotate hider"** (bigger, `text-lg`→
`text-2xl font-bold`); the description + footer note no longer mention a "main
hider" or "co-hiders"; the per-row "Main hider — answers" / "Co-hider · make
main" (with its make-primary affordance) collapsed to a single **"Hiding this
round"**; the internal `primaryId`/`makePrimary` state was removed (the
`onConfirm(first, rest)` wire shape stays — all become equal `hider`). Also
removed the **rocket icon** from the RotateHider "Start round" button AND the
ThermometerConfigureDialog "Start and notify hider" button (the GoGoGo overlay's
rocket is the decorative celebration card, left as-is). Updated the last stray
user-facing "Seeker or Co-hider" line on `Welcome.tsx` to "multiple players can
hide together."

**v845 — end-of-round dialog copy/layout polish (`EndOfRoundDialog`).** Title is
now **"Hider found!"** (or **"Hiders found!"** when the hide team has >1 member,
counted from `participants` with role `hider`; solo defaults to 1) for BOTH
roles, replacing the role-split "You found them!" / "You were found!". Removed
the explanatory paragraph under the timer. The two eyebrow headers ("Round N ·
Complete", "{name} stayed hidden for") + the Leaderboard header bumped
`text-[10px]`→`text-sm`. The big hidden-time readout is now the standard
`text-foreground` (was `--accent-yellow`). Buttons: "Settings"→"Edit settings",
"Leave"→"Leave game". The leaderboard recap was already included when >1 round
exists — unchanged.

**v844 — selected-zone `StationTransitCard` moved to the TOP of the map.** It
was a bottom-anchored floating card (`fixed bottom-3`); now it's `fixed
top-[calc(env(safe-area-inset-top)+4.25rem)]` (clears the app top bar's
safe-area + content height, aligning with the pending-answer overlay), with a
`slide-in-from-top` entrance. Follow-ons: the touch gesture flipped for the top
anchor (swipe DOWN → expand into route/departures, swipe UP → dismiss), and the
trip-route map fit (`HiderBackgroundMap`) now pads the TOP by the card's live
measured height (was bottom) so the GPS dot + tapped zone stay in the visible
strip BELOW the card. Dismiss X + tap-another-zone-to-switch unchanged.

**v843 — wizard play-area step stops jumping while GPS locates.** The
full-page wizard's PLAY AREA step (`PlayAreaStep fillHeight`, `GameSetupDialog`)
had a two-stage layout jump: while GPS was still resolving a suggested area
(`hideSearchWhileLocating`, `value === null`) it rendered a FIXED `aspect-square`
map skeleton with NO card; once the area resolved it fell through to a totally
different shape — the play-area card on top + a `flex-1` full-height map — so the
card popping in shoved the map down and resized it (the reported "first only the
map loads, then the card appears and the layout changes"). The locating
placeholder now MIRRORS the resolved `fillHeight` layout: a card-shaped skeleton
up top (reserves the real card's height) + a `flex-1 min-h-[12rem]` map skeleton
that fills, so the real card/map replace the skeletons in place with no reflow.
Scoped to `fillHeight` (the wizard); the modal edit keeps its near-square
placeholder. Also added `min-h-0` to the lobby drawer's scroll body (the standard
flex-column scroll fix, so the `flex-1` region sizes correctly against the footer).

**v842 — more "can't cut the area" gating + hider transit labels + copy trims.**
(1) **Coastline / same-landmass availability gating** (`subtypeAvailability.ts`):
both are disabled when the play area has NO coastline (measuring "distance to
coast" is meaningless inland; the matching landmass split is built from the SEA,
so an inland area is one landmass → "same" always true). One signal —
`fetchAreaCoastlineLines()` (the same per-city coast the elimination uses), keyed
by play-area signature; a null/failed fetch stays AVAILABLE so a coastal city is
never wrongly hidden (a coastal-but-single-landmass area like LA also stays
available — we only disable the unambiguous inland case). Disabled tiles show a
clear reason. High-speed / body-of-water gating still deferred (needs their own
reference-presence checks). (2) **Hider transit-overlay buttons show their
labels again** — the hider's map-options panel had its OWN `TransitIconToggle`
copy that only rendered the icon (the v808/v809 label work updated only the
SEEKER's copy); it's now the same labelled pill in a 2-col grid, matching the
seeker. (3) **House-rules copy simplified** (`HouseRulesSection`): dropped
"Defaults follow the rulebook." from the intro and the per-rule "Currently: …"
lines (the `rulebookDefault` field removed); "Ask once per question" → "Each
question can only be asked once per game."; "Buffer eliminations by zone radius"
→ "Add a little extra margin when eliminating areas of the map. This will ensure
a hiding zone is never falsely eliminated." (4) Removed the lobby "Pick your
hiding spot in the meantime." hint.

**v841 — disable admin "Same X" questions that can't narrow the play area.**
`useSubtypeAvailability` (`subtypeAvailability.ts`) already greyed out POI
subtypes with too few in-area instances; it now ALSO gates the matching
**admin-division** tiles (`admin-1..4`) on how many DISTINCT admin regions the
play area actually SPANS at that level. A "Same state" question in NYC narrows
nothing (all of NYC is inside New York State) → disabled; "Same county" (5
boroughs) splits the area → kept. Span is measured by sampling interior points
of the play polygon and counting how many distinct admin regions contain them,
reading ONLY the PREWARMED admin geometry (`fetchPrewarmedAreaAdmin`, no live
Overpass) — a cold/unknown span always stays AVAILABLE, so we never wrongly
hide a question (it only disables once the admin data is warm). The cache is
keyed by `${playArea}:${level}` so switching cities can't serve a stale span.
The disabled tile shows a clear reason ("The whole play area is in one state —
this can't narrow the map."). NOTE: the same "can't cut the area" principle
applies to other types (same-landmass with one landmass; measuring coastline /
high-speed / body-of-water with no nearby reference — e.g. the Shinkansen
question in NYC, nearest line 5000+ km away, buffers the whole area as
"closer") — those need their own reference-span checks and are a follow-up.
Also: the matching **zone / train-line / street** IMPACT overlays (v840) draw
nothing when their underlying live Overpass fetch is rate-limited in an
un-warmed city (bundled-data types like international-border are unaffected);
they paint once the city's admin/stations are warmed or Overpass recovers.

**v840 — configure-dialog impact overlay now auto-computes EVERY spatially-
deterministic question type (audit).** The configure-question map preview
(`InlineLocationPicker` ← `useQuestionImpact`, `questionImpact.ts`) drew the
closer/further (measuring) or same/different (matching) region only for the
POINT-set subtypes (POIs, airport, city, rail-station, water). Every AREA/line
type resolved to `null` in `resolveFamily` and drew NOTHING. Now they all
delegate to the SAME elimination geometry the answer uses, so preview == cut:
- **Measuring line/contour types** — `coastline`, `international-border`,
  `admin1-border`, `admin2-border`, `highspeed-measure-shinkansen` — route
  through `measuringDraftBuffer(type, lat, lng)` (→ `determineMeasuringBoundary`
  → `arcBufferToPoint`), exactly like `body-of-water` already did. New
  `resolveFamily` kind `measuring-geom`; a new effect fills yes/no from the
  full-geometry buffer (no point candidates, no half-plane). `sea-level` stays
  null (it's an elevation contour, not a distance buffer).
- **Matching area/line types** — `zone`/`letter-zone` (admin division),
  `same-landmass`, `same-length-station`, `same-train-line`,
  `same-street-or-path` — route through a new
  `matchingDraftRegion(question)` (`matching.ts`) → `determineMatchingBoundary`
  run in a new **`silent`** mode (suppresses the "No boundary found" /
  "Couldn't determine your landmass" / "No named street" toasts+throws and
  returns `undefined` so a cold/failed lookup draws nothing instead of spamming
  toasts while the seeker positions the pin; `silent` is in the memo key so the
  REAL elimination call keeps its error feedback). New `resolveFamily` kind
  `matching-region` + effect; the "same" region is the boundary polygon,
  `no` = play area minus it. The **admin `zone` overlay needs the admin level**,
  threaded as a new `impactAdminLevel` prop `cards/matching.tsx` → `LatLngPicker`
  → `InlineLocationPicker` → `useQuestionImpact`. Guarded: `InlineLocationPicker`
  passes an empty subtype to the hook unless the overlay is actually active
  (`impactMode` set = configure dialog), so a locked/display card never triggers
  the new Overpass-touching compute. **Remaining gap:** the `metro` tentacle
  subtype still draws no reach overlay (needs the representative-point metro
  fetch) — noted for a follow-up. The `radius` category already overlays its
  circle; `thermometer` uses its own dialog; `photo` narrows nothing (no
  overlay by design).

**v839 — one icon per question everywhere + compact configure header +
ward/borough admin prewarm + lobby footer spacing.** (1) **Every question
subtype now has EXACTLY ONE icon, shown on both the header card and the map
markers.** There used to be two disagreeing icon tables: `subtypes.ts`'s
`SUBTYPES` (drives the on-map candidate markers via `InlineLocationPicker`)
said zoo→`TentTree` / amusement-park→`Rocket`, while
`questionOverlayCard.tsx`'s private `SUBTYPE_ICONS` (drives the header card)
said zoo→`PawPrint` / amusement-park→`FerrisWheel` / library→`BookOpen`
(colliding with consulate) / same-length→`Ruler` / coastline→`Waves` — so a
"MATCHING · ZOO" card showed a paw print in the header but a tent-tree on the
map. Fixed by making **`subtypes.ts` the single source**: new
`iconForSubtype(value)` resolves exact `SUBTYPES` value → `-full`-stripped →
a small legacy table (city/mcdonalds/seven11/bare-peak/bare-rail-measure), and
BOTH `QuestionOverlayCard` (its `SUBTYPE_ICONS`/`getSubtypeIcon` deleted) and
`InlineLocationPicker` now call it. Picked the clearer icon per subtype and set
it in `SUBTYPES` so the picker tiles get it too: **zoo→`PawPrint`**,
**amusement-park→`FerrisWheel`** (were `TentTree`/`Rocket`). (2) **Configure-
dialog header compacted** (`cards/base.tsx`, `forceExpanded`): the
"CATEGORY · SUBTYPE" big label truncated in the narrow dialog
("MEASURING · SEA LE…") — the category is now lifted into the small eyebrow
slot and only the subtype ("SEA LEVEL") is the big label. Scoped to the
configure dialog; the on-map overlays + collapsed list cards keep the full
combined label (their eyebrow is the status/time line). (3) **Ward/Borough
(OSM 9) admin question fixed** — the matching admin-division question's 4th
tier maps to OSM `admin_level=9` (US "Ward / Borough", JP ward, FR borough),
but the v831 admin prewarm default `ADMIN_PREWARM_LEVELS` was `4,6,7,8`, so
level 9 cold-missed the prewarm endpoint and fell to LIVE Overpass →
"No boundary found" + "all mirrors timed out/rate-limited" even in a warm
city. Default extended to **`4,6,7,8,9,10`** (worker `adminPrewarmLevels` +
laptop `ADMIN_LEVELS`, kept in lockstep) so the ward/borough + neighbourhood
levels prewarm too. Requires a laptop `--admin` re-warm to populate existing
starred cities; the live poly fallback is area-keyed (v826) so it also
self-heals after one successful fetch once Overpass isn't rate-limited. (4)
**Lobby "Leave game" footer spacing reduced** (`GameLobbyDialog`) — the footer
dropped `pt-3 pb-6`→`pt-2 pb-3`, the always-rendered transparent hint line is
now conditional (hider+ready only), and the Leave button shrank to `size="sm"
h-8 text-xs`, reclaiming the wasted vertical space.

**v838 — dedicated "Edit play area" dialog in the lobby.** The lobby's play-area
Edit button used to close the lobby and open the whole tabbed Game-Settings
wizard (PLAY AREA / TRANSIT / SIZE) — inconsistent with the compact inline
transit + size editors right next to it. Now it opens a focused **"Edit play
area" `Dialog`** (host only, pre-game) embedding the reusable `PlayAreaStep`
(search + map picker + adjacent-area folding) with Cancel / Save, layered over
the lobby at `z-[1060]` like the transit editor. The live-commit side effects
(set `playArea` + `mapGeoLocation`, pre-build the boundary polygon, WIPE
questions + zone/overlay caches, fly the map, toast) were extracted from
`GameSetupDialog.handleSaveEdits` into a shared **`src/lib/playAreaCommit.ts`
`commitPlayAreaChange(feature)`** used by BOTH the wizard and the lobby dialog;
the lobby's Save only commits (+ `hostPushSetup`) when the osm_id actually
changed. `additionalMapGeoLocations` is deliberately NOT cleared here (the same
as the wizard — `PlayAreaExtensions` manages it).

**v837 — display-name-doesn't-register fix + adaptive lobby header + Host
icon.** (1) **BUG: a typed display name sometimes didn't register** (esp. the
first game / fresh install). `RolePicker.commitName` only wrote the LOCAL
`displayName` atom — but the lobby AUTO-HOSTS the room BEFORE the picker appears,
so the server already assigned a cast name from the then-empty atom. Without a
`setName` push, the typed name stayed local-only and teammates kept seeing the
cast name. Fixed: `commitName` now calls `setOnlineName(draftName)` (v834's live
rename), which sets the atom AND sends `setName`; the transport queues + flushes
it on connect, so it lands even if the socket isn't open yet. (2) **Adaptive
lobby header** — a long place name now shrinks to fit instead of truncating.
`src/hooks/useFitFontSize.ts` (ResizeObserver-driven, shrinks font from 30px to
an 18px floor until `scrollWidth` fits; ellipsis only at the floor) drives the
`GameLobbyDialog` city title. (3) **Host tag → icon** — the roster "Host" text
badge is now an amber `Crown` icon (title/aria "Host").

**v836 — station card looks like a floating map-overlay card.** Follow-up to
v834 (which made `StationTransitCard` a plain positioned div to fix the frozen
map): it still *read* as a full-bleed bottom drawer (edge-to-edge, top-only
rounding, a drag handle). Restyled to match the other on-map overlay cards
(`PendingAnswerOverlay` etc.): **centred, inset off every edge**
(`bottom-3 left-1/2 -translate-x-1/2 w-[min(94vw,460px)]`), **fully rounded**
(`rounded-2xl`) + `shadow-2xl`, `overflow-hidden`. The drawer drag-handle bar was
removed; dismissal is a small **top-right X** (consistent with the other overlay
cards) plus the existing downward-swipe on touch. Still a plain div (no vaul), so
the map + app header stay fully interactive behind it.

**v835 — hiding-zone label shortening (calmer overlay).** A dense metro's
overlay was a wall of long station names. `src/lib/stationLabel.ts` (unit-tested)
adds two display-only steps: `abbreviateStationName` collapses the common
street-type SUFFIXES (Street → St, Avenue → Ave, Boulevard → Blvd, Square → Sq,
Station → Stn, Parkway → Pkwy, …) by whole-word replace, and
`shortenStationLabel(name, maxChars)` then truncates with an ellipsis (trimming a
trailing space/hyphen first). The max is a **debug-adjustable** persistent atom
`stationLabelMaxChars` (`debugState.ts`, **default 15** (was 12, v854); 0 = abbreviate only) with
a slider in `DebugPhaseControls` so it can be tuned live. Applied at map-render
time: both the seeker (`Map.tsx` `hidingZonesDisplay`) and hider
(`HiderBackgroundMap` `reachDisplay`) memoize a copy of their hiding-zone FC with
a `shortName` per point (keyed on the FC + max-chars), and the label layers read
`["coalesce", ["get","shortName"], ["get","name"]]`. The full `name` is untouched,
so taps / zone selection still use the real name — only the on-map label is
shortened.

**v834 — station card is a plain map overlay (fixes the frozen map) + lobby
polish.** (1) **`StationTransitCard` is no longer a vaul drawer — it's a plain
fixed bottom map overlay.** A vaul drawer (even `modal={false}`) puts
`body{pointer-events:none}` up via its Radix dismissable layer, which froze the
WHOLE map AND the app header while the card was open (the reported "can't zoom/
pan/tap anything, can't even hit Settings"). As a bare positioned `<div>` there's
zero body manipulation, so the map stays fully interactive — pan / zoom / tap
another zone to switch. Dismiss by swiping the card down or tapping the top
handle (the X was removed). Also: the station icon is now the **transit-mode
glyph** (`modeIconFor` — train/subway/tram/ferry/bus priority, MapPin fallback)
instead of the generic teardrop; the mode-pills row + the "Your route from where
you are now" description were dropped; the title is calmer (`font-bold`, no
uppercase/tracking-tight). The earlier v833 "reachability banner IS the expander"
merge was reverted per feedback — separate banner + "Route & departures"
expander again. (2) **GPS-sharing moved off the lobby onto the map** — a small
status chip above the follow-me control (`MapNavControls` `gpsSharing`/
`onToggleGpsShare`, seeker-only via `Map.tsx`; green while sharing, muted when
paused). The `MidGameInfoSection` in the lobby is gone. (3) **Lobby polish**
(`GameLobbyDialog`): city header `font-bold` (was `font-black tracking-tight`);
the transit **Edit** button drops its label to icon-only when all modes are on
(fits one row); the transit-mode editor got a **Save** button; the size dropdown
shows just the coloured pills (no redundant text label); the **roster is a single
column** (was 2-up), with **no role icons** and a bigger section header; the
"(you)" row gained inline **switch-teams** + **change-name** buttons. (4)
**Live rename** — new `CMsgSetName`/`handleSetName` (server de-dupes +
re-broadcasts presence) + client `setOnlineName` + demo-broker handling, so the
change-name dialog syncs to the room. (5) **Map-options selected style matches
the wizard** — tinted `bg-primary/10` + `border-primary` + `text-primary`
(basemap is now two wizard-style tiles; hiding-zones + transit toggles too), not
a solid `bg-primary` fill — on both the seeker (`MapDisplayControls`) and hider
(`HiderMapDisplayControls`) panels. House-rules visibility was already correct
(guests see only active rules, and nothing when none are active; only the host
sees the editor).

**v833 — map-options declutter + the "walking-only in NYC" root cause.** A
batch of demo-feedback fixes. (1) **The trip planner no longer falls to a
walking-only estimate when transit exists** (the reported "72nd Street shows an
80-min walk even though the departures board lists the Q"). Root cause:
`planViaMotis` (`transitous.ts`) never told MOTIS which modes the game allows,
so MOTIS ranked a bus-inclusive itinerary first; since NYC medium/large games
DON'T allow bus (`inferTransitModes`), `dispatchPlan`'s mode filter
(`journeyModesAllowed`, `router.ts`) rejected EVERY returned itinerary and fell
through to the walking backstop — even though a subway itinerary existed.
`planViaMotis` now passes `transitModes` (new `motisTransitModes` maps our
allow-set → MOTIS vehicle enums + WALK, unit-tested) so MOTIS surfaces a
compliant subway/rail itinerary directly; an older MOTIS instance ignores the
unknown param (no regression). (2) **`?debug=1` on `/api/travel/plan` now
explains a walking fall-through** — each adapter row gained `legModes`,
`modesAllowed`, `wouldDispatch`, and the response echoes the client `modes`, so
a "returned a journey but the plan is still walking" case is visible (the old
diagnostic reported the raw adapter result BEFORE the mode-rejection filter, so
it looked like transitous succeeded). (3) **Map options trimmed**: the
**Travel-times** overlay + its toggle were removed (the red/green reachability
dots didn't pull their weight; `TravelTimesOverlay` unmounted from `SeekerPage`,
the toggle + its imports dropped from `MapDisplayControls`), and the
**Save-image** export button was removed. (4) **Transit-overlay toggles are a
2-column grid** (`grid grid-cols-2`) so four modes read as a tidy 2+2 instead of
3+1 (`MapDisplayControls`). (5) **Hider hiding-zone dots are light-grey** on
dark/satellite (`hider-reach-dots`, `HiderBackgroundMap`) — byte-for-byte the
seeker's `hiding-zones-points`; they used to be brand red, which read as a loud
field. (6) **Questions drawer shows a hiding-period notice** (`QuestionSidebar`)
— a warning banner + a "Waiting on the hider / Questions unlock when the hiding
period ends" empty state, so a seeker isn't left wondering why they can't ask.
(7) **`StationTransitCard`: the reachability banner IS the expander** — the
"Reachable in time / Out of reach" verdict is now the tap target that opens
Route & departures (with a chevron + "Route & departures" hint), since the
verdict naturally invites "here's how to get there"; the standalone expander row
remains only when there's no reachability banner (no hiding clock). (The map
already stays interactive behind the non-modal card and re-selects zones on any
tap — v665/v666; a stale PWA cache can mask it, cleared by a reload.)

**v832 — the hide team SHARES one hand/deck (Track 2 of the hider-role rework).**
Completes v829: the whole hide team now draws / keeps / discards / plays from
ONE shared card economy instead of each hider holding an independent local hand.
The seven deck atoms (`hiderHand`/`hiderDeck`/`hiderDiscard`, `hiderHandLimit`,
`chaliceDrawsRemaining`, `pendingDraw`, `pendingDrawQueue`, `hiderRole.ts`) are
synced as ONE out-of-band secret blob — the SAME model as the hiding zone (NOT
in `GameState`, so seekers never see the hand). `DeckStateShare`
(`protocol/state.ts`, opaque `unknown[]` cards, relayed like `questions`) rides
new `CMsgSetDeck`/`SMsgDeck` messages. The economy FUNCTIONS are untouched — the
sync is transparent: `installMultiplayerBridge` subscribes to all seven atoms
and, after any local mutation, microtask-batches ONE `setDeck` push
(`readSharedDeckState`); the server (`GameRoom.handleSetDeck`) fans it to every
OTHER hider (never seekers, not the sender) and delivers the current deck to a
hider on join/resume/role-claim; inbound `deck` is adopted via
`applySharedDeckState` under an `applyingRemoteDeck` echo guard (the same
guard-and-fan-excluding-sender shape as `hidingZone`, so no ping-pong loop). The
server holds `deckState` outside `GameState` and nulls it on `rotateHider` (new
round → the team reshuffles locally via `resetHiderRoundState` and re-pushes as
they draw). Because the initiator's local deck IS the shared deck (kept in
sync), draws stay deterministic (no server-side card dealing) and concurrent
edits degrade to last-write-wins, exactly like `questions`. Solo/offline is
unchanged (the push is gated on `multiplayerEnabled`); demo broker accepts
`setDeck` as a store-only no-op (single hider). Round-trip contract unit-tested
(`tests/deckSync.test.ts`). **Known multi-hider edges (acceptable for a friends
game, documented in MULTIPLAYER.md):** a `pendingDraw` pops the blocking picker
on EVERY hider's device (collaborative resolve — any one commits, the rest
close), and two devices' `HandLimitEnforcer` firing in the same tick can discard
two different cards (last-write-wins keeps the hand at the limit, never corrupt).

**v831 — admin-boundary prewarm (the matching admin-division question goes
Overpass-free, closing the "1st admin border" error).** v826 made the matching
zone / letter-zone / admin-division fetch (`findAdminBoundary`, `overpass.ts`)
AREA-keyed (all `admin_level=N` boundaries in the play area via a cacheable poly
query, containing one found client-side), but a warm city STILL ran it live
ONCE per game per level — the reported Overpass error on the admin question even
in a prewarmed NYC. Now it's prewarmed by the SAME relation-id pattern as
`/api/water` etc.: **`GET /api/admin/<relationId>/<level>`**
(`handleAdminByRelation`, `overpass-cache/src/index.ts`) derives the canonical
boundary extent, rebuilds the one per-level bbox query (`buildAdminBboxQuery`,
`relation["boundary"="administrative"]["admin_level"="N"]`, 2 km pad,
`[timeout:180]`, `out geom`) and serves the R2 entry. Warmed per-city by the
cron (**Phase 2e**, `prewarmAdminForCity`, opt-out `ADMIN_PREWARM_ENABLED="false"`)
and the laptop (`adminQuery`, byte-identical builder, `--skip-admin`), across a
BOUNDED, configurable level set — **default 4/6/7/8** (`ADMIN_PREWARM_LEVELS`;
the common `adminTierToOsmLevel` outputs: region / county / sub-district /
municipality). Rarer levels (2/3/5/9/10) warm on-demand via `?warm=1`
(`warmRelationAdmin`) on first use, so the next game is warm. Client:
`fetchPrewarmedAreaAdmin(level)` (`src/maps/api/adminBoundary.ts`) fans the
endpoint over EVERY play-area relation (primary + added adjacent) and unions;
`findAdminBoundary` tries it FIRST (point-in-polygon on the served boundaries),
falling back to the v826 live poly query on a cold miss (which background-warms
the cold ids). `adminPadKm` is exposed in `/api/reference-filters` for laptop
sync. **Deliberately NOT in the star gate** (like water/coast) — a starred city
still self-warms admin on first use until the cron/laptop catches up; per-level
admin geometry is a family of queries, so bulk warming is bounded to the common
levels to avoid over-warming whole-state polygons across every city. (measuring
`admin2-border` was already area-keyed via `findPlacesInZone`;
`admin1-border`/`international-border` are bundled Natural Earth, no Overpass.)

**v830 — trip route draws the REAL street/track path + endgame-trigger size
sweep.** Two demo-polish items. (1) **Walking (and transit) legs now follow the
real geometry instead of a straight from→to line.** The MOTIS/OTP plan adapters
return each leg's `legGeometry` (a Google-encoded polyline — the actual
walking-street route and track shape) which the worker was DISCARDING. New
`overpass-cache/src/travel/polyline.ts` (`decodePolyline` + `legGeometryPoints`,
unit-tested) decodes it to `[lng,lat]` points; `JourneyLeg` gained an optional
`geometry` field (worker `travel/types.ts` ↔ client `src/lib/journey/plan.ts`,
kept in sync like the rest of the wire shape) that `parseMotisPlan` (transitous
+ self-hosted MOTIS) and `parseOtpPlan` (Estonia/Barcelona/Australia/Hungary)
populate. **trafiklab** (SE ResRobot, the demo city's provider) shapes its
TRANSIT legs from the `passlist=1` intermediate stops (`stopsToGeometry`) —
stop-to-stop, so a Dalarna trip's transit legs follow the line, though its walk
legs stay straight (ResRobot has no street path). `journeyToRouteFC`
(`src/lib/journey/route.ts`) draws `leg.geometry` when it has ≥2 finite,
non-Null-Island points, else falls back to the straight segment — so every
other adapter degrades gracefully and the map fit still frames the richer line.
Adapters with no polyline (HAFAS/FPTF, EFA, Navitia, …) remain straight-line —
a follow-up could add their native shapes. (2) **Endgame-trigger affordances
sized up** to match comparable flows (the v827 dialogs, the timer's own
eyebrows): `HiderTimer`'s "Awaiting hider"/"In the zone" badge (`text-[9px]`→
`text-[10px]`, icon `w-3`→`w-3.5`) + "Mark hider found" button (`text-[10px]`→
`text-xs`, icon `w-3`→`w-4`, roomier padding; stale "share the link" title
dropped — v824 removed the share); `StationTransitCard` "Start endgame here"
(`text-xs`→`text-sm`, helper `text-[11px]`→`text-xs`); `HiderHome` endgame
confirm/refute buttons (`size="sm"`→default, `flex-1` so they fill the row,
icons `w-3.5`→`w-4`).

**v829 — hide team is a UNIT of equal hiders (main-hider / co-hider split
REMOVED); Track 1 of the hider-role rework.** There used to be one privileged
"main hider" (answered questions, played the deck, committed the zone) plus
passive "co-hiders" (a read-only `CompanionView`). That split is gone: the
role model is now just **`Role = "seeker" | "hider"`** (`protocol/state.ts`),
any number of players can be hiders, and **every hider is equal** — each can
commit the hiding zone, answer questions, and play the hider deck. `CompanionView`
was DELETED (`HiderView` no longer branches on a co-hider role; a stray
`playerRole==="coHider"` is coerced to `"hider"` on read everywhere —
`hiderRole.ts` decode, `demoBroker`, `store`). **Wire/server:**
`CMsgPromoteCoHider` (+ `handlePromoteCoHider` + `promoteCoHider` client action)
removed; `CMsgRotateHider.coHiders?: string[]` is now "the rest of the hide
team" (assigned `hider`, not `coHider`); `GameRoom.handleSetRole` dropped the
`role_taken` exclusivity lockout (multiple hiders allowed) and coerces an
inbound `"coHider"` → `"hider"`; `handleSetHideZone` now FANS the committed zone
to every OTHER hider (`cp.role==="hider" && pid!==sender`) so the whole team
sees it, and delivers the current zone to a hider on join; all the old
`role==="hider" || role==="coHider"` fan-out disjuncts collapsed to
`role==="hider"`. **Multi-hider zone-commit echo guard:** because any hider can
commit AND the server now fans the zone back to the other hiders, `store.ts` has
a module-level `applyingRemoteZone` flag — the inbound-zone handler wraps
`hidingZone.set` in try/finally toggling it, and the outbound push subscription
early-returns while it's set, so a received commit doesn't bounce back out and
loop. **RolePicker** dropped the exclusive-slot / co-hider tile — the Hider tile
now reads "Team up — multiple players can hide together." **`RotateHiderDialog`
is multi-select** (from v827): pick a whole hide team; everyone selected becomes
an equal `hider`. **Track 2 (deferred):** the hider deck/hand/discard economy is
STILL per-device (`hiderRole.ts` local atoms, no wire messages) — a truly SHARED
server-authoritative hand (so the team draws/keeps/discards/plays from one deck)
is the next step, documented in `MULTIPLAYER.md`. Until then each hider holds
their own hand; the shared surface is the zone + answers.

**v828 — game view loads DURING the countdown (not after the GO-GO-GO card is
closed).** v822 claimed the in-game shell mounted+loaded beneath the flourish,
but the gate (`gameStarted = clockArmed && !(overLobby && celebration)`) kept
the pre-game branch during the flourish, so the shell — and its map (GL init +
basemap tiles + the slow play-area boundary/Overpass fetch) — only mounted on
DISMISS → the "choppy unloaded map after closing GO-GO-GO" the user reported.
Now (SeekerPage + HiderPage) the shell MOUNTS as soon as the clock is armed
(`clockArmed`), INCLUDING during the flourish, held VISUALLY hidden
(`opacity:0` + `pointer-events-none`, `transition-opacity duration-500`) behind
the App-level GoGoGo overlay via a new `flourishActive = clockArmed &&
overLobby && celebration` flag that gates ONLY the shell's opacity, not whether
it mounts. So the map loads through the 3-2-1 countdown and is (hopefully) ready
when the card is dismissed — `flourishActive` flips false, the shell fades 0→1
as the overlay's opaque cover fades out. A normal mid-game reload has
`flourishActive` false → renders at opacity 1 with no spurious fade. Trade-off:
the lobby no longer shows behind the countdown (the pre-game branch unmounts the
instant Start is pressed) — the countdown plays over the dark shell base, which
still reads as "faded to black". v820 self-healing carries over (flourishActive
tied to the celebration being live, so a stuck `gameStartOverLobby` can't hide
the map). Bonus: only ONE MapLibre context now during the flourish (the lobby's
preview map unmounts), not two.

**v827 — "New round does nothing" fix + multi-hider rotation + round-end
sizing.** (1) **BUG: New round button did nothing.** `EndOfRoundDialog` is a
plain fixed overlay at `z-[1072]`; `RotateHiderDialog` (the "pick next hider"
Radix dialog it opens) was `z-[1060]`, so it opened BEHIND the celebration
overlay — same stacking class as the lobby/GoGoGo bugs. Raised
RotateHiderDialog content+overlay to `z-[1080]` (clears both the end-of-round
overlay and the lobby drawer it's also launched from). (2) **Multi-hider
rotation.** `RotateHiderDialog` is now MULTI-select: pick a whole hide team —
one MAIN hider (answers questions + plays the hand) plus any number of
co-hiders; everyone else becomes a seeker. Wired end-to-end: `CMsgRotateHider`
gained optional `coHiders?: string[]`; `GameRoom.handleRotateHider` assigns
primary→hider, coHiders→coHider, rest→seeker in one pass; `seekerRotateHider(to,
coHiders?)`; the demo broker applies the rotation + broadcasts presence (was a
silent no-op); all four call sites (`EndOfRoundDialog`, `RoundEndSection`,
`HiderHome`, dialog) pass `(primaryId, coHiderIds)`. Backward-compatible — a
single-hider round omits `coHiders` entirely. (3) **Round-end sizing.**
RotateHiderDialog rows/labels bumped from `text-[10px]/[11px]` to `text-sm`/
`text-base` (name), `py-2.5`→`py-3`, a real checkbox (`w-6 h-6`) per member, and
an inline "make main" affordance; title `text-lg font-semibold`, description
`text-sm` — matching the lobby/wizard idiom. EndOfRoundDialog explanatory
paragraphs `text-[10px]/[11px]`→`text-xs` (its celebration eyebrow labels keep
the GoGoGo house style). NOTE: the endgame-TRIGGER components (HiderTimer
endgame badges, StationTransitCard "Start endgame", HiderHome endgame banner)
are a further size-sweep pass, not done here.

**v826 — matching admin-division question is AREA-keyed, not position-keyed
(the real "admin border" Overpass-error source).** `findAdminBoundary`
(`overpass.ts`, used by the matching admin-division / zone / letter-zone
questions for BOTH the seeker's reference point and the hider's live-GPS
auto-grade) built an `is_in(lat,lng); rel(pivot.a)[admin_level=N]; out geom;`
query with the RAW COORDINATES embedded — so every position was a unique query
string → guaranteed R2 cache MISS → live Overpass every time (the rate-limit
errors on the admin-division question even in a fully-prewarmed city; same
one-producer lesson as v640's `around:GPS`). Now it fetches ALL admin_level=N
boundaries in the PLAY AREA once via `findPlacesInZone(...,"relation","geom")`
— a poly-scoped query the worker caches in R2 (reused across every position in
the game, both roles) — and finds the CONTAINING boundary client-side
(`turf.booleanPointInPolygon`), falling back to the old position-keyed `is_in`
only if the area fetch fails or finds no containing area. (measuring
`admin2-border` already went through `findPlacesInZone`, so it was already
area-keyed; measuring `admin1-border`/`international-border` are bundled Natural
Earth, no Overpass.) NOTE: this makes the admin query CACHEABLE + reused (one
live fetch per game at most); a cron/laptop pass to prewarm it ahead-of-time
(zero live even on first use) is a further worker-side step, not done here.

**v825 — hider auto-compute correctness pass (from a full per-type audit).**
Three subtypes where the hider's auto-computed answer was wrong or missing:
(1) **matching `same-length-station`** is a 3-WAY comparison (shorter / same /
longer), but it was routed through the binary `same` Match/No-match control,
which never set `lengthComparison` — so the seeker's elimination
(`matchingStationBoundary`, keyed on `lengthComparison`) graded EVERY answer as
"same" → wrong map cut. New `AutoGradedLengthAnswer` (3-way) grades via the
engine's `lengthComparison` and sends that field; `AnswerControls` routes
same-length-station to it. (2) **measuring `rail-measure-ordinary`** —
`resolveFamily` only matched the exact string `"rail-measure"`, so the shipped
`rail-measure-ordinary` subtype resolved to null → no fast nearest-distance
grade + no answer-view reference overlay. Both `resolveFamily`s
(`NearestReferencePreview.tsx`, `questionImpact.ts`) now match
`rail-measure*` → the `rail-station` family. (3) **tentacles out-of-range** —
`hiderifyTentacles` returns `location:false` when the hider is outside the
tentacle radius (a legit "none within range" verdict), but the UI treated it
as "couldn't auto-detect" and forced manual name entry, which sent a name with
no `location` and mis-graded the seeker (it inverts to eliminating the reach
interior anyway). Now the out-of-range case is an explicit sendable answer
(`{location:false}`) with an "actually, I'm near one — name it" escape hatch.
NOTE (deferred to a focused follow-up): the hider ANSWER-dialog map
(`HiderMap`) is a deliberately-simple seeker-vs-hider comparison and still
shows only a connector (no elimination-region overlay) for null-family
subtypes (admin/border/landmass/street/sea-level/custom); the question CARDS
(`QuestionOutcomeMap`) already draw the true region for those. Also deferred:
the matching admin-division (`is_in`) + measuring `admin2-border` questions
still hit LIVE Overpass (never prewarmed) — the real source of the reported
"1st admin border" Overpass error (measuring `admin1-border` itself is bundled
Natural Earth, no Overpass); prewarming those is a separate worker-side task.

**v824 — no OS share sheet on "Mark hider found."** `HiderTimer.handleMarkFound`
auto-called `shareFoundLink` (OS share sheet / clipboard) — a pre-multiplayer
remnant from when the hider tapped a shared link to end their timer. Now
`seekerMarkFound` syncs the found state over the wire and `EndOfRoundDialog`
fires on both devices, so the share sheet popping open read as a bug. Removed
the auto-call (+ the now-unused import); the manual "Share again" in the
post-game `FoundSummary`/`RoundEndSection` stays for anyone who wants a link.

**v823 — three map/overlay bug fixes.** (1) **Transit overlays now get dimmed
by the elimination mask.** The seeker map's `TransitRouteLayers` load
asynchronously, so their MapLibre layers were appended AFTER the elimination
mask already existed → they painted on top and stayed bright over ruled-out
land ("subway lines aren't dimmed"). Fix: the elimination `<Source>` is now
mounted FIRST (before transit) and ALWAYS present (empty `FeatureCollection`
when there's no mask) so `elimination-fill` is a stable, already-added
`beforeId` target — maplibre refuses to add a layer whose `beforeId` doesn't
exist yet, so the mask must exist before transit references it. Transit passes
`beforeId={ELIMINATION_MASK_LAYER_ID}` (threaded through `TransitRouteLayers`)
so it anchors below the mask; everything drawn after (hiding zones, play-area
outline, flash, pins) lands above it — deterministic regardless of async load
order. Hider map omits `beforeId` (no mask there). (2) **Phantom "Couldn't
send — tap retry" card behind the configure dialog.** A brand-new question is
added to the `questions` store as a DRAFT (`drag:true`, no `createdAt`) while
being configured, and `PendingAnswerOverlay.findOldestPending` picked it up as
a not-yet-sent card. New volatile `configuringQuestionKey` atom (set from
`AddQuestionDialog`'s `pendingKey`) tells the overlay which draft is mid-config
so it excludes it. (3) **Tentacle Voronoi cell shades** now vary only LIGHTNESS
of the tentacle-category purple (hue 266) instead of a spread of hues
(240–300), with CLEAR light-purple borders (`hsl(266,80%,88%)`, width 2)
between cells so adjacent segments stay distinct even on similar shades.

**v822 — flourish reveal + hiding-zones self-heal + elimination reframe.**
(1) **Game-start flourish now masks the lobby→game handoff.** `GoGoGoOverlay`
moved from per-page mounts (SeekerPage/HiderPage, both branches) to a SINGLE
App-level mount (sibling of `RouteTransitionCurtain`), so it survives the
pre-game→in-game branch swap. On dismiss it no longer unmounts instantly: it
drops `gameStartOverLobby` (so the in-game shell MOUNTS + starts loading
beneath it — the self-healing gate flips `gameStarted` true) but KEEPS the
celebration atom set, fading its opaque cover out over `REVEAL_MS` (520 ms),
then clears the celebration. The in-game shell fades in (`animate-in fade-in
duration-500`), so the loaded map is smoothly uncovered instead of a hard cut.
(`preview` mode still clears immediately — no real game beneath.) (2) **Dust
burst is visible now** — bigger throw (220/320 px), bigger puffs, `delay`
160 ms so it bursts AS the card lands (not before it's drawn), 950 ms duration,
and `jlDustPoof` holds opacity through 55% before fading. (3) **Hiding-zones
"At least one place type must be selected" toaster fixed.**
`displayHidingZonesOptions` + `hidingZonesAutoFromTransit` are persistent
across games and never reset by the wizard, so a stuck `auto=false` + `[]` from
past testing survived into a fresh game and errored on every toggle.
`HidingZoneOptionsSync` now self-heals an empty custom list to the
allowed-transit default (or `[railway=station]`), and `ZoneSidebar` falls back
to `[railway=station]` instead of hard-erroring (belt-and-braces). (4)
**Elimination flash reframes to the REMAINING area.** After the flash of the
newly-ruled-out slice, `triggerEliminationFlash(delta, remaining)` glides the
camera (`fitMapToRemaining`, 900 ms) to frame the post-elimination region as
the red fades — "here's what we ruled out → now here's what's left."

**v821 — NaN hiding-clock = infinite GO-GO-GO/SEEK thrash + frozen map (root
cause of the "finish wizard → three overlays flicker forever, then a frozen
seeker view on reopen" bug).** If `hidingPeriodEndsAt` is ever **NaN**, the app
is catastrophically stuck: `NaN === NaN` is false, so BOTH round-beat watchers'
value-keyed dedupe (`$firedFor === $endsAt`) can NEVER hold, AND `$endsAt <=
Date.now()` (GameStartWatcher) / `now < $endsAt` (SeekingStartWatcher) are both
false for NaN — so GameStartWatcher re-fires GO-GO-GO **and** SeekingStartWatcher
re-fires SEEK on EVERY render/tick, forever (the 1 s `now` tick + the
celebration `.set()` re-renders feed the loop), pegging the main thread → the
map freezes on "Loading". Two overlays (plus the countdown) thrash because both
watchers fire every frame. **Where the NaN came from:** a corrupt `gameSize`
(off-enum, from the earlier broken-game state — same family as the v807
"Seekers frozen NaN:NaN") makes `HIDING_PERIOD_MINUTES[$size]` undefined →
`minutes` undefined → `Date.now() + undefined*60_000` = **NaN**, which
`handleStartGame` then armed. And the OLD `hidingPeriodEndsAt` encoder wrote
`String(NaN)` = `"NaN"` to localStorage, which the OLD decoder read back as NaN
— so the brick SURVIVED a reload (reopen = still frozen). Defence in depth, all
layers: (1) **atom decode/encode** (`gameSetup.ts`) coerce non-finite → null
(also on `pendingHidingDurationMin`), so a persisted `"NaN"` now reads as "no
game" → LOBBY — this **auto-recovers an already-bricked install on next load**.
(2) **Both watchers** (`GameStartWatcher`, `SeekingStartOverlay`) bail on
`!Number.isFinite($endsAt)` — breaks the loop even for a runtime NaN before it
round-trips through the atom. (3) **The `gameStarted` gate** (SeekerPage/
HiderPage) uses `Number.isFinite($hidingEndsAt)` instead of `!== null`, so a NaN
clock renders the pre-game lobby, never a frozen in-game shell. (4) **`handleStartGame`**
(`GameLobbyDialog`) falls back to 60 min if `minutes` is non-finite, so the clock
can never be armed to NaN at the source.

**v820 — "Start round does nothing" (stuck on the lobby) fixed: two causes.**
The lobby's Start button armed the clock but the game never advanced — the
user stayed on the lobby, clicking Start repeatedly with nothing happening.
Root cause was the v814 game-start flourish, in two compounding ways:
(1) **STACKING BUG (the visible one).** `GoGoGoOverlay` is mounted INLINE
inside the pre-game `<div className="fixed inset-0 …">` (SeekerPage/HiderPage),
which is a `position:fixed` stacking context at `z-index:auto`. The lobby
(`GameLobbyDialog`, a vaul drawer) portals itself to `document.body` at
`z-[1055]`, so the overlay's inline `z-[1070]` was TRAPPED below the drawer —
the whole pre-game div (countdown + GO card included) painted BEHIND the
opaque lobby. So the flourish *did* fire, but invisibly behind the lobby, and
since `gameStarted` is held false until the (unseen, undismissable) GO card is
tapped, the user was stranded. Fix: `GoGoGoOverlay` now `createPortal`s to
`document.body`, so its `z-[1070]` competes in the same stacking context as the
drawer and actually renders on top. (2) **FRAGILE GATE (defence-in-depth).**
`gameStarted = $hidingEndsAt !== null && !$overLobby` held the pre-game branch
on `gameStartOverLobby` ALONE — a volatile flag that, if ever stuck true (a
swallowed overlay mount, a stale flag), stranded the user forever. The gate is
now SELF-HEALING: `!($overLobby && $gameStartCelebrationAt !== null)` — the
hold is tied to the celebration ACTUALLY being live, so the moment the
celebration clears (or never starts) the map shows. The guest `setupChanged`
handler (store.ts) now raises `gameStartCelebrationAt` synchronously alongside
`gameStartOverLobby` (both flip together) so a guest never flashes the map in
the one-frame gap before its GameStartWatcher effect would have set it. The
Move powerup still plays its GO-GO-GO over the MAP (it leaves
`gameStartOverLobby` false mid-game, so the `&&` is false → gameStarted stays
true). NOTE: the separate "role picker didn't appear / no assigned role after
the wizard on the real autohosted room" report is on the multiplayer-server
path (RolePicker is a body-portaled Radix Dialog at z-[1060], NOT hit by the
stacking bug); pending retest after this deploy + the PWA reinstall.

**v819 — pre-game lobby runs ONE map, not two (role-picker freeze on the Chrome
PWA).** Firefox-for-Android handled Dalarna County + England fine while the
installed Chrome PWA froze on the role picker — and the freeze got WORSE per game
started in a session (fresh load = sluggish; one new game later = frozen). That
signature is a WebGL-context accumulation, not the v818 boundary/mask cost (a
capable browser chews through England's mask). Root cause: SeekerPage's PRE-GAME
lobby branch mounted a hidden full-screen warmup `<Map>` (v338, to warm the basemap
HTTP cache during lobby time) — a SECOND live MapLibre GL context ON TOP of the
lobby's own `PlayAreaPreviewMap`, which already warms the same basemap. So the
pre-game screen ran two GL contexts + a full seeker Map's effects; across several
new-games a constrained Chrome PWA hit its live-context cap and the role picker
locked up (Firefox tolerated it as the ~0.5 s selection lag). v819 REMOVES the
warmup Map — the preview map is enough to warm the HTTP cache, and the in-game map
still initialises against it. NOTE: v818's in-game mask guard is KEPT (it's a real
defence for a slow device per the v759 note), but it is NOT the role-picker freeze.

**v818 — huge-boundary main-thread freeze (the "PC heats up, map stuck on
Loading" bug).** The seeker `Map`'s elimination effect computes `holedMask` — a
world-scale `turf.difference` (world rectangle MINUS the play area) + a `turf.
simplify`, ON THE MAIN THREAD — to dim everything outside the play area. On a
pathologically large / dense boundary (a whole COUNTY like Dalarna, a huge metro)
that blocks the thread for seconds and freezes the tab (CPU pegged, map stuck on
"Loading map"). v759 already skipped this pre-game (the invisible warmup Map); v818
caps it IN-game too: a new `coordCountAtLeast(geom, cap)` (early-exits at the cap,
so it's O(cap) not O(n)) gates the mask — past `MASK_MAX_VERTICES=20000` the mask is
skipped entirely. The mask is purely cosmetic (the dim outside the area); the crisp
play-area outline + all question layers still render, so a giant play area is now
merely un-dimmed instead of frozen. NOTE: the separate "wizard-finish lands on the
seeker view instead of the lobby" symptom in the same report is the v808
stale-room-resume bug, already fixed in latest — it needs the deploy + a reload
(the root error boundary's Reload wipes the SW/cache) to take effect.

**v817 — hard belts against the freeze / blank-screen.** Two defence-in-depth
additions after the role-picker freeze persisted (sometimes a frozen pure white/
black screen with no UI at all): (1) **`createGame` hard throttle** (`store.ts`) —
a module-level `CREATE_GAME_MIN_INTERVAL_MS=3000` guard that makes room creation
physically unable to fire more than once per 3 s, INDEPENDENT of any caller's retry
logic. This is the definitive stop for a create→fail→create loop pegging the main
thread (the lobby autohost spinning against the Worker's per-IP 429 room-creation
rate limit — very reachable after many quick new-games, since v808 makes each
wizard-finish create a fresh room). Even if the v816 `hostingState==="failed"`
effect guard ever regresses, `createGame` itself can't hammer. (2) **Root error
boundary** (`App.tsx`) — the whole app is now wrapped in `MapErrorBoundary` (a
general boundary despite the name; its Reload wipes the SW + Cache Storage). A crash
in `BetaGate` / the router / the transition curtain used to bubble past the
per-route boundaries and blank the page to WHITE with no recovery; now it shows the
recover card — which ALSO fixes the "stale service-worker serves an index pointing
at chunks the latest deploy already replaced" white screen that a rapid deploy
cadence can cause.

**v816 — role-picker freeze: two more triggers killed.** After v810 made the
pre-game lobby non-modal, the role picker could STILL freeze (frozen input +
unresponsive UI) via two other mechanisms, both fixed: (1) **Lobby autohost retry
loop** — the self-heal effect (`GameLobbyDialog`) re-runs on its own `hostingState`
change, so a persistent `createGame()` failure (most often the multiplayer Worker's
per-IP room-creation **429 rate limit** after many quick new-games) spun
create→fail→create in a tight loop that pegged the main thread. Added an
`if (hostingState === "failed") return;` guard so a failed create waits for the
user's explicit Retry button (which resets to `"idle"`) instead of auto-retrying.
(2) **RolePicker auto-focus grab** — Radix Dialog auto-focuses its first focusable
(the name input) on open, popping the keyboard and, layered over the lobby drawer,
starting a focus tug-of-war. `onOpenAutoFocus={(e) => e.preventDefault()}` on the
RolePicker's `DialogContent` stops the mount-time grab; the user taps the field when
ready and the non-modal lobby lets the focus hold.

**v815 — radar "scan" overlay is a real sweep (beam + fading trail).** The pending
radar-question overlay on `Map.tsx` was a uniform-opacity 60° turf `sector` — a
rotating pie-slice, not a radar scan (the old Leaflet-era `RadarScanOverlay` sweep
was never ported after the migration; the in-file comment said so). Rebuilt as a
classic radar sweep: per pending radar target, the rAF loop builds a triangle-fan
**trail** of `SWEEP_SEGMENTS=24` thin wedges spanning `SWEEP_TRAIL_DEG=150°` behind
the head — each wedge tagged with a brightness `a` (1 at the leading edge → 0 at the
tail) that a **data-driven `fill-opacity`** (`interpolate` on `["get","a"]`, 0→0,
1→0.4) fades out — PLUS a bright **beam line** (centre→perimeter at the head angle,
`line-blur:2` for a soft radar glow). Both live in the one `radar-sweep` source; the
fill layer filters `geometry-type == Polygon`, the beam layer `== LineString`
(`fill-antialias:false` kills seams between adjacent trail wedges). Geometry is
written via `getSource().setData()` each frame (GPU-side, no React re-render);
`SWEEP_PERIOD_MS=4000`. Trail wedges use `turf.destination` per perimeter point
(cheaper than the old per-frame `turf.sector`). Seeker-only (hider never sees the
deduction overlay).

**v814 — game-start flourish plays OVER the lobby (no seeker-view flash).** The
v813 countdown appeared over the seeker MAP, because arming the clock
(`hidingPeriodEndsAt`) flips `gameStarted` and instantly swaps the pre-game branch
(lobby only) for the in-game shell (map) — so you glimpsed the map before the
GoGoGo overlay mounted. Fixed with a dedicated volatile flag
**`gameStartOverLobby`** (`gameSetup.ts`): set TRUE synchronously the instant the
clock is armed — from the lobby's `handleStartGame` (host, alongside a synchronous
`gameStartCelebrationAt`) and from the `setupChanged` null→non-null transition
(guest) — and cleared when the GoGoGo card is dismissed. `gameStarted` in
SeekerPage/HiderPage is now `$hidingEndsAt !== null && !$overLobby`, so the pre-game
branch (and the lobby, whose `open` gains `|| $overLobby`) STAY mounted through the
whole flourish; `GoGoGoOverlay` is now mounted in the pre-game branch too. Result:
the 3-2-1 countdown punches in OVER the lobby (backdrop only `opacity-0.4` so the
lobby reads through), then the GO-GO-GO card explodes while the backdrop deepens to
`0.92` — fading the lobby away in the background — and only when the user taps "show
me the map" (dismiss → clears both flags) does the branch finally swap to the map.
A dedicated flag (not reusing `gameStartCelebrationAt` for the gate) is REQUIRED
because a mid-game **Move** powerup also re-fires that celebration, and Move must NOT
bounce the player back to the lobby view — Move leaves `gameStartOverLobby` false, so
its GoGoGo plays over the map as before. Not set on reconnect (`applySnapshot`), so a
mid-game rejoin never replays it.

**v813 — lobby polish + game-start flourish.** Pre-game lobby (`GameLobbyDialog`):
(1) bigger header — city title `text-xl font-bold` → `text-3xl font-black`, and the
top-right Share button went from `size="sm"` to default so it anchors the larger
title. (2) Bigger Seekers/Hiders roster (`RosterCard`) — card padding, section
label (`text-[10px]`→`text-xs`), player-name rows (`text-sm`→`text-base font-medium`),
HOST/(you)/MAIN badges, empty-state, and Join button all bumped a step. (3) Removed
the "Need at least one seeker and one hider…" line (the "Pick your team above to
continue." hint stays, enlarged to `text-sm`, shown only when role is null).
(4) Bigger House rules section (`HouseRulesSection`) — heading, intro, per-rule
label (`text-sm`→`text-base`) + description (`text-xs`→`text-sm`), and the add-rule
button. (5) **Game-start flourish** — `GoGoGoOverlay` now plays a huge **3-2-1
countdown** (`jlCountPunch`, 750 ms/number) then the **GO-GO-GO card EXPLODES in**
(`jlGoExplode` overshoot) with a ring of **cartoon dust poofs** bursting outward
behind it (`DustBurst` — 20 deterministic memoised particles, two rings, driven by
the `jlDustPoof` keyframe via per-particle `--dx/--dy/--ds` CSS vars). Both beats
ride the existing single `gameStartCelebrationAt` trigger, so host + guests get the
full sequence; the debug-gallery preview skips the countdown to show the card. The
hiding clock already runs underneath, so the ~2 s countdown is purely visual.

**v812 — contextual "turn on notifications" prompt.** Instead of asking for
notification permission up-front (low conversion, easy to deny before the value is
clear), the app now asks at the first moment the grant pays off, ONCE per device.
`src/lib/notificationPrompt.ts` owns it: `maybePromptForNotifications(copy)` no-ops
unless `notificationPermission === "default"` (undecided — already-granted needs no
ask, denied/unsupported can't be helped) AND the persisted `notificationPromptSeen`
(`jlhs:notifPromptSeen`) is false; it claims the one-shot synchronously then raises
the volatile `notificationPrompt` atom on a 600 ms delay (so the triggering UI —
the configure dialog / lock-in confirm — settles first, no modal-over-closing-modal
flash). `NotificationPrompt.tsx` renders the friendly soft-ask dialog (z-[1060],
button-only so no focus-trap fight over a drawer); its Enable button is the user
gesture that fires the real `requestNotificationPermission()`. Mounted on both the
seeker and hider in-game trees. Triggers: the **seeker** after sending a question
(`AddQuestionDialog.handleConfirm`, multiplayer branch — "get notified when the
answer arrives") and the **hider** after locking a zone (`confirmAndCommitZone` —
"get notified when questions come in"). A dismissed prompt never auto-nags again;
the header bell (`NotificationsToggle`/`NotificationsIconButton`) stays the manual
entry point.

**v811 — hider Zone + Questions drawer headers match the Map-options drawer.**
The hider Zone drawer dropped its `Tent` icon from the "Hiding zone" title and both
the Zone and Questions drawer descriptions went from `text-xs … leading-snug` to
`text-sm text-muted-foreground` — so all three vaul drawer headers
(`HiderMapOptionsDrawer`, the Zone drawer, the Questions drawer in `HiderBottomNav`)
now share the same `text-lg font-semibold` title + `text-sm text-muted-foreground`
subheader treatment.

**v810 — pre-game lobby is NON-MODAL (fixes the frozen role-picker).** With v808
correctly landing the user on the lobby + RolePicker after the wizard, a NEW freeze
surfaced: the role-picker's name input was focused and the keyboard opened, but
typing didn't land and the whole UI was unresponsive. Root cause is a FOCUS-TRAP
FIGHT: the pre-game lobby (`GameLobbyDialog`) is a **modal** vaul drawer (focus trap
+ body scroll-lock by default), and the `RolePicker` Dialog that layers OVER it
(host, role-not-yet-picked, z-[1060]) portals its autofocused input to
`document.body` — OUTSIDE the drawer's DOM subtree. vaul's focus guard then yanks
focus back into the drawer on every focus attempt, so the input can't hold focus
and the focus-bounce pegs the main thread (distinct from the earlier z-index /
body-pointer-events freezes — this is focus, not pointer-events). Fix:
`VaulDrawer.Root` now passes **`modal={isMidGame}`** — pre-game the lobby is
NON-modal (there's no seeker/hider shell mounted behind it pre-game, so nothing
needs the trap; the RolePicker is a proper Radix modal with its own overlay and
owns focus cleanly). Mid-game manual reopen stays modal (it sits over the live game
shell). Bonus: a non-modal pre-game drawer no longer renders body-portaled popovers
inert, so the in-lobby Popovers/Dialogs are robust regardless of the `drawerEl`
portal.

**v809 — transit-overlay toggles: label BESIDE the icon, wrap when they don't
fit.** Follow-up to v808's stacked icon-over-label: the map-options
`TransitIconToggle`s now render icon + label side-by-side and the row
(`flex flex-wrap gap-2`) line-breaks the buttons as a group when they no longer
fit one row. Each toggle became a self-contained bordered pill (`flex-1 basis-24
rounded-lg border-2`) instead of segments of one bordered box with `border-l`
dividers, since the old segmented group couldn't wrap cleanly; the `borderLeft`
prop was dropped.

**v808 — wizard finish drops the stale room (real root cause of "thrown into a
dead game").** v807 scrubbed local round state but the user was STILL dumped into
a "dead" seeking shell (SEEK! then GO-GO-GO overlays, then an empty lobby, no
running timer). Root cause was one level deeper: finishing the wizard REUSED the
previous game's multiplayer/demo room. On navigating to `/`, `MultiplayerBoot`'s
`tryResumeFromPersistent()` reconnects to that persisted room and the STALE server
snapshot clobbers the just-nulled `hidingPeriodEndsAt` — `applySnapshot` (store.ts
~738) and the `setupChanged` handler (~938) BOTH write `hidingPeriodEndsAt.set(msg.
setup.hidingPeriodEndsAt)` unconditionally — so the in-game seeking shell rendered
instead of the pre-game lobby (the lobby only opens when `hidingEndsAt === null`),
replaying the celebration overlays off the stale clock. v807's fired-for-key clear
merely unmasked the SECOND overlay; the resume-clobber was the actual bug (present
pre-v807 too). Fix: `SetupPage.handleFinish` now calls **`leaveGame()`** instead of
the old `hostPushSetup()` — finishing the FULL wizard is unambiguously a new game
from scratch (only reached via first-time setup or `startNewGame`; mid-game tweaks
use `GameSetupDialog`), so it drops any prior room (real OR demo — `leaveGame` also
tears down a lingering demo broker's bots) and the lobby's autohost effect then
creates a guaranteed-fresh, clean-state room and pushes THIS setup. Deterministic:
no code left to resume → no stale snapshot → the lobby is always the next surface.
Also (unrelated polish): the map-options **transit-overlay toggles now show a text
label** under each mode icon (Subway/Bus/Ferry/Train/Tram), matching the Basemap
buttons' icon+label idiom (`TransitIconToggle` stacks icon over a `text-[10px]`
label; the segmented row dropped its fixed height to fit two lines).

**v807 — wizard finish = pristine game (stale round-state bleed fix).** Finishing
the setup wizard could throw the user STRAIGHT into a seeking game — skipping the
lobby/role-picker — with a bogus **"Seekers frozen — NaN:NaN"** banner. Root cause:
`SetupPage.handleFinish` did only a PARTIAL reset (play area / size / transit +
`hidingPeriodEndsAt=null`), never scrubbing the per-round economy/freeze/celebration/
endgame atoms. So a leftover `seekersFrozenUntil` from a previous game bled into the
new one — and `NaN` proves it was CORRUPT persisted state (a fresh game never
produces it; a stored `"NaN"` decoded back to `NaN`). A stale non-null
`hidingPeriodEndsAt` (past) likewise rendered the in-game seeking shell instead of
the pre-game lobby. Fixes: (1) `handleFinish` now calls **`resetSharedRoundState()`**
(the shared per-round scrub — nulls the live clock, Move freeze, credit/debit,
endgame stamps, celebration triggers; does NOT touch play-area config) before staging
`pendingHidingDurationMin`, so the lobby is the guaranteed next surface after the
wizard. (2) `resetSharedRoundState` also nulls the VOLATILE celebration atoms
(`gameStartCelebrationAt`/`seekingStartCelebrationAt`) so a mid-session stale
GO-GO-GO / SEEK! overlay can't replay into the next round/game. (3) NaN hardening —
`seekersFrozenUntil`'s decode drops any non-finite value to `null`, and
`SeekerFrozenBanner` bails on a non-finite `frozenUntil`, so corrupt data can never
render `NaN:NaN` again.

**v806 — copy tweak.** Dropped "Love it?" from the landing-page Nebula-store
footer link (`Welcome.tsx`, both layout branches) → "Buy the official Hide+Seek
box from Nebula →".

**v805 — branded curtain over the seeker↔hider shell swap.** Picking a role
navigates between two SEPARATE full-screen apps (the seeker `/` and hider `/h`
routes each mount their OWN MapLibre map), so the route change tears one whole
tree down and builds the other — which reads as a jarring "reload" even though
it's a soft SPA nav (NOT a `window.location` reload — that was ruled out;
`appNavigate` + `GameRouteGate` redirect on the `playerRole` change). New
`RouteTransitionCurtain` (mounted in `App` OUTSIDE the router so it survives
the navigation, `z-[2000]`) snaps a `bg-background` + wordmark cover in the
instant the role crosses the seeker↔hider boundary — masking the closing
RolePicker dialog + the tree swap — then fades it out (~320 ms hold + ~340 ms
fade) once the new shell has mounted, so the whole thing reads as one smooth
branded wipe. Triggered purely off `playerRole` crossing `isHiderSide` (so it
covers the host's `null→hider` pick, the reported case; a coHider↔hider shuffle
or seeker↔null change stays on the same shell → no curtain). A true CSS
cross-fade isn't feasible with `createBrowserRouter` (it unmounts the old route
instantly), so this curtain is the low-risk equivalent — no router restructure,
no change to the delicate nav path.

**v804 — hider end-timer / zone-callout cleanup.** (1) The just-committed
on-map **callout** (`HiderMapTimer`): tent icon removed, description simplified
("<zone> is set. You can let the seekers know, or keep the timer running to
give yourself more time."), and its button renamed **"End hiding early" →
"End timer"**. (2) The redundant **navy on-map "End hiding early" button** below
the `HiderMapTimer` golden box was REMOVED — the end-timer action now lives only
in the callout (just after committing) and the Zone drawer (below the timer).
(3) The Zone drawer's end button was likewise renamed to **"End timer"**.
(4) The committed-zone card's **"Change" button was removed** — locking a zone
is irreversible (we tell the hider so at commit), so there's no re-pick
affordance once committed (the picker still shows before the first commit).

**v803 — wizard + hider UX batch.** (1) **Play-area search two-tap bug fixed** —
tapping a search result while the input was focused blurred it FIRST
(`setInputFocused(false)` re-expanded the map showing the OLD area and reflowed
the list), so the first tap only dismissed the keyboard and you had to tap
twice. The result buttons now `onPointerDown={e => e.preventDefault()}` (same
fix the "Keep <area>" button already had) so the first tap lands. (2) Transit
step: "Walking is always allowed." moved into the step SUBHEADER (both
`SetupPage` + `GameSetupDialog`); the "Bus is off by default…" body line
removed. (3) **RolePicker** anchored to the TOP (`top-4 translate-y-0`,
removing the VisualViewport keyboard-inset re-centering) so it no longer jumps
as the keyboard opens/closes; the seeker/hider tiles are back to a SINGLE
column. (4) Lock-in confirm dialog: the `ZonePreviewMap` is now SQUARE
(`aspect-square`), and the header names the zone ("Lock in 71st Street?").
(5) **Hider hiding-zones overlay auto-shows during the hiding period** —
`HiderReachOverlay` one-shot-enables `showHiderReach` when the hiding period is
active and no zone is committed (keyed on the deadline, so a manual toggle-off
still sticks and a new round re-enables), so the hider sees the candidate zones
they'd commit to without opening Map options.

**v802 — wizard play-area layout fill + nearby-zones auto-refresh.** (1) The
full-page wizard's play-area step (`SetupPage` → `PlayAreaStep fillHeight`)
left dead space below the "Change area" button. Restructured: the play-area
card sits on TOP with a compact **Edit** button to its RIGHT (was a full-width
button below), and the map GROWS to fill the space beneath. Done with flex
`order` so the map block stays FIRST in the DOM (mount persistence across
preview↔search — it must never remount/reload) while sitting visually below
the card in preview. `PlayAreaStep` gained a `fillHeight` prop (only the
full-page wizard passes it; the `GameSetupDialog` modal keeps the fixed
near-square map + more content below). `SetupPage`'s step wrapper gets `h-full`
on step 1 so the `flex-1` map can fill. (2) `NearbyStationsPicker` (the hider's
"zones you're in" picker) only computed once on mount — it never reacted to GPS
movement, so "no zone contains your position" never cleared as the hider walked
toward a station. It now auto-refreshes off the live `lastKnownPosition` atom
(the same fix the "You" dot uses), **distance-gated at 25 m** so it recomputes
as they walk without re-running on every ping (`findZonesNearPoint` is the
cached play-area query, so a move-gated recompute is cheap); a one-shot
`getCurrentPosition` is the fallback only when there's no live fix yet.

**v801 — CI build hotfix: restore `workbox-window` direct dep.** v795 dropped
`workbox-window` from `package.json` believing it was only transitive. It is
NOT safely removable: `vite-plugin-pwa`'s injected `virtual:pwa-register`
module imports `workbox-window` and is resolved in the APP's module graph, so
under pnpm's strict (non-hoisted) linking a fresh `pnpm install --frozen-
lockfile` on CI can't resolve it → `Rollup failed to resolve import
"workbox-window"`. Local builds kept passing ONLY because `pnpm install
--lockfile-only` never re-linked `node_modules` (the old hoisted copy lingered)
— so `vite build` alone doesn't catch a strict-resolution regression; a full
`pnpm install` + build does. Restored as a direct dep + lockfile refreshed. The
v795 `react-icons` removal was fine (nothing imports it); only `workbox-window`
was the mistake. **Lesson: after any dependency REMOVAL, run a full `pnpm
install` (re-link) before trusting a local `vite build`.**

**v800 — hider questions drawer polish.** (1) Empty state now mirrors the
seeker's dashed "No questions yet" box. (2) Removed the inbox icon in the
drawer header ("Questions"). (3) The pill-style "Awaiting answer" / "Answered"
section headers became normal `h3` subheaders. (4) The awaiting-question card
now uses the shared `QuestionOverlayCard` chrome (like every other question
card) instead of a bespoke tinted-border row — tapping it opens the answer
view. (5) **Answered cards expand to real content again** — they used to
expand to nothing because the shared `QuestionCard` base looks `thisQuestion`
up from the seeker's `questions` store, which the hider's inbox entries never
enter. `HiderQuestionLog` now renders a self-contained answered card that feeds
the reconstructed question (entry data + reply, `drag:false`) DIRECTLY to
`QuestionOutcomeMap` (photo entries show the received image) — inheriting its
save-to-PNG snapshot trick for free. (6) The answer dialog (`HiderView`
`HiderAnswerDialog`) is opened from inside the Questions drawer (vaul z-[1055])
but defaulted to z-[1050], so it opened BEHIND the drawer and froze the app
(same class as the v797 QR-dialog bug) — lifted content + overlay to z-[1060].

**v799 — hider seeking-phase zone drawer polish.** (1) The committed-zone
read-only map preview swapped from `InlineLocationPicker` to the lighter
`ZonePreviewMap` (new `padding` prop, tight `padding={10}`) — zooms in more
while still framing the whole radius circle, and drops the "Preview shows the
Nm radius from this point" caption (which lived in `InlineLocationPicker`).
(2) Drawer subheader is phase-aware (`HiderBottomNav`): "Explore your zone and
find your final hiding spot." once the hiding period is over with a committed
zone, else "Select a station to hide near." (3) The "Select hiding zone · km
radius" heading is hidden in the committed/read-only view (reads wrong once
you've picked). (4) The committed-zone card restyled to match the station-
picker card idiom (rounded icon block + bold name). (5) SeekerETACard renders
ONLY when there's a computed arrival time — no more "Waiting for a seeker…" /
"No transit route — couldn't estimate" empty slots. (6) `ScoutedSpotsPanel`
pill subheader → normal `h3` heading + a proper empty-state box (dashed border,
icon, heading + copy).

**v798 — hider zone-commit UX polish.** (1) The `HiderZoneHint` on-map header
("Select a station to hide near") was a stray notification-style pill (thin red
tent + sentence-case text); restyled to the app's on-map **overlay-card idiom**
— a solid brand-red icon BLOCK on the left + a bold UPPERCASE label — so it
reads as part of the same overlay system as `QuestionOverlayCard`. (2) The
**lock-in confirmation** (`confirmAndCommitZone` → `appConfirm`) now renders a
small non-interactive **map preview of the zone's radius extent**
(`ZonePreviewMap`, lazily imported by `AppConfirmHost` so MapLibre stays out of
the eager confirm bundle; `ConfirmOptions.previewZone`), tighter copy, and ends
with just "This cannot be undone." (3) The near-identical SECOND modal ("Hiding
zone locked in… End it now / Keep timer running") was REMOVED — after
committing during the hiding period, `confirmAndCommitZone` raises a volatile
`zoneLockedCallout` that `HiderMapTimer` renders as an on-map **callout ABOVE
the timer, with a downward caret pointing at it**, carrying the same End-early /
Keep-running choice where the timer + end action already live. (4) The
end-early button ("End hiding · Start seeking") was reworded to **"End hiding
early"** on BOTH surfaces (`HiderMapTimer` + `HiderHome`) — "start seeking" read
wrong from the hider's own perspective.

**v797 — two demo-blocker bug fixes.** (1) **QR-share dialog froze the app.**
`InviteSheet`'s "Scan to join" QR `Dialog` is launched from INSIDE the lobby
drawer (vaul, z-[1055]) but a plain Radix Dialog defaults to z-[1050], so it
opened BEHIND the lobby — invisible, yet its `DismissableLayer` still set
`body{pointer-events:none}` with no reachable way to dismiss it → whole app
unresponsive. Lifted content + overlay to `z-[1060]` (+ `overlayClassName`),
matching `RotateHiderDialog` (the same launched-from-lobby case in the
z-index-ladder docs). (2) **Trip planner showed a long walk while departures
proved transit exists.** The plan cache-write guard only skipped
`source === "walking"`, so an ALL-WALK itinerary from a REAL adapter
(`source: "transitous"` / self-hosted MOTIS — MOTIS momentarily returns
walk-only when it can't connect within the access/egress budget) got persisted
for 24h, pinning "a really long walk" on a route that has transit. Now
`isAllWalkingJourney(journey)` (no transit leg) is treated like the walking
backstop and NOT cached, so the next dispatch re-tries and picks up the real
transit journey. (Worker `travel/plan.ts` — auto-deploys with the
overpass-cache Workers Build.)

**v796 — overpass-cache abort-sniff gap closed (worker; reliability).** The v667
Overpass soft-timeout defence (HTTP 200 + `remark` + empty/truncated elements)
was applied inconsistently: the **refs / transit / metro** `?warm=1` warmers
(`warmRelationReferences` / `warmRelationTransit` / `warmRelationMetro`) piped
the upstream body straight to R2 via `streamStoreNoTee` with NO sniff, while
the stations/water/coast warmers already buffer-then-sniff. So one transient
Overpass timeout during a warm-on-add stored an empty body for the full 30-day
TTL, and skip-if-fresh then saw the poison as "fresh" and never re-warmed — a
STARRED city could serve empty references for a month. Two-part fix (auto-
deploys with the `overpass-cache` Workers Build): (1) WRITE side — those three
warmers now `await up.text()` → `isAbortedOverpassText` → `compressAndStoreString`,
matching the working warmers (never store poison). (2) READ side — a shared
`serveRelationR2HitHealed` gives `handleReferencesByRelation` /
`handleTransitByRelation` / `handleMetroByRelation` the same self-heal the
interpreter path has: a small (<64 KB) R2 hit is sniffed, a poisoned one is
deleted and treated as a miss (transit falls through to the shard slice, refs/
metro to a clean re-warm), and a clean small entry is re-served from the
decoded text. Large entries stream straight through untouched (zero overhead on
the common path). This heals EXISTING poison too, not just future writes. No
frontend change; APP_VERSION bumped to keep the changelog continuous.

**v795 — bundle-size cleanup (safe Tier-4 from the review).** (1) The geometry
Web Worker core (`geometry/clipCore.ts` + `combineCore.ts`) switched from
`import * as turf` to NAMED `@turf/turf` imports, matching the sibling workers
(`hidingZonesUnion` / `seekerZones`) so that worker's Rollup chunk tree-shakes
to just the functions it uses. (2) `react-icons` (shipped for exactly 3 icons)
dropped — `LiaThumbtackSolid`/`TbMessage2Question`/`MdOutlineVerticalAlignTop`
replaced with Lucide `Pin`/`MessageCircleQuestion`/`ArrowUpToLine`, and the dep
removed from `package.json` (a whole vendor out of the eager `vendor-ui`
chunk). (3) `workbox-window` removed as a DIRECT dep (it stays transitively via
`vite-plugin-pwa`; nothing imported it directly). pnpm lockfile refreshed. The
larger `import * as turf` main-thread refactor is still deferred (its own
careful pass) — modern Rollup tree-shakes `turf.<fn>` member access reasonably,
so the main-thread files are low priority.

**v794 — perf pass 2 (battery / long-session, from the same review).**
(1) `useTransitRouteOverlays` is now ONE effect PER MODE (`useOneTransitOverlay`)
— the old single effect re-ran on any toggle and re-fetched every enabled
mode (spurious spinner flash), and a naive "only the changed mode" guard on
the shared effect would have cancelled an unchanged mode's in-flight fetch
without restarting it; per-mode effects fix both. (2) `tentacles.ts`
`findMetroTentacleCandidates` uses an inline `haversineMeters` over raw coords
instead of allocating a turf point + `turf.distance` per route vertex (metro
networks have hundreds of vertices/route; runs per metro-line question).
(3) `cache.ts` size-cache is now an in-memory copy hydrated once + a debounced
(1/s) flush — was JSON.parse'ing (and stringify+writing) the whole ≤200-entry
object on EVERY progress fetch, worst during a parallel adjacent warm.
(4) `sw.ts` `trimPmtilesRangeCache` no longer relies solely on a SW-lifetime
counter (which resets every ~30 s-idle termination, so the 8000-entry cap
could never fire) — it also trims probabilistically (~1/50 puts) and force-
trims on a put QuotaExceededError (the manual cache had no `purgeOnQuotaError`).
NOT done: the `highSpeedBase` memo key (a lighter signature risks a hash
collision → wrong elimination region, a trust bug, for a rarely-hot Low item)
and the `import * as turf` eager-bundle shrink (a large multi-file refactor
worth its own careful pass).

**v793 — perf + correctness pass (from a 5-agent review).** Four correctness
fixes: (1) multiplayer `transport.ts` auto-reconnect now continues past
attempt 1 — the old `wasOpen` guard only rescheduled from "open"/"connecting",
so a failed RETRY (status "reconnecting") died after one try; `reconnectNow`
also no longer spawns a duplicate socket mid-connect. (2) `nearestToQuestion`
(`overpass.ts`) + the twin loop in `ZoneSidebar.selectionProcess` are radius-
CAPPED (1000 mi) and return null instead of hammering Overpass forever when a
reference is absent or a mirror is soft-timing-out; all four call sites
(matching/measuring grade + ZoneSidebar) guard the null. (3) `context.ts`
`questions` decode uses `safeParse` → `[]` (was a hard `parse` that ZodError'd
the whole route on any schema-drifted/corrupt localStorage). Performance
(battery/long-session focus): (4) `sortAndDedupe` (`journey/stations.ts`) and
`mergeDuplicateStation` (`stationManipulations.ts`) went from O(n²)-with-a-
regex-per-pair to ~O(n) (spatial-grid + precomputed normalised names / name-
bucketed union-find) — the biggest main-thread win, hit every hiding-zones
open in a dense metro since the v751 station-cap removal; (5) matching's
Voronoi `sameCells` filter is an O(n) site-key Set lookup (a cell contains
exactly its own site, so the per-pair `booleanPointInPolygon` was redundant);
(6) the Overpass mirror race now gives each racer its own `AbortController`
and cancels the LOSERS on a win (was downloading every mirror's full multi-MB
body after one already won — real mobile data; `cacheFetch` bypasses in-flight
coalescing when a signal is passed so a loser can't cancel a coalesced
sibling); (7) FIFO-capped the three unbounded module caches (`REVERSE_CACHE`
300, `QuestionOutcomeMap` PNG snapshots 30, `playAreaPrefetch` 160); (8) minor
leak/robustness cleanups (`usePlayAreaBoundary` hydration-race subscription +
timer always cleaned up, `QuestionOutcomeMap` snapshot timer tracked+cleared,
`MultiplayerBoot` load listener removed on unmount, `geocode()` guards
resp.ok/non-JSON). Security findings from the same review were deliberately
NOT actioned (friends-only game; convenience over enforcement).
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
