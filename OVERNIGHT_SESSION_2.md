# Overnight session 2 — recap

Started by tackling the recurring "Claude Code preview shows an empty
page" issue as P0 (you said you couldn't test otherwise), then moved
through performance, energy use, code hygiene, and UX polish.

## What landed

### 1. Dev preview empty page — fixed (P0)

**Root cause:** Vite's dev-mode optimizer pre-bundles `react` /
`react-dom` into `node_modules/.vite/deps/`, but it doesn't always
include packages that import React from their own location in
pnpm's symlink tree. When that happens, the app ends up with two
React module instances — React 19 detects this on the first
`useSyncExternalStore` call and throws "Invalid hook call (3. more
than one copy of React)". Every island using `useStore` unmounted,
leaving a blank page.

**Fix** (`astro.config.mjs`):

- `vite.resolve.dedupe: ["react", "react-dom"]` — forces every
  `import 'react'` Vite resolves to land on the same module
  regardless of which package requested it. Standard fix for
  pnpm-symlink / monorepo React duplication. Survives optimizer
  re-runs.
- `vite.optimizeDeps.include` — explicit pre-bundle list for every
  Radix primitive, `lucide-react`, `react-toastify`, `vaul`, `cmdk`,
  and the three `nanostores` packages. Each gets pre-bundled with
  the deduped React already wired in.

Verified: after a clean cache wipe + dev-server restart + tab
reopen, the seeker page renders 26 islands and stays rendered.
The GO GO GO moment fires correctly on first boundary load.

Production builds were never affected (Rollup always dedupes
through a single React at build time).

### 2. Battery drain — visibility-aware timers

The handful of always-on 1 Hz `setInterval` calls behind countdowns
and elapsed-time displays were keeping the CPU woken once per
second even with the tab hidden. Players run the app for hours on
mobile so that idle drain matters.

New `src/hooks/useVisibleInterval.ts`:

```ts
useVisibleInterval(cb, intervalMs, enabled?);
```

- Only ticks while `document.visibilityState === "visible"`.
- Re-syncs on `visibilitychange` so displayed values jump to truth
  the instant the tab returns (not after a tick).
- `enabled=false` short-circuits to a no-op so the timer is
  cheap when not meaningful.

Applied to:
- `BottomNav` — hiding-period countdown
- `HiderTimer` — countdown + elapsed
- `HiderHome` — atom-feeding tick
- `MapLoadingOverlay` — elapsed/ETA labels
- `PendingAnswerOverlay` — answer-window countdown
- `cards/base.tsx` — 60 s relative-timestamp tick + 1 Hz answer
  countdown
- `Map.tsx` — defensive layer-cleanup watchdog (also bumped 1 Hz
  → 5 s; the 1 Hz polling rate was overkill for a safety sweep)

### 3. Boundary fetch crash + invalid-geometry handling

You hit `"Input geometry is not a valid Polygon or MultiPolygon"`
followed by a cascade of `"Cannot use 'in' operator to search for
'features' in null"`. Root cause: a previous optimization changed
the Overpass query to `out skel geom` which strips OSM tags from
the response, but `osmtogeojson` needs the relation's
`type=boundary` / `boundary=administrative` tags AND each member
way's `role=outer|inner` to assemble a MultiPolygon. Without
those, it fell back to LineString output and `turf.union` blew up.

Fixed:
- Reverted to `out geom` (tagged) so polygon assembly works.
- `safeUnion` call site now filters to actual Polygon /
  MultiPolygon features. A single bad way can't kill the pipeline
  anymore.
- `turf.difference` returning `null` (subtractions covered the
  entire base) preserves the original boundary instead of
  throwing.

### 4. Dead code cleanup

Removed orphans that weren't imported from anywhere (verified by
grep + dynamic-import scan):
- `MapPickerDialog.tsx` — superseded by `InlineLocationPicker`.
- `PlacePicker.tsx` — superseded by the wizard's play-area step
  + `PlayAreaExtensions`.
- `TutorialDialog.tsx` — tutorial flow removed; `HowToPlaySheet`
  is the replacement.
- `multiplayer/JoinGameDialog.tsx` — replaced by
  `OnlinePlaySection` embedded in Game Settings.

