# Overnight multiplayer run — review notes

This file is uncommitted. It exists so you can scan what landed
before deciding whether to commit.

**Updated:** abuse protection + public-release hardening landed on
top of the original drop. See **"Operational hardening"** section
near the bottom for what changed there, and **MULTIPLAYER.md** for
the public-launch checklist.

## What got built

A complete real-time multiplayer backend + client integration,
behind a "Play online" toggle. Local mode continues to work
unchanged for anyone who doesn't opt in.

See **MULTIPLAYER.md** for the deploy + architecture deep-dive. The
short version:

- **Cloudflare Worker + Durable Object** holds one room per active
  game, in memory only, evicted after 30 min idle.
- **WebSocket transport** with auto-reconnect, send-queue while
  offline, 25 s ping cadence.
- **Wire protocol** in `protocol/`, shared between Worker and
  client so TypeScript enforces shape parity.
- **Client store bridge** wraps existing seeker/hider verbs so the
  same calls (`addQuestion`, `markRepliedInInbox`, "Found them",
  setup-wizard finish) automatically sync over the wire when in
  online mode.
- **UI**: unified host/join dialog, invite panel with code +
  participant roster, presence chip above the bottom nav.

## Files added

```
protocol/
  index.ts             ← barrel
  messages.ts          ← discriminated wire-protocol types
  state.ts             ← canonical GameState shape, transport invariants
  version.ts           ← protocol version constant

worker/
  GameRoom.ts          ← Durable Object (650+ LoC, the heart of the server)
  index.ts             ← request router, code gen, CORS
  tsconfig.json        ← worker-specific (Cloudflare types, no React)

src/lib/multiplayer/
  transport.ts         ← WebSocket wrapper, reconnect, ping
  session.ts           ← persistent identity + session atoms
  store.ts             ← outbound verbs + inbound dispatch (bridge layer)
  types.ts             ← re-exports + transport status type

src/components/multiplayer/
  JoinGameDialog.tsx   ← host / join unified modal
  InviteSheet.tsx      ← InvitePanel — code, share, roster, leave
  PresenceIndicators.tsx ← floating "Online · 3/4" chip
  MultiplayerBoot.tsx  ← mount-once bridge install + resume

wrangler.toml          ← Worker config + DO binding
MULTIPLAYER.md         ← deploy guide + architecture notes
OVERNIGHT_SUMMARY.md   ← this file
```

## Files modified

- `package.json` — **unchanged from HEAD baseline**. The worker
  package now lives in its own `worker/package.json` (see "Worker
  package isolation" below) so the main Astro app's bundling stays
  uncontaminated.
- `tsconfig.json` — added `@protocol/*` path alias, excluded
  `worker/` (worker has its own tsconfig).
- `src/components/AddQuestionDialog.tsx`, `src/components/Map.tsx`
  — call `seekerAddQuestion` from the bridge instead of the bare
  `addQuestion`. No behavior change in offline mode.
- `src/components/HiderView.tsx` — `markRepliedInInbox` now also
  calls `hiderAnswerQuestion()` to push the answer over the wire.
- `src/components/BottomNav.tsx` — added imports + "Play online"
  CTA + InvitePanel embed in More sheet, PresenceChip above nav,
  `seekerMarkFound()` alongside the local "Found them" handler,
  JoinGameDialog mount at root.
- `src/components/GameSetupDialog.tsx` — `hostPushSetup()` called
  after handleFinish and handleSaveEdits.
- `src/pages/index.astro`, `src/pages/h.astro` — mount
  `MultiplayerBoot` so the bridge installs on every page load.

## What it does NOT do

These are deliberate scope cuts, per our discussion:

- **No live position sharing.** The endgame still shows "seeker
  position not connected yet."
- **No curse cast over the wire.** Curses still use the share-link
  flow.
- **No spectator mode.** Everyone is either a hider or a seeker.
- **No durable storage.** Game state lives in DO memory only —
  evicted after 30 min idle. No history, no rematch with a saved
  code.
- **Trust model is client-authoritative.** The Worker enforces
  transport invariants (max participants, well-formed messages,
  one hider per room, idempotency by question key) but not
  rule-level constraints like radius bounds.

## To deploy this

```bash
pnpm wrangler login           # one-time
pnpm wrangler deploy          # ships the Worker
```

Then bake the resulting URL into `PUBLIC_MULTIPLAYER_URL` (Pages
env var for production, `.env` for local dev). Full step-by-step
in `MULTIPLAYER.md`.

If you'd rather just commit the code without deploying yet, the
client defaults `PUBLIC_MULTIPLAYER_URL` to
`https://jlhs-multiplayer.kmja.workers.dev` — a placeholder that
matches what you'd get from `wrangler deploy` if your Cloudflare
account's workers.dev subdomain is `kmja`. Update the default in
`src/lib/multiplayer/store.ts` (`getMultiplayerOrigin()`) if your
subdomain is different.

## Typecheck status

- `pnpm tsc --noEmit` (root) — **17 pre-existing errors, 0 new**.
  All the errors are in files I didn't touch
  (`cards/{matching,measuring,tentacles}.tsx`, `TutorialDialog.tsx`,
  `hiderRole.ts`, `seekerInbound.ts`, and three pre-existing
  errors in `AddQuestionDialog.tsx`).
- `pnpm tsc --project worker/tsconfig.json --noEmit` — **clean**.

## How to test before committing

1. **Read the doc:** `MULTIPLAYER.md` has a "Quick sanity test"
   section at the bottom that walks through the host-join flow.
2. **Local-only first:** run `pnpm dev` and verify the existing
   offline flow still works (host doesn't toggle on automatically;
   I added the toggle to the More sheet). The "Play online" button
   should be visible but not pressing anything else should be
   different.
3. **Worker via wrangler dev:**
   ```bash
   pnpm wrangler dev      # in one shell
   PUBLIC_MULTIPLAYER_URL=http://localhost:8787 pnpm dev   # in another
   ```
   Open two browser tabs at `http://localhost:4321`. Host in one,
   join in the other. Add a question on the seeker side, watch it
   land on the hider side.

   **Caveat:** `wrangler dev` requires the `workerd` postinstall
   build script. If pnpm hasn't approved it (`pnpm approve-builds`,
   select `workerd`), `wrangler dev` will fail. `wrangler deploy`
   works regardless because the build happens server-side.

