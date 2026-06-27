# Multiplayer — deploy guide & architecture notes

The multiplayer backend is a **Cloudflare Worker** that holds one
**Durable Object** per active game. The client talks to it via
WebSocket. No accounts, no persistent storage — game state lives in
DO memory and evicts after 30 min of zero connections.

## One-time deployment

You'll need a Cloudflare account (the same one the frontend Worker is
deployed under is fine) and `pnpm`. Wrangler and `@cloudflare/workers-types`
live in **`worker/package.json`** (a separate npm package from the
root) so their heavy esbuild/workerd dependency tree doesn't disturb
the main Vite SPA's bundling. Always run wrangler commands from
the `worker/` directory.

1. **Install the worker package's deps** (only required once per
   machine, plus after any change to `worker/package.json`):

   ```bash
   cd worker && pnpm install --ignore-workspace
   ```

   The `--ignore-workspace` flag is important — without it pnpm
   tries to hoist into the root's `node_modules` and pollutes the
   client install.

2. **Log in to Wrangler** (only required once per machine):

   ```bash
   cd worker && pnpm wrangler login
   ```

   Opens a browser tab; pick the Cloudflare account that owns this
   project's frontend Worker.

3. **Deploy the Worker**:

   ```bash
   cd worker && pnpm run deploy
   ```

   That npm script wraps `wrangler deploy --config wrangler.toml`
   (the explicit `--config` is required so wrangler doesn't walk up
   to the repo-root frontend config), bundling `worker/index.ts` +
   `worker/GameRoom.ts` + `worker/webpush.ts` together with the
   shared `protocol/` types, and ships them to
   `https://jlhs-multiplayer.<your-subdomain>.workers.dev`.

   The config lives inside `worker/` (not at the repo root) so the
   frontend's Cloudflare auto-build doesn't accidentally pick it up
   and try to deploy the backend in its place. For the **Workers
   Builds** auto-deploy, the project's configured deploy command is
   `node scripts/deploy.mjs` — a thin shim that no-ops on non-master
   branches so preview pushes stay green.

   The first deploy also runs the v1 migration that creates the
   `GameRoom` Durable Object class. Subsequent deploys just update
   the code.

4. **Find your Worker's URL.** After a successful deploy Wrangler
   prints something like:

   ```
   Deployed jlhs-multiplayer (1.42 sec)
     https://jlhs-multiplayer.<your-subdomain>.workers.dev
   ```

   Copy that URL — you'll need it in step 5.

5. **Point the client at the Worker.** Set the
   `PUBLIC_MULTIPLAYER_URL` env var:

   - **Local dev:** add to `.env` at the repo root:

     ```
     PUBLIC_MULTIPLAYER_URL=https://jlhs-multiplayer.<your-subdomain>.workers.dev
     ```

     (`.env` is already gitignored.)

   - **Production (frontend Worker):** the frontend deploys via
     Cloudflare Workers Builds; set `PUBLIC_MULTIPLAYER_URL` as a
     build/environment variable on the `jetlaghideandseek` Worker
     (or bake it into the build env) with the same value.

6. **Update `ALLOWED_ORIGINS` if needed.** The Worker's
   `worker/wrangler.toml` already includes the production frontend
   URL and common localhost ports. If you serve the client from a
   different origin, add it there and redeploy:

   ```bash
   pnpm run deploy   # = wrangler deploy --config wrangler.toml
   ```

## Local development

The Worker can run locally via:

```bash
cd worker && pnpm run dev
```

Listens on `http://localhost:8787` by default. Then start the Vite
dev server (`pnpm dev`, port 5173) with `PUBLIC_MULTIPLAYER_URL`
pointing at the local Worker:

```bash
PUBLIC_MULTIPLAYER_URL=http://localhost:8787 pnpm dev
```

> **Note:** `wrangler dev` uses the `workerd` runtime which has a
> postinstall build script. The worker's `pnpm-workspace.yaml`
> should already approve it; if you see "Ignored build scripts"
> warnings, run `pnpm approve-builds` from inside `worker/` and
> select `workerd` + `esbuild`. `wrangler deploy` is unaffected —
> Cloudflare builds the runtime server-side.

### If the dev preview goes blank after a deps change

**Symptom:** the Vite dev server starts cleanly and serves HTML,
but the page is blank with "Invalid hook call" errors flooding the
browser console.

**Cause:** the PWA service worker (registered automatically by
`vite-plugin-pwa` in `vite.config.ts`) has cached stale chunks from
a previous broken state and is intercepting every request.
Restarting the dev server doesn't help because the SW serves from
cache regardless.