Tidied bare `console.log(error)` → descriptive
`console.warn("X failed:", e)` across `cache.ts`, `Map.tsx`,
`OptionDrawers`, `ZoneSidebar`, so production logs read more
usefully.

Total removal: ~2100 lines of dead code.

### 5. UX polish

- **Toast positioning**: `ToastContainer` had no defaults. Now
  `position="top-center"`, `autoClose=4000`, `theme="dark"`,
  `newestOnTop`, `limit=4`, `pauseOnFocusLoss=false`. Stops toasts
  lingering forever and stops them sitting under the iOS Safari
  notch on top of the Hider timer / Map options chip.
- **Loading overlay title**: was using OSM's raw `name`
  field — "Loading Falu kommun" / "Loading Stockholm Municipality"
  — which read as noise. Now prefers the wizard's friendly
  `displayName` and strips common admin suffixes (`kommun`, `län`,
  `municipality`, `county`, `district`, `prefecture`, `province`).
  Reads as "Loading Falu" / "Loading Stockholm".
- **Hider pre-game empty state**: was a one-line "your timer will
  appear here" notice on an otherwise blank page — the most
  common first-multiplayer landing surface gave no context. Now
  includes a "What happens next" three-step explainer so a player
  who just joined an invite link knows what's coming.
- **New-game reset hygiene**: three reset paths (BottomNav,
  HiderHome, StaleSessionPrompt) were leaving
  `pendingHidingDurationMin` set, so the next boundary load would
  replay the previous game's hiding-period kickoff. All three
  now clear that store alongside the rest.

## Commits pushed

```
42d45a9 chore: remove orphan JoinGameDialog
1085f14 fix: clear pendingHidingDurationMin in every new-game reset path
b7bb8ef fix(boundary): revert "out skel geom" and harden against bad features
d8c6edf feat(ux): richer hider pre-game empty state
d6e8b91 fix(ux): toast positioning + friendlier loading title
4f7067f chore: remove orphan components + tidy bare console.logs
e2b8383 perf(battery): visibility-aware 1Hz timers across the app
1b88f48 fix(dev): resolve.dedupe react + expanded optimizeDeps include
```

## Things I deliberately didn't touch

- The big `useStore` count in `BottomNav` (9) / `Map.tsx` (15)
  could theoretically be reduced for fewer re-renders, but the
  components themselves are mostly static layout with conditional
  sub-content. The DOM diff per re-render is small, so the
  effort-to-payoff isn't there compared to the timer / boundary
  work above.
- The `questionModified` / `triggerLocalRefresh` "mutate then
  force refresh" pattern is technical debt indicating the
  question store isn't being used idiomatically (nanostores
  expects immutable updates). Refactoring to immutable updates
  would touch dozens of files. Out of scope for the overnight
  window.
- The `Map.tsx` is large (~1000 lines) but each section has clear
  ownership. Splitting it would be a substantial refactor.

## To verify in the morning

1. **Open Claude Code preview** — should render the seeker page
   (or whatever your last state was) and stay rendered, no
   blank-page flicker. Specifically the "reopen the preview tab"
   scenario you mentioned should work now.
2. **Pick a country play area** (Sweden, Norway, etc.) — the
   loading overlay should show phases, the boundary should
   actually load and union into the map (no "Input geometry is
   not a valid Polygon" cascade), the GO GO GO moment fires.
3. **Verify the hider pre-game state** at `/h` looks more welcoming
   than the old one-liner.
4. **Lock the phone for a few minutes** during a hiding-period
   countdown — the timer should resume to the correct value the
   instant you unlock, not after a tick.

## Open / deferred for later

- Persistent "Falu kommun, Dalarna, Sweden" displayName in
  `playArea` — `determineName` produces this; the loading-overlay
  cleanup happens at display time. If we wanted clean storage
  too, `determineName` itself could strip suffixes.
- The Cloudflare dashboard "Add variable: PUBLIC_MULTIPLAYER_URL"
  step from the previous session is still required for production
  multiplayer.
- Some pre-existing TypeScript errors in `cards/tentacles.tsx`,
  `cards/matching.tsx`, `lib/hiderRole.ts`, etc., are unrelated to
  this session but still present. `pnpm exec tsc --noEmit` would
  catch them; the build (which uses Vite's looser TS handling)
  ignores them.

## Tasks remaining

None in-progress. Task list shows everything from this session
completed.
