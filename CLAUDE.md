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
Photon (https://photon.komoot.io/) for both reverse and forward geocoding in `src/maps/api/geocode.ts`. Module-level cache by 4-decimal coords.

### Trip planning (transit travel times + journeys)
Two distinct server capabilities in the `overpass-cache` worker, both Trafiklab-secret-shielded with the R2 + edge-cache pattern:
- **Reach** (`POST /api/journey/arrivals`, `overpass-cache/src/journey.ts`): anchor + many stops → earliest arrival at each (ResRobot `passlist=0`, keeps only the final timestamp). The seeker's `TravelTimesOverlay.tsx` renders stations reachable before `hidingPeriodEndsAt` as map labels, anchored at `gameStartPosition`. The hider's "which zones can I reach" overlay (M2) is the mirror image — same endpoint, anchored at live GPS.
- **Plan** (`POST /api/travel/plan`, `overpass-cache/src/travel/`): single origin→destination journey **with legs** (lines, transfers, walking segments) for trip-detail cards. An **adapter dispatcher** (`router.ts`) tries region-specific adapters in specificity order. Shipped adapters, in three dispatch tiers:
1. **Free country/region** (mostly disjoint bboxes): `denmark.ts` (Rejseplanen HAFAS, keyless), `trafiklab.ts` (SE ResRobot, keyed), `entur.ts` (NO GraphQL, keyless), `digitransit.ts` (FI GraphQL, keyed), `estonia.ts` (peatus.ee OTP, keyless), `tfl.ts` (London, optional key), `swiss.ts` (CH transport.opendata.ch, keyless), `germany.ts` (DE `v6.db.transport.rest` FPTF, keyless — exports `planViaFptf`), `austria.ts` (ÖBB `v6.oebb.transport.rest`, keyless — reuses `planViaFptf`), `ireland.ts` (TFI/NTA EFA, keyless — reuses NSW `parseEfaTrip`), `barcelona.ts` (TMB OTP, keyed `app_id`/`app_key`), `netherlands.ts` (NS Trips, keyed, rail-centric), `nsw.ts` (Sydney TfNSW EFA, keyed), `korea.ts` (ODsay Seoul/Busan, keyed). Shared helpers: `otp.ts` (`planViaOtp`/`parseOtpPlan` — used by Estonia + Barcelona), `germany.ts:planViaFptf` (Germany + Austria), `nsw.ts:parseEfaTrip` (NSW + Ireland). Where two overlap (DK/SE Øresund, DACH borders) the more-specific is first and `dispatchPlan` falls through on null (the regional HAFAS/OTP instances cover their neighbours too).
2. **Broad fallbacks**: `navitia.ts` (Europe, free key) → `motisSelfHosted.ts` (operator's OWN MOTIS box via `MOTIS_SELF_HOSTED_URL` — license-clean, reuses `transitous:planViaMotis`) → `transitous.ts` (public MOTIS over the **Mobility Database**, free+keyless but ⚠️ **flagged non-commercial** — see its header; kept as backstop, revisit before monetising).
3. `walking.ts` — unconditional haversine×circuity backstop, so a journey is *always* produced.

**Cost constraint: every provider is genuinely free** — keyless or free-key-no-billing. Paid/billing-required providers (Google Directions, HERE) were tried and **removed**. Do NOT re-add a provider that needs billing. ⚠️ **navitia.io** appears to have closed its free self-service tier (Hove/Kisio now gate it commercially) — `navitia.ts` is kept (works with a key, defers cleanly without) but new free keys may be unobtainable; **Paris uses `france.ts` (IDFM PRIM)** instead, a separate free marketplace key. **Transitous caveat:** the public instance is non-commercial; if the app is ever monetised — OR to get license-clean global coverage now — run a **self-hosted MOTIS box** and set `MOTIS_SELF_HOSTED_URL` (it's ordered ahead of public Transitous). MOTIS is MIT-licensed; the non-commercial string is only transitous.org's hosted-API policy. Full deployment recipe + cost sizing: **`overpass-cache/SELF_HOSTING_MOTIS.md`** (regional ≈ €7–17/mo Hetzner; planet ≈ €50/mo).

**Coverage reality (updated post-v415 audit):** Transitous's *actual* coverage is far broader than this doc once claimed — its [feeds catalogue](https://github.com/public-transport/transitous/tree/main/feeds) has 131+ regions, including per-state US (NY/CA/IL/WA/OR/FL/TX/NJ/PA/GA), Canada (BC/ON/QC), Japan (575 sources, world-class), Singapore, Hong Kong, every Australian state, and most NZ regions. So the "GTFS-only world" gap is reliably covered by the existing `transitous` adapter; adding more regional adapters there is a *latency* / *commercial-license* win, not a *coverage* win. **The genuine no-free-coord-API holes are narrow:** Taiwan TDX is feeds-only, mainland China is paid-only, Russia/Belarus is regional-only, and several smaller markets (Egypt, Vietnam, Indonesia) publish nothing free.

**Verified-dead in the 2026 audit:** Rejseplanen API 1.0 (`xmlopen.rejseplanen.dk`) shut down 2024-12-04; `denmark.ts` is gated behind a future `REJSEPLANEN_API_KEY` so it defers cleanly to Transitous (which routes Denmark's GTFS feed daily). The ÖBB transport.rest instance (`v6.oebb.transport.rest`) 404s for Austria; `austria.ts` defers immediately rather than burn the 8 s upstream timeout (DB HAFAS doesn't carry Austrian-local data). For `?debug=1` diagnostics + raw upstream probes against every keyless adapter, see `overpass-cache/scripts/adapter-audit.ps1`.

**Latest additions (post-v415):** `australia.ts` — La Trobe University's keyless OTP instance covering VIC/QLD/SA/WA/TAS/NT/ACT (ordered after the official `nsw.ts` so Sydney still hits TfNSW first). `hungary.ts` — BKK FUTÁR's OTP for Budapest, gated behind `BKK_FUTAR_KEY` (free signup at opendata.bkk.hu).

**Future-work shortlist (researched, not yet shipped):**
- **Singapore OneMap** — free email/password key → 3-day JWT → OTP-shaped JSON. Coord→coord. Best APAC gap-filler. Needs token-cache infra.
- **Île-de-France PRIM (Paris)** — free key, 20k/day, Navitia-shaped. Can reuse the navitia parser; just adds a separate quota pool for Paris.
- **VAO-Start (Austria)** — official multimodal AT, free with manual email contract + 100/day cap. Heavy onboarding, low quota.
- **Rejseplanen API 2.0 (Denmark)** — free with email-approved key, 50k/month. Worth doing if real-time disruption data matters; otherwise Transitous + the daily Rejseplanen GTFS feed already covers DK.

Skip-list (researched and explicitly NOT worth an adapter): NYC MTA, BART, WMATA, Chicago CTA, Boston MBTA, NJ Transit, all GTFS-only US agencies; TransLink Vancouver, TTC, STM; PTV Victoria, TransLink QLD, Adelaide Metro, Transperth, Auckland Transport, Metlink Wellington; ODPT Japan; LTA DataMall Singapore; HKeMobility Hong Kong; TDX Taiwan; Mappls India; ATAC Roma; Renfe; CP Comboios; STIB-MIVB; De Lijn. All publish GTFS + RT but no hosted journey planner — Transitous covers them via the Mobility Database.

Adding a country = one adapter file + one entry in `ADAPTERS`; dispatcher, cache and client are untouched.

Wire types are duplicated per side (worker `travel/types.ts` ↔ client `src/lib/journey/plan.ts`), NOT shared via `protocol/` — that mirrors how `journey.ts` already works and avoids cross-worker-root bundling. Pure logic (dispatch selection + every adapter's leg parser) is unit-tested in `tests/travelPlan.test.ts` (40 cases). With the free Transitous universal tier, coverage is effectively global wherever the Mobility Database has GTFS feeds (and grows as feeds are added). Transitous IS the "self-hosted GTFS raptor over the Mobility Database" idea (the old deferred M5) — except the community already hosts it for free, so there's nothing to self-host. The **Mobility Database** (mobilitydatabase.org) is the GTFS-feed catalog Transitous routes over.

**Hider reach overlay** (`HiderReachOverlay.tsx` + `hiderReachFC` shadow atom): mirror of `TravelTimesOverlay`, anchored at live GPS. Uses `fetchAreaStations` (mode-aware Overpass scan capped at 180 stops) → existing `/api/journey/arrivals` → filters to reachable-before-`hidingPeriodEndsAt`. Painted by `HiderBackgroundMap` as circle dots + HH:MM labels. Toggle in `HiderMapDisplayControls` ("Reachable zones"). Auto-disables once a zone is committed.

**Hider trip-plan card** (`HiderTripPlanCard.tsx`): rendered inside `HiderHome`'s `hiding`/`grace` branches under the zone picker once `hidingZone` is set — calls `/api/travel/plan` from live GPS to the committed station, renders via the shared `JourneyCard`. Re-fetches on zone/mode change or when the **settled** GPS origin moves past the trip re-plan threshold — both trip planners (hider card + seeker sheet) gate on `useStableGpsOrigin` (`src/hooks/useStableGpsOrigin.ts`, default 150 m) so position jitter while standing still no longer re-runs the plan effect (which used to abort the in-flight request every tick and make the card reload constantly).

**Seeker trip planner** (`SeekerTripPlannerSheet.tsx` + launcher pill): Vaul drawer in the top-right cluster of `SeekerPage`. Text input → `forwardGeocodeOne` (or `lat,lng` paste) → `JourneyCard` for the journey from live GPS. Open state in `seekerTripPlannerOpen`.

### Subtype picker (matching/measuring/tentacles)
`src/lib/subtypes.ts` defines `SUBTYPES` with `validSizes: GameSize[]` per entry. `-full` suffixed types (e.g. `aquarium-full`) are Small+Medium only — not available in Large games. Use `isSubtypeAllowed(value, size)` to filter dropdowns, `getSubtypes(categoryId, size)` for the step-2 picker tiles. Use `cleanDescription(desc)` to strip `" Question"` and `" (Small+Medium Games)"` suffixes from schema descriptions.

**Availability gating (v564):** `useSubtypeAvailability` (`src/lib/subtypeAvailability.ts`) greys out subtype tiles whose reference type has too few instances *inside the play area* to make a meaningful question — matching/tentacles need ≥2 (with one, everyone shares it), measuring needs ≥1. It counts via `countInPlayArea(family)` (`playAreaPrefetch.ts`, polygon-filtered cached features) for countable POI families only (airport, rail-station, `api:*` from `LOCATION_FIRST_TAG`); non-countable subtypes (admin divisions/borders, coastline, transit-line/name-length, metro, landmass, photo) and unknown/cold counts always stay enabled, so nothing valid is wrongly hidden. Relatedly, the **nearest-reference** lookup (`NearestReferencePreview.tsx`) filters every Overpass `around:`-radius fallback to the play-area polygon (`pointInPlayArea`) so an out-of-bounds instance can't win over a valid in-area one (rulebook p17).

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
- **Satellite**: Esri World Imagery `server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` — free, no API key
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
        <MapDisplayControls />               {/* top-right; slides DOWN when a question overlay is shown */}
        <SeekerTripPlannerLauncher />        {/* top-right, under controls */}
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

`BottomNav.tsx` — four slots: **Questions** (`List`) | **New question** (`Plus`, primary CTA) | **Lobby** (`Users`) | **Settings** (`Settings`).

- Questions → opens QuestionSidebar (left drawer); badge = questions added.
- New question → opens AddQuestionDialog; disabled while `hiding` OR a previous question is still unanswered.
- Lobby → opens `GameLobbyDialog` via `lobbyManualOpen`; badge = online participant count (added v242).
- Settings → opens the `AppSettingsDrawer` via `moreSheetOpen` (tutorial, rulebook, units, theme, preload — the merged settings+more drawer).

There is **no "More" slot** anymore, and the hiding-period countdown is **not** in the nav — it lives on the map's `HiderTimer` card (the standalone "Game"/countdown drawer was retired in v270).

## Map display controls (bottom-left, v616)

`MapDisplayControls.tsx` — a **single compact "Map options" chip** (`Layers` icon, `h-14/w-14`, with an active-count badge) that opens a **Popover** (`side="top" align="start"` → opens up + left-aligned) containing:
- **Basemap** — Map / Satellite segmented switch.
- **Overlays** — Hiding zones + Travel times toggles.
- **Export** — Save image.
- **Transit overlays** — per-mode toggles (rail / subway / bus / ferry / train / tram), gated on `allowedTransit`.

**Position (v616):** moved from top-right to **bottom-left**. `SeekerPage` owns the wrapper (`absolute left-2 md:left-4 z-[1030]`); it sits at `bottom-7 md:bottom-8` while seeking and is **pushed UP to `bottom-28`** during the hiding period so it clears the `HiderTimer`, which sits bottom-LEFT during hiding (and bottom-RIGHT while seeking). `inHidingPeriod` is computed in both `SeekerPage` and `Map.tsx` via a one-shot `setTimeout` on `hidingPeriodEndsAt` (no per-second tick). During hiding, `Map.tsx`'s `MapNavControls` dodges to bottom-RIGHT so it doesn't collide with the pushed-up chip. The old MapLibre `ScaleControl` ruler (which sat bottom-left where the chip now lives) was **removed** in v616.

**Attribution (v616):** the MapLibre `AttributionControl` moved to **`position="top-left"`** (out of the way of the bottom controls). In **dark mode** the default bright-white attribution pill + "i" toggle are re-skinned to a translucent dark chip with muted text (`.dark .maplibregl-ctrl-attrib*` rules in `globals.css`; the collapsed toggle uses `filter: invert(1)`). License-clean: OSM's "© OpenStreetMap contributors" and Protomaps' "Protomaps © OpenStreetMap" credits only require presence + legibility, not a colour.

(The hider's sibling `HiderMapDisplayControls` is a trimmed version of the same popover + a "Reachable zones" toggle; see the Trip-planning section.)

**Hiding-zone overlay rendering** (`ZoneSidebar.tsx` `styleStations` → `hidingZonesGeoJSON` atom → `Map.tsx` `hiding-zones-*` layers): in the default **stations** style the overlay ships the centre POINTS (dots `hiding-zones-points` + name labels `hiding-zones-labels`, a symbol layer reading `name`, `minzoom 11`, overlap-culled, font MUST be a glyph-proxy fontstack = `Noto Sans Regular`) PLUS a single **`safeUnion`-ed** extent polygon (faint `hiding-zones-fill` + envelope `hiding-zones-line`) — unioning avoids the opacity COMPOUNDING that turned 4+ overlapping per-circle fills into an opaque wash. The **zones** style keeps individual circles (per-zone fill/outline). The tapped/selected zone gets a prominent gold highlight (`selected-zone-*` layers: ring + fill + dot, drawn from `selectedMapStation` + `hidingRadius`). Tapping a station opens `StationTransitCard`, which shows its aggregated **transit modes** (subway/tram/train/bus/ferry — inferred per merged OSM node by `inferStationMode` and unioned into `properties.modes`, threaded via `selectedMapStation.modes`). On the **seeker** surface (`allowEndgame` prop, passed only by `SeekerPage`) the card also offers a **"Start endgame here"** action once the hiding period is over and before the endgame is armed/the hider is found — the natural place to declare the seekers have entered the hider's zone (rulebook p43: the endgame begins when seekers reach the zone and are off transit). It calls the same `seekerStartEndgame()` as the `HiderTimer` button. Station de-duplication (`mergeDuplicateStation`, `stationManipulations.ts`, default-on via `mergeDuplicates` — persisted under key `mergeDuplicateStations`; the old `removeDuplicates` key was abandoned because long-time browsers had it stuck `false`) is union-find clustering keyed ONLY on a NORMALISED name (diacritics/brackets/mode-&-direction words stripped, so "Schous plass [Trikk]" ≡ "Schous plass") + nearness (`max(hidingRadius, 800 m)`, so a hub's spread-out same-named nodes like Oslo's Nationaltheatret still collapse). It is deliberately NOT proximity-alone: two differently-named stations that sit close (a train station and a separate bus stop) stay distinct so neither is hidden from selection.

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
build stamp. Current: `v616`. Use `git log` for the per-version detail;
the headline arcs since the v414 rulebook-audit pass:

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
  a solid rounded square. **Curses over the wire** (`curseReceived` in
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
- **A sent/answered question can't be deleted** (it would desync from
  the hider). As of v585 `cards/base.tsx` has **no delete control at
  all** — the earlier "swap the trash for a disabled lock in online
  games" treatment is gone; discarding an un-sent draft is the configure
  dialog's Cancel.
- **Debug overlay gallery** at `/debug/overlays` — every state of every
  overlay at once via a `preview` prop on each overlay (shadows its
  atoms, writes nothing global), plus a light/dark toggle. The debug
  panel (`DebugPhaseControls`) is also mounted on the `/welcome` landing
  page now.

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
3. Bump `APP_VERSION` in `src/lib/version.ts`
4. Push to master → Cloudflare auto-builds (2–3 min)
5. Check build logs in Cloudflare dashboard
6. If build fails: check TypeScript errors first (the historical SSR
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
