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

## Notes
- All scoring now flows through one formula:
  `max(0, (foundAt − hidingEndsAt) + hiddenCreditMs − hiddenDebitMs)`,
  then time-bonus minutes are subtracted for the hider's final tally.
- `hiddenCreditMs` / `hiddenDebitMs` / `seekersFrozenUntil` are reset
  by both `startNewRound` and `startNewGame`.