**Fix:** in the broken tab's DevTools console, run:

```js
(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
  location.reload();
})();
```

…or via Application → Service Workers → Unregister + Application →
Storage → Clear site data. Then reload. The full Vite cache also
sometimes needs a kick: stop the dev server, `rm -rf node_modules/.vite`,
restart.

## How it works

### Server (`worker/`)

- `index.ts` — HTTP router. `POST /games` creates a code (no DO
  materialized yet). `GET /games/:code/ws` upgrades to WebSocket and
  routes to the DO instance keyed by code. Also `GET /health`
  (liveness) and `GET /vapid-public-key` (Web Push public key).
  **Photo answers** ride HTTP, not the WS (a data URI would blow the
  64 KB `MAX_MESSAGE_BYTES` check and Cloudflare's 1 MiB WS frame cap):
  `POST /games/:code/photo` stores a full-detail JPEG in R2 (image-only,
  8 MB cap, per-IP rate-limited) and returns `{ url }`;
  `GET /games/:code/photo/:id` serves it back with immutable caching.
  Only that short `photoUrl` then crosses the socket in the `answerQ`
  message. Uses the `PHOTOS` R2 binding (`wrangler.toml`), which reuses
  the existing `jlhs-overpass-cache` bucket under a `photos/<code>/<id>`
  key prefix — no new bucket to provision.
- `GameRoom.ts` — the Durable Object. Holds in-memory state
  (`code`, `setup`, `questions`, `roundFoundAt`, `participants`),
  manages WebSocket lifecycle (host/join/resume/disconnect),
  enforces transport invariants (max 5 participants, one hider),
  fans out broadcasts (including live `loc` position updates and
  `curseReceived`), and arms an alarm to wipe the room after 30
  min idle.
- `webpush.ts` — RFC 8291/8188 Web Push (encryption + VAPID) using
  Web Crypto, so curses can reach **offline** seekers as push
  notifications. Public key served at `/vapid-public-key`; clients
  register a subscription over the WebSocket.

### Shared protocol (`protocol/`)

- `messages.ts` — discriminated wire-protocol types. Same module
  imported by both client and Worker so the compiler enforces
  shape parity.
- `state.ts` — canonical GameState shape + transport constants.
- `version.ts` — protocol version constant; bumped on breaking
  changes.

### Client (`src/lib/multiplayer/`)

- `transport.ts` — WebSocket wrapper. Auto-reconnect with
  exponential backoff (250 ms → 8 s + jitter), send-queue while
  disconnected, 25-second ping cadence, typed-event listeners.
  Module-level singleton.
- `session.ts` — persistent atoms for device UUID, display name,
  current game code, session token, and the global
  `multiplayerEnabled` switch. Runtime-only atoms for transport
  status, participants roster, last error.
- `store.ts` — the bridge. Outbound wrappers (`seekerAddQuestion`,
  `hiderAnswerQuestion`, `seekerMarkFound`, `hostPushSetup`,
  `setOnlineRole`, and `uploadGamePhoto` — POSTs a photo blob to the
  worker's R2 endpoint and returns its URL) and inbound dispatch that
  merges server messages into the existing local stores (`questions`,
  `hiderInbox`, `roundFoundAt`, etc.). Idempotent by key —
  re-broadcasts of locally-initiated changes don't double-apply. The
  photo compress/upload pipeline itself lives in `src/lib/photo.ts`
  (`preparePhotoForSend`).
- `types.ts` — client-side multiplayer types.
- `demoBroker.ts` — an in-browser mock GameRoom used by demo mode,
  so the multiplayer UI can be exercised without a live worker.

### Client UI (`src/components/multiplayer/`)

- `OnlinePlaySection.tsx` — the host/join UI (display name +
  host/join actions). (There is no `JoinGameDialog.tsx`.)
- `InviteSheet.tsx` — `InvitePanel` component that shows the
  active game code, copy/share row, participant roster, and "leave
  game" button. Surfaced from the BottomNav Lobby/Settings flow.
- `PresenceIndicators.tsx` — small chip showing online status and
  participant count.
- `MultiplayerBoot.tsx` — mounts once per page to install the
  bridge and attempt resume from persistent session state.
- `RotateHiderDialog.tsx` — mid-game hider rotation / promotion
  (drives the protocol `rotateHider` message).

## Connection lifecycle

```
┌──────────┐  POST /games            ┌──────────────────┐
│  Client  │ ──────────────────────▶ │  Worker (router)  │
│ (host)   │ ◀────────────────────── │   { code: "AB12CD" }
└────┬─────┘    200 { code }         └──────────────────┘
     │
     │ ws://.../games/AB12CD/ws       ┌──────────────────┐
     └──────────────────────────────▶ │  GameRoom DO     │
                                       │  (materialized   │
       host message ({t:"host", …})   │   on first conn) │
                                       └──────────────────┘
                                       │
                                       │ broadcast presence
                                       ▼
                            (other connected sockets)
```

A guest's flow is the same but starts at the WebSocket step (they
already have a code from the host). On reconnect, the client sends
`resume` with the saved `sessionToken` — the DO validates the token
and reattaches the same participant id.

## Trust model & rule enforcement

The Worker is **client-authoritative** for game rules. It enforces:

- Transport invariants (max participants, one hider, well-formed
  messages, protocol version).
- Idempotency by question key.
- First-write-wins for `roundFoundAt`.

It does **not** validate that, say, a radius question's radius is
within rulebook bounds, or that a hider answered honestly. That's
the same trust model the local-only build has always had — these
games are casual play among friends and we'd rather keep the server
simple.

## Shipped since the initial drop

These were follow-ups in the original draft of this doc and are now
**implemented**:

- **Live position sharing.** Seeker→hider GPS streams over the
  WebSocket as `loc` messages (`GameRoom.ts` broadcasts them;
  `SeekerLivePositions` renders them on the hider map).
- **Curse cast over the wire.** Curses go over the socket
  (`castCurse` → `curseReceived`), and `webpush.ts` even delivers
  them to **offline** seekers as Web Push notifications.
- **Photo answers over R2.** The hider's photo is uploaded to R2 over
  HTTP and only its short `photoUrl` rides the `answerQ` message, so
  full-detail (multi-megabyte) photos reach the seekers without hitting
  the WS frame caps (see the Server `index.ts` notes above). Offline /
  solo play inlines the image as a data URI instead.

## What's still not in this build

Genuine follow-ups, not bugs:

- **Sophisticated reconnect-after-long-offline.** Basic reconnect
  works; "I was offline for 20 minutes and my partner answered 3
  questions in the meantime" relies on the welcome snapshot to
  catch up, which should mostly Just Work but hasn't been
  hammer-tested.
- **Spectator mode.** All participants are either the hider or a
  seeker; there's no read-only role.

## Quick sanity test

After deploying:

1. Open `https://<your-frontend-site>/` in two browsers (or a browser
   + a phone).
2. In the first, BottomNav → More → "Play online" → "Host a game",
   pick a display name, hit Host.
3. The 6-char code appears in the InvitePanel. Tap "Share invite"
   or just read it out.
4. In the second browser, BottomNav → More → "Play online" → "Join
   a game", paste the code + display name, hit Join.
5. Both clients should now see each other in the participant
   roster. Add a question on the seeker side; it should appear on
   the hider side within ~100 ms.

If anything hangs at "Connecting…", check the browser console for
`[multiplayer]` log lines. The most common issue is a CORS / Origin
mismatch — verify `worker/wrangler.toml`'s `ALLOWED_ORIGINS` includes your
client's origin.

## Going public — operational hardening

The defaults are tuned for a small group of friends. If you want to
share the app with the broader Jet Lag community, here's what's in
place and what you should still do before sharing the link widely.

### What's already in the code

These were added on top of the original multiplayer drop
specifically to make public exposure safer:

| Defense | Where | What it does |
|---|---|---|
| Per-IP cap on game creation | `worker/index.ts` | 6 `POST /games` per minute per IP. 429 + retry-after on exceed. |
| Per-IP cap on WS upgrades | `worker/index.ts` | 30 connection attempts per minute per IP. 429 on exceed. |
| Max room lifetime | `worker/GameRoom.ts` (`MAX_ROOM_LIFETIME_MS`) | 18 hours wall-clock — sized for the longest Jet Lag rounds (~12 h seeking after a 3 h Large hiding period, plus buffer). A buggy or malicious client pinging forever can't pin a room in memory. Bumping it is a single-constant change + redeploy. |
| Max participants per room | `protocol/state.ts` (`MAX_PARTICIPANTS`) | 5 (1 hider + 4 seekers). Joins beyond this get a `room_full` error. |
| Max questions per room | `protocol/state.ts` (`MAX_QUESTIONS_PER_ROOM`) | 200. Defends against an abusive client pumping the broadcast cost. |
| Max WebSocket message size | `protocol/state.ts` (`MAX_MESSAGE_BYTES`) | 64 KB per inbound frame. Drops obvious amplification attempts pre-parse. |
| Photo upload guard | `worker/index.ts` (`MAX_PHOTO_BYTES`, `PHOTO_LIMIT_*`) | `POST /games/:code/photo` is image-only, capped at 8 MB, and rate-limited to 40 uploads/min/IP. Keys are namespaced by game code; a junk upload to a non-existent code costs a stray R2 object, nothing more. |
| Idle room eviction | `protocol/state.ts` (`IDLE_EVICTION_MS`) | 30 min of zero connections → state cleared, DO sleeps. |
| Sanitized error messages | `worker/GameRoom.ts` | Internal errors log server-side, return generic "Internal server error" to clients. No stack traces leaked. |
| Cloudflare edge DDoS protection | (built-in) | Layer 4/7 attacks absorbed before traffic even reaches the Worker. |

The per-IP limits are enforced per Worker isolate, so a distributed
attacker hitting many PoPs could exceed them — that's by design.
Cloudflare's account-level DDoS protection covers that case, and
the absolute ceiling is the free-tier request quota (which would
trip a billing alert long before it costs you anything).

### Set up billing alerts in Cloudflare

The most important thing to do before going public. Cloudflare lets
you cap your monthly spend and get notified well before you'd be
charged:

1. Cloudflare dashboard → **Notifications** → **Add**.
2. Select **Workers** → **Daily request limits at 80%** (or pick
   a threshold you like).
3. Add your email. Repeat for any other limits you want to watch
   (Durable Objects requests, DO duration).

Optional: at the Workers dashboard → **Usage**, set a hard
**spending limit** for the Workers Paid plan ($5/month base) if
you ever decide to upgrade. With a spending limit set, the Worker
gets rate-limited rather than billed past the cap.

### What happens at quota exhaustion

If your free tier runs out before you've added a paid plan:

- **POST /games** starts returning 429 / 1015 (Cloudflare rate
  limit). The client's host flow surfaces this as a "Couldn't host
  the game" toast.
- **WebSocket upgrades** may be throttled too.
- **Existing connections** keep working until the rooms idle out.
- **Frontend Worker** is unaffected — it has its own free tier with
  much more generous quotas. Players can still play in
  local-only mode (sharing question links via SMS), which is the
  fallback the app preserves anyway.

So a quota-exhausted day means new multiplayer games are blocked
for a few hours; existing ones complete; local play unaffected.
That's the "graceful failure mode" — no surprise bill, no app
breakage.

### Going-public checklist

Before sharing the app widely:

- [ ] Deploy the Worker (`cd worker && pnpm run deploy`).
- [ ] Set `PUBLIC_MULTIPLAYER_URL` on the production frontend Worker env.
- [ ] Verify `ALLOWED_ORIGINS` in `worker/wrangler.toml` matches your
      production frontend URL exactly (including https vs http).
- [ ] Set up at least one Cloudflare billing/usage alert (Workers
      daily-requests at 80% is a good baseline).
- [ ] Optionally: set a Workers Paid spending cap if you've
      upgraded to a paid plan.
- [ ] Smoke test the host/join flow from two real devices.
- [ ] Read the rate-limited error UX once (try to create 7 games
      in a minute — the 7th should toast a friendly message).
- [ ] If you have a custom domain you want the Worker on, set up
      the route in Cloudflare's Workers → Routes page before
      sharing — workers.dev URLs work fine but a custom subdomain
      looks more polished. (Optional.)

### Things I deliberately did NOT add

- **Per-connection message rate limiting.** A single connected
  socket could in theory send 1000 messages/second and consume
  worker CPU. The MAX_MESSAGE_BYTES check + Cloudflare's
  per-isolate CPU limits make this expensive but not impossible.
  A proper fix is a token-bucket per socket. Worth doing if you
  see weird traffic patterns; not necessary for shipping.
- **CAPTCHA on game creation.** Overkill for a niche community
  app. The per-IP rate limit is the first line of defense; the
  CAPTCHA cost (CF Turnstile) is essentially free if you add it
  later.
- **Per-game host authentication.** Anyone with the 6-char code
  can join; that's by design (it's the "anyone with the link"
  model from the share-link days). If you ever want host-only
  control over things like "kick a participant", you'd add
  host-only message types here.

## Cost expectations

At Cloudflare's free tier (100k Worker requests / day, 1k DO
requests / day, 5M DO durations / month), a small group of friends
playing a few games per week should fit comfortably. A WebSocket
message counts as a single request; a 30 min idle room costs ~1
duration credit per CPU-millisecond, which is minimal because the
DO is mostly asleep waiting on socket events.
