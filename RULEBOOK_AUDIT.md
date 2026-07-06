# Rulebook audit — status

A pass over `src/content/rulebook.md` vs. the app's enforced mechanics,
fixing rules that were unenforced, broken, or mis-stated. Items are
grouped by severity. Each fixed item lists the commit/version it
shipped in.

## A — incorrect / broken mechanics (all fixed)

### A1 · Curse of the Overflowing Chalice — flavour-only → enforced ✅ v410
The curse did nothing beyond a toast. It now arms a real draw boost:
the next three question rewards each draw one extra card (keep count
unchanged), so per-category budgets become Matching/Measuring 4-keep-1,
Thermometer/Radar 3-keep-1, Photo 2-keep-1, Tentacle 5-keep-2.
- `chaliceDrawsRemaining` atom + `activateOverflowingChalice()` in
  `hiderRole.ts`; consumed in `presentDraw` (the single reward
  chokepoint).
- `CastCurseDialog` arms it on each landing branch + toasts the hider.
- `rulebook.md` text corrected ("next three questions", not "rest of
  the round").
- Tests: `tests/chalice.test.ts`.

### A2 · Move powerup — toast-only → pause / freeze / re-anchor ✅ v411
Move only discarded the hand. It now drives the full mechanic:
- `playMovePowerup()` in `roundActions.ts` banks survived time
  (`hiddenCreditMs`), starts a fresh 10/20/60-min hiding period
  (`MOVE_PERIOD_MINUTES`), freezes seekers (`seekersFrozenUntil`),
  and clears the old zone/spot so the hider re-picks. No-ops in the
  endgame or with no running clock; syncs peers via `hostPushSetup`.
- Scoring reads `(foundAt − hidingEndsAt) + hiddenCreditMs` at every
  site so a Move pauses rather than discards time.
- `SeekerFrozenBanner` shows a live freeze countdown.
- Tests: `tests/movePowerup.test.ts`.

### A3 · Thermometer presets ignored game size → size-gated ✅ v409
15 km is Medium+Large only, 75 km is Large only; `StartedBody` filters
`THERMOMETER_PRESETS` by the live game size for reached / next-target /
render. (`cards/thermometer.tsx`.)

### A4 · Photo answer window fixed at 10 min → 20 min in Large ✅ v409
New `answerWindowMs(category, size)` single source of truth
(`gameSetup.ts`); `PendingAnswerOverlay` and `cards/base.tsx` both
read the live size.

## B — unenforced economy rules

### B1 · Late answers — no pause, full reward → paused + no card ✅ v413
Rulebook p61: a question not answered within its window pauses the
hider's clock and earns no card.
- `hiddenDebitMs` atom accumulates the overtime; `settleLateAnswer()`
  banks it. Wired into `ShareBackRow` (text + tentacles) and
  `recordPhotoAnswerDraw` (photo); the draw is skipped when late.
- Scoring subtracts `hiddenDebitMs` everywhere it adds the credit.
- Tests: `tests/lateAnswer.test.ts`.

### B3 · Discard casting costs unenforced → enforced ✅ v412
Curses costing "Discard N cards / a powerup / a time bonus / your
hand" now require the hider to pay before casting.
- `src/lib/castingCost.ts`: `parseDiscardCost` + `eligibleForDiscardCost`
  + `canPayDiscardCost` (pure, tested).
- `CastCurseDialog` inline cost picker; cast/copy gated until paid; an
  un-payable cost blocks the cast. Selected cards discarded on each
  landing branch.
- Tests: `tests/castingCost.test.ts`.

### B2 · Repeat questions hard-blocked → pay-double per rulebook ✅ v415
Rulebook p65: a question CAN be asked again; the seekers "pay its
cost twice" — the hider performs the draw-keep cycle twice (draw 3
keep 1, then draw 3 keep 1 again — NOT draw 6 keep 2). A third ask
triples it, and so on.
- `questionIdentity(id, data)` + `priorAnsweredCount(key, identity)`
  in `hiderRole.ts` derive the per-question identity (radius preset,
  thermometer preset, matching/measuring/tentacles/photo subtype).
