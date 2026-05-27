# JetLag Hide and Seek — Seeker's Companion App

## Project overview

This is Kalle's fork of [taibeled/JetLagHideAndSeek](https://github.com/taibeled/JetLagHideAndSeek), a seeker's map-elimination companion for the Jet Lag: The Game board game. The fork is deployed at **https://jetlaghideandseek.karl-mj-andersson.workers.dev** via Cloudflare Pages (auto-deploys on push to master, 2–3 min build).

GitHub: **github.com/kmja/JetLagHideAndSeek**

Stack: **Astro + React + TypeScript + Tailwind + shadcn/ui + Lucide + nanostores**. Hardcoded dark mode. Fonts: Poppins + Oxygen.

## Five question types

| Category | Color | Icon |
|---|---|---|
| Matching | `#7d8087` grey | `Equal` |
| Measuring | `#9dc99e` green | `Ruler` |
| Radius | `#f5a888` peach | `Radar` |
| Thermometer | `#f5d268` yellow | `Thermometer` |
| Tentacles | `#b09cd5` purple | `BrainCircuit` |

Defined in `src/lib/categories.ts`. One brand color: `bg-jetlag #1F2F3F`.

## Critical: SSR import constraints

**This is the most important architectural constraint.** Astro statically generates pages; `client:load` components are SSR-rendered server-side. **Never import leaflet or react-leaflet as a static value import in any component reachable from a `client:load` component.** Doing so causes `window is not defined` during build.

### SSR-rendered (client:load) components in index.astro
- `SidebarProviderL`, `SidebarTriggerL` (from `ui/sidebar-l`)
- `SidebarProviderR` (from `ui/sidebar-r`)
- `OptionDrawers`

`OptionDrawers` imports `LatitudeLongitude` from `LatLngPicker`. So any transitive import from `LatLngPicker` is also SSR-reachable.

### Safe leaflet importers (all within client:only trees)
- `Map.tsx` — direct `import * as L from "leaflet"` — safe because `<Map client:only />`
- `ZoneSidebar.tsx`, `DraggableMarkers.tsx`, `PolygonDraw.tsx` — all within client:only

### How to add leaflet-dependent code safely
If a component used by `LatLngPicker` or `OptionDrawers` needs leaflet:
- Use `React.lazy(() => import("./Component"))` + `<Suspense fallback={null}>` to break the static import graph
- Or use `import("leaflet")` inside a `useEffect` for the specific value you need
- `import type { X } from "leaflet"` is always safe (erased at compile)

**The sign of this bug:** build succeeds through client bundle, `h.astro` generates OK, then `index.astro` generation crashes with `window is not defined` at `leaflet-src.js:230`.

## Z-index ladder

```
Leaflet map tiles          ~100
Leaflet controls           ~400
Left sidebar               1030–1040
Bottom nav                 1040
Sheet overlay              1050
Sheet content              1051
Dialog overlay/content     1050
AlertDialog overlay        1055
AlertDialog content        1060
```