4. **Deploy and test on two real devices:** the more useful test.
   See "Quick sanity test" in `MULTIPLAYER.md`.

## Known rough edges I noticed during the build

These would be worth a follow-up pass, but the user-visible flows
work:

- `MultiplayerBoot` runs `tryResumeFromPersistent()` on every page
  mount, but the early-resume goes through whether the user has
  decided they want to be in the game or not. If you "Leave game"
  on a different tab the persistent `multiplayerEnabled=true` and
  the next mount will rejoin you. Solved by checking
  `currentGameCode` (we do) but the failure mode is "I left, I
  refresh, I'm back in" which may not match user intent. Adding
  a "remember this disconnect" flag is a 5-min fix.
- `GameSetupDialog.handleSaveEdits` clears `questions.set([])` when
  the user changes the play area mid-game. In online mode this
  doesn't propagate to peers — the seeker's local store goes empty
  but the hider's stays. Pushing a "wiped" setup is in
  `hostPushSetup` but the empty questions list isn't part of the
  wire protocol. Add a "clearQuestions" wire message if you want
  parity here.
- The auto-redirect on the hider home (from earlier today) doesn't
  fire when the inbox is empty but the seeker is about to push a
  question over the wire. In online mode this works fine because
  the inbox fills as soon as `qAdded` lands, which triggers the
  redirect effect. Just noting it.
- Reconnect-state-reconciliation is best-effort: the welcome
  snapshot rebuilds the local store wholesale, which means any
  per-device-only state (the hider's hand of cards, hiding zone
  pick) is preserved (those stores aren't in the protocol), but
  the canonical ones (questions, roundFoundAt) snap to whatever
  the server has. Should be correct in practice but I haven't
  hammer-tested.

## Operational hardening (added later)

After discussing public release, I added the following on top of
the original drop. See **MULTIPLAYER.md → "Going public —
operational hardening"** for the full reference. Short version:

| Defense | Where |
|---|---|
| Per-IP rate limit on POST /games (6/min) | `worker/index.ts` |
| Per-IP rate limit on WS upgrades (30/min) | `worker/index.ts` |
| Hard 8 h room lifetime ceiling | `worker/GameRoom.ts` |
| Max questions per room (200) | new constant in `protocol/state.ts` |
| Max WebSocket message size (64 KB) | new constant in `protocol/state.ts` |
| Sanitized error messages | `worker/GameRoom.ts` |
| Friendly client-side 429 handling | `src/lib/multiplayer/store.ts` |
| "Report an issue" link on `internal` errors | `JoinGameDialog.tsx` |
| Going-public checklist + billing-alert setup docs | `MULTIPLAYER.md` |

The hardening is per-Worker-isolate (so a multi-PoP attack could
exceed it), which is intentional — Cloudflare's account-level
DDoS protection handles broader fanout, and the absolute ceiling
is the free-tier quota. The combination means a runaway client or
single-source abuser gets shut down, but you also can't be billed
for unexpected traffic without seeing a quota alert first.

## Worker package isolation

The worker lives as a **separate npm package** under `worker/`, with
its own `package.json`, `tsconfig.json`, and (after `pnpm install`)
its own `node_modules/`. Reasons:

- Wrangler depends on `workerd` (the Cloudflare runtime) and a
  newer `esbuild` than Astro uses. Mixing them at the root caused
  Vite to bundle React twice during dev — every component threw
  "Invalid hook call" and the page went blank.
- The worker package is `--ignore-workspace` (run install commands
  from inside `worker/`), so its deps are fully isolated.
- Deploy / dev commands all live in `worker/package.json` scripts:
  `pnpm run deploy`, `pnpm run dev`, `pnpm run typecheck`.

See `MULTIPLAYER.md` for the deploy walkthrough.

## Dev gotcha: PWA service worker can cache stale builds

`astro.config.mjs` has `devOptions.enabled: true` on the PWA
plugin — convenient for testing install-prompts but it also
registers a service worker in dev that can outlive the dev server
and serve cached chunks pointing at old Vite hashes. After any
significant deps change (or after the lockfile churns), the SW can
make the preview look completely broken even though the dev server
is fine.

**Fix when it happens:** in the broken tab's DevTools console:

```js
(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
  location.reload();
})();
```

Same procedure documented in `MULTIPLAYER.md → "If the dev preview
goes blank after a deps change"`. The first time the multiplayer
diff hit your dev preview, this is what was going wrong.

## Bottom line

The MVP scope is in. Deploy the Worker, point `PUBLIC_MULTIPLAYER_URL`
at it, and "Play online" should give you a working two-device game
where questions and answers sync in real time.

For going public to the Jet Lag community: read
**MULTIPLAYER.md → "Going public — operational hardening"** end to
end, set up the billing alerts, and run the smoke test from two
real devices before sharing the link. The defenses are layered so
worst-case is "new multiplayer games get blocked for a few hours";
existing games and local-mode play stay unaffected.