- `ShareBackRow` and `recordPhotoAnswerDraw` loop `presentDraw`
  `priorAnswered + 1` times, with a toast announcing the N×.
- `pendingDrawQueue` lets multi-cycle picks queue cleanly behind the
  active one — `resolvePendingDraw` shifts the next entry in, so the
  picker re-opens for each cycle.
- Seeker pickers (AddQuestionDialog subtype tile, ThermometerConfigure)
  now show a "Repeat · N×" badge instead of a hard block; radius
  preset gate likewise softens.
- House rule `askOncePerQuestion` (Settings → House rules) restores
  the old hard block for tables that prefer it.

## C — house rules (now opt-in)

### C1 · Question/curse alternation — moved to House Rules ✅ v415
v395 added a deliberate alternation constraint not in the printed
rulebook. The rule itself is now a **House Rule toggle**
(`alternateQuestionTypes`, off by default → rulebook). When on, the
AddQuestionDialog category tiles re-enable the v395 alternation gate.

### C2 · Zone-radius elimination buffer ✅ v600
The rulebook scopes radar/thermometer/measuring to the hider's **exact
location at answer time**, not their zone (radar is explicit: p234 — a
radar covering part of the zone but not the hider's point is a *miss*).
Because the hider may roam their whole zone until the endgame
(p347/p351), an unlucky sequence of relative answers given from
different points inside the zone can geometrically carve away the true
hiding spot. The elimination engine treats every answer as an exact
point constraint, so by default it can over-eliminate this way.

New **House Rule toggle** `zoneRadiusBuffer` (off by default → rulebook).
When on, each relative cut is widened by the hiding-zone radius
(`hidingRadius`): a region is only eliminated when it's inconsistent for
the ENTIRE zone (no point within the radius could have produced the
answer). Implementation:
- `zoneBufferKm()` (`src/lib/houseRules.ts`) returns the active buffer in
  km (0 when the rule is off, so the engine is byte-identical to before).
- `modifyMapData` (`geo-utils/operators.ts`) gained an optional
  `zoneBufferKm` arg: keep-inside dilates the kept region outward;
  keep-outside erodes the EXCLUDED region inward (full erosion → nothing
  eliminated). `radius.ts` + `measuring.ts` pass it through;
  `thermometer.ts` buffers the chosen Voronoi half directly (it doesn't
  use `modifyMapData`). Hider auto-grading + planning previews are
  untouched — only the seeker's elimination widens.
- Tests: `tests/operators.test.ts` (widen / shrink / full-erode / no-op).
- The trade-off is a looser map (eliminates a little less per question);
  the physical win condition (enter zone → freeze spot → find hider)
  remains the ultimate safety net either way.

### House rules are now host-synced via the lobby ✅ v601
House rules moved out of the per-device Settings drawer into the
**lobby** (`GameLobbyDialog` → `HouseRulesSection`), because they govern
the whole table, not one device. They're **host-authoritative**: the
host edits them in the lobby (guests see them read-only), which writes
the local atoms and pushes the whole setup via `hostPushSetup`. The new
optional `SetupState.houseRules` field rides the existing `start` /
`setupChanged` / welcome-snapshot path (the server treats setup as an
opaque blob, so no worker change), and every device mirrors it back onto
its atoms in `multiplayer/store.ts` (`applyHouseRules`). Solo play keeps
local editing (the lone player is the host). Back-compat: setups from
older deployments arrive without the field and each device keeps its
local values.

## D — second audit pass (v671, four parallel audits: lifecycle / questions / economy / self-hosting)

Self-hosting verdict: in a warm city, game-time play makes ZERO direct
un-proxied external calls (Photon geocoding, basemap, tiles, journey all
worker-proxied). Remaining third-party touches are opt-in Thunderforest
(user key), the `polygons.osm.fr` boundary fallback for un-prewarmed
cities, and Pastebin config-share — none load-bearing.

### D1 · Time-bonus scoring was INVERTED + omitted from the leaderboard ✅ v671
Rulebook p79: time-bonus cards held at round end are **added** to the
hider's time (longest single hide wins). The app SUBTRACTED them in
`FinalScoreBanner` (`finalMs = seek − bonus`, labelled "−Nm") and the
persisted `roundLog` / `EndOfRoundDialog` leaderboard ignored them
entirely — so the hider's banner and the winner ranking disagreed.
- `FinalScoreBanner` now `seek + bonus` ("+Nm"); copy corrected (it also
  wrongly claimed "cumulative scoring" — rulebook is best-single-round).
- `startNewRound` folds `tallyTimeBonusMinutes(hand,size)` into the
  appended `roundLog.hidingMs`; `EndOfRoundDialog`'s live current-round
  figure adds it too. Read from the local hider hand (intact until the
  reset), so correct on the hider's device + all solo play. **Known
  multiplayer limitation:** a seeker-initiated new-round on a remote
  device sees an empty local hand → 0 bonus folded; a synced found-time
  bonus capture is the proper fix (deferred).

### D2 · Tentacle radius ignored the rulebook's fixed 2 km / 25 km ✅ v671
Every tentacle inherited the schema's 15 km default, so a "Museum within
2 km" was built + eliminated as 15 km. `runAddTentacles`
(`AddQuestionDialog`) now stamps `TENTACLE_RADIUS_KM` per tier (2 km:
museum/library/cinema/hospital; 25 km: metro/zoo/aquarium/amusement park).

### D3 · Guest round-reset drifted from the host reset ✅ v671
`applyRoundStarted` (multiplayer guest path) reset only ~9 of the ~15
per-round atoms — stale curses / Move-freeze / credit-debit /
spotty-memory / celebration-dedupe carried across rounds on guests (and
none ride `SetupState`, so nothing else fixed them). Extracted a single
`resetSharedRoundState()` (`src/lib/roundReset.ts`) now used by
`startNewRound`, `startNewGame`, AND `applyRoundStarted` so the three
paths can't diverge again.

### D4 · Matching/Measuring were size-gated (app deviation) → all 20/20 at every size ✅ v671
The "-full" POI matching/measuring variants were Small+Medium-only, an
app deviation from the rulebook (which gates only Thermometer/Photo/
Tentacle by size). Lifted to `ALL` for full parity, per the v627 "offer
exactly the rulebook's questions" intent.

### D5 · Grace = forfeit → rulebook auto-commit ✅ v671
Rulebook p341: "if the hiding period ends and you're somewhere else,
that's where your hiding zone is." The app forfeited the round after a
5-min grace. Now when the grace window closes with no zone, HiderHome
AUTO-COMMITS the hider's nearest transit station (`fetchAreaStations`
from live GPS) as the zone; forfeit remains only the technical fallback
when no station can be resolved (no GPS / empty area). Grace-phase copy
updated (warning tone, "your nearest station becomes your zone").