All popups/dialogs/drawers portal to `<body>`, NOT to `#map-modal-dialog-container-leaflet` (which is inside Leaflet's stacking context). If content appears behind the dark overlay, it's a z-index mismatch — check that overlay and content are both set explicitly.

## Portal patterns

- **Dialog, AlertDialog**: portal to body (modified in v12)
- **Select**: portal to body (modified in v10)
- **Sheet**: overlay z-1050, content z-1051 (fixed in v16 — default shadcn `z-50` was hidden behind overlay)
- **Drawer (vaul)**: uses `VaulDrawer.Portal` direct to body, z-1045

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

### Subtype picker (matching/measuring/tentacles)
`src/lib/subtypes.ts` defines `SUBTYPES` with `validSizes: GameSize[]` per entry. `-full` suffixed types (e.g. `aquarium-full`) are Small+Medium only — not available in Large games. Use `isSubtypeAllowed(value, size)` to filter dropdowns, `getSubtypes(categoryId, size)` for the step-2 picker tiles. Use `cleanDescription(desc)` to strip `" Question"` and `" (Small+Medium Games)"` suffixes from schema descriptions.

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
- **Transit lines**: OpenRailwayMap `tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png` — semi-transparent, best in Europe

### Thermometer question lifecycle
The schema (`src/maps/schema.ts`) has three extra fields on thermometer:
- `status: "started"|"finished"` (optional, defaults `"finished"` for backward compat)
- `distance: string` (preset signature like `"500m"`, set on finish)
- `startedAt: number` (Unix ms timestamp)

Flow: Tapping thermometer in AddQuestionDialog creates a question with `status:"started"`, `latA/lngA` = map center, `latB/lngB` mirror. No configure dialog — picker closes with a toast. Card shows live GPS distance + preset buttons when distance is reached. Uniqueness: each preset (`500m/1km/2km/5km/10km`) can only be finished once per game. `ThermometerOverlay` (mounted in index.astro) shows a floating pill on the map with live distance while a thermometer is started.

## Layout: index.astro

```astro
<SidebarProviderL client:load>
  <SidebarProviderR client:load defaultOpen={false}>
    <QuestionSidebar client:only />
    <main>
      <div> {/* map container */}
        <SidebarTriggerL client:load />     {/* top-left, desktop only */}
        <MapDisplayControls client:only />   {/* top-right */}
        <PlacePicker client:only />          {/* top-center */}
        <OptionDrawers client:load />        {/* bottom-right, desktop only */}
        <ThermometerOverlay client:only />   {/* overlay on map */}
        <Map client:only />
      </div>
    </main>
    <ZoneSidebar client:only />
    <BottomNav client:only />
    <GameSetupDialog client:only />
  </SidebarProviderR>
</SidebarProviderL>
```

## Bottom nav (mobile only)

Four buttons: **Questions** | **New question** (primary CTA, disabled during hiding period) | **Settings** | **More**

- Questions → opens QuestionSidebar (left drawer)
- New question → opens AddQuestionDialog (question picker)
- Settings → opens Sheet with game setup summary (play area / transit / size); "Edit settings" re-opens GameSetupDialog; "New game" resets completion + reopens wizard. During hiding period: shows live countdown timer (MM:SS), "End hiding period · Start seeking" button.
- More → opens Sheet with OptionDrawers (tutorial link, options, share, etc.)

The Settings icon animates: shows `Timer` icon + countdown in primary color during hiding period, `Settings` icon otherwise.

## Map display controls (top-right)

`MapDisplayControls.tsx` — vertical stack:
1. **Zone button** — `Target` icon + "Zone" label, opens ZoneSidebar
2. **Map/Satellite segmented switch** — both labels visible, active fills primary
3. **Transit toggle** — `TrainFront` icon + "Transit" label, filled when on

All three: `h-9` height, `shadow-md`, consistent border styling.

## AddQuestionDialog flow

1. Pick category (CategoryTile grid)
   - **Radius** → opens configure dialog (preset buttons + Other popover)
   - **Thermometer** → immediately creates started question, closes picker, toasts
   - **Matching/Measuring/Tentacles** → opens subtype picker (step 2)
   - **Radius/Tentacles/etc.** follow configure pattern
2. Subtype picker (step 2) — scrollable flex-col dialog, dark sidebar background
3. Configure dialog (pending question from `promoteLastQuestion`)

Thermometer is blocked if any other thermometer is already `status:"started"`.

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

## Map-based location picker (MapPickerDialog)

A lazily-loaded dialog (via `React.lazy` in `LatLngPicker`) with Leaflet map. Tap to place pin, "Use my GPS" button, "Set location" confirms. Uses same dark cartocdn tiles as main map. The lazy load means leaflet only downloads when the picker first opens, not on page load.

## Card base (cards/base.tsx)

Expand/collapse transition: `duration-200` (was 1000ms, was slow). Chevron rotation: `transition-transform duration-200`.

## Current deployment state

The user was last deployed at v15 at the time this document was written, with v16+v17+v18 batches ready to deploy. v18 is the SSR build fix (LatLngPicker lazy + MapPickerDialog default export). When deployed, the full feature set includes:

- Game setup wizard (3-step: play area, transit, game size)
- Hiding period countdown in bottom nav
- Thermometer started/finished flow with GPS distance tracking
- Map display controls (satellite, transit lines, zone trigger)
- Map-based location picker (lazily loaded)
- Game size filtering of question subtypes
- Snappy card expand/collapse (200ms)
- Tutorial removed

## Files changed per batch (for reference)

| File | Last meaningful batch |
|---|---|
| `src/lib/gameSetup.ts` | v15 |
| `src/lib/subtypes.ts` | v18-fix |
| `src/lib/categories.ts` | v7 |
| `src/lib/context.ts` | upstream (type-only leaflet import) |
| `src/maps/schema.ts` | v17 |
| `src/pages/index.astro` | v17 |
| `src/components/AddQuestionDialog.tsx` | v17 |
| `src/components/BottomNav.tsx` | v16 |
| `src/components/GameSetupDialog.tsx` | v15 |
| `src/components/LatLngPicker.tsx` | v18-fix |
| `src/components/Map.tsx` | v14 |
| `src/components/MapDisplayControls.tsx` | v16 |
| `src/components/MapPickerDialog.tsx` | v18-fix |
| `src/components/QuestionSidebar.tsx` | v16 |
| `src/components/ThermometerOverlay.tsx` | v17 |
| `src/components/cards/base.tsx` | v17 |
| `src/components/cards/radius.tsx` | v16 |
| `src/components/cards/thermometer.tsx` | v17 |
| `src/components/cards/matching.tsx` | v15 |
| `src/components/cards/measuring.tsx` | v15 |
| `src/components/cards/tentacles.tsx` | v15 |
| `src/components/ui/sheet.tsx` | v16 |
| `src/components/ui/dialog.tsx` | v12 |
| `src/components/ui/alert-dialog.tsx` | v12 |
| `src/components/ui/select.tsx` | v10 |

## Planned: multiplayer (not started)

Architecture decision: **Cloudflare Workers + Durable Objects** (one DO per game, WebSocket fan-out, server-authoritative). One game = one DO in memory with WebSocket connections from all participants.

Planned files:
- **Client**: `src/lib/multiplayer/{transport,session,gameStore,actions}.ts`, `src/components/{JoinGameDialog,InviteSheet,PresenceIndicators}.tsx`
- **Server**: `worker/{index,GameRoom,schema}.ts`, `wrangler.toml` updates
- **Shared**: `protocol/` (wire types, imported by both client and server)

Open decisions before starting: PartyKit vs raw Workers+DO, persistence TTL, max participants, spectator mode, where rule-checks happen (client/server/both).

Sequence: server skeleton → identity+transport → `questions` store bridge → host flow → join flow → live updates → presence.

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
build stamp. Current: `v21` (overlay reset on new game/round/settings +
opt-in adjacent-areas step).

## Dev workflow

1. Edit files
2. Bump `APP_VERSION` in `src/lib/version.ts`
3. Push to master → Cloudflare auto-builds (2–3 min)
4. Check build logs in Cloudflare dashboard
5. If build fails: check for `window is not defined` (SSR leaflet import) or TypeScript errors first

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