### D6 · Hand-limit-6 enforcement — advisory → forced ✅ v672
Rulebook p71/p363: over the hand limit, the hider must immediately
play/discard down to it. Was an ignorable "over cap" banner. New
`HandLimitEnforcer` (mounted on `HiderPage`) is a non-dismissible modal
that takes over whenever `hiderHand.length > hiderHandLimit`, listing the
hand with per-card Discard buttons, and auto-closes the instant the hand
is back at/under the limit (7/8 with the hand-expand powerup).

### D7 · Manual game pause ✅ v672
Rulebook "General Tips": you can always pause; every in-game timer stops;
resume from the same spot. New `manualPausedAt` atom (`gameSetup.ts`)
folded into `effectiveHiddenDebitMs` (so scored time freezes live, same
mechanism as the location-share pause) + `src/lib/gamePause.ts`
(`pauseGame`/`resumeGame`). Resume repays the paused span correctly by
phase: a HIDING-period pause shifts `hidingPeriodEndsAt` forward (the
countdown resumes where it stopped); a SEEKING pause banks into
`hiddenDebitMs`; pending answer-window `arrivedAt` timestamps and any
active Move `seekersFrozenUntil` shift forward too. UI: a "Pause game"
button in `AppSettingsDrawer` (in-game only) + a full-screen
`GamePausedOverlay` curtain with a live pause clock + Resume, mounted on
both pages. Reset per round in `resetSharedRoundState`. **Local-scoped**
(freezes this device's clocks; a synced pause would ride `SetupState`) —
fine for solo; the physical "everyone stays put" rule is player-enforced.

### D8 · 10-min new-hider planning window — already satisfied ✅ v672
No code change: after a round ends, `startNewRound` nulls
`hidingPeriodEndsAt` (staging `pendingHidingDurationMin`), so the app
returns to the lobby's "Start round" button and the new hider plans, then
taps Start when ready. This unbounded start-when-ready window covers the
rulebook's "up to 10 minutes" (a soft cap to keep a tabletop moving, not
a hard rule the app must enforce).

### D9 · Randomize repeat-cost accounting was inverted ✅ v673
Rulebook p376: after a Randomize the ORIGINAL question is NOT considered
asked (re-askable at its original cost) and the SUBSTITUTE IS. The app
had it backwards. Root cause was path-dependent: the multiplayer/demo
echo (`GameRoom.ts` / `demoBroker.ts`, `{...q.data, ...answer}`) already
merged the substitute's identity into the question data, so ONLINE play
was effectively correct; but SOLO-no-multiplayer never echoes, so the
hider's optimistic `markHandled` kept the ORIGINAL identity.
- **Hider side**: `markHandled` (`HiderView.tsx`) takes an optional
  `dataPatch`; the spatial Randomize passes the substitute's identity
  fields (the swapped `type`/`locationType`/`radius`+`unit` from
  `computeRandomizedAnswer`), re-keying the answered inbox entry to the
  substitute — exactly what the online echo already does, so solo/online
  now match. `questionIdentity`/`priorAnsweredCount` therefore count the
  substitute as asked and leave the original re-askable. Veto is
  untouched (a vetoed question IS considered asked → keeps its identity).
  Photo Randomize already swapped `data.type` in place, so it was fine.
- **Seeker side**: the picker's repeat/hard-block sets
  (`subtypeCounts`/`usedSubtypes` in `AddQuestionDialog`, radar
  `usedSigs` in `cards/radius.tsx`, thermometer `sigCounts`) now SKIP
  entries with `data.randomizedAway === true` — the v597 split keeps the
  original as a `randomizedAway` marker (eliminates nothing), which must
  not count as asked either.
- Tests: `tests/repeatQuestion.test.ts` (+2 — substitute counts, original
  stays fresh; radar preset swap).

### Still open (LOW severity, not selected)
- Duplicate's passive end-of-round time-bonus doubling not modeled (an
  unplayed Duplicate held at round end should copy a time bonus). Manual
  Duplicate works; only the auto-tally of a held one is missing.
- "Only one active ask/transit-blocking curse at a time" unenforced.

## Notes
- Scoring formula (v671): the hidden time
  `max(0, (foundAt − hidingEndsAt) + hiddenCreditMs − hiddenDebitMs)`
  PLUS `tallyTimeBonusMinutes` (time bonuses ADD; longest hide wins).
- `hiddenCreditMs` / `hiddenDebitMs` / `seekersFrozenUntil` and every
  other per-round atom are reset by the shared `resetSharedRoundState()`
  used by `startNewRound`, `startNewGame`, and the multiplayer guest
  `applyRoundStarted`.
