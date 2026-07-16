# Game sound effects (optional, plug-and-play)

The app synthesises all sounds procedurally (`src/lib/sound.ts`) so it works
with **zero audio files**. For more realistic, "produced" sound, drop real
audio files here and register them — a registered file automatically wins over
the synth, and a missing/failed file falls back to the synth for that beat.

## How to add real sounds

1. Get audio files (see **free sources** below). `.mp3` is safest for browser
   support; `.ogg`/`.webm` also work.
2. Drop them in this folder (`public/sounds/`). They're served at `/sounds/…`.
3. Register each one in `SOUND_FILES` in **`src/lib/sound.ts`** — uncomment the
   matching line, e.g.:
   ```ts
   const SOUND_FILES: Partial<Record<SoundName, string>> = {
       go: "/sounds/go.mp3",
       elimination: "/sounds/elimination.mp3",
       roundEnd: "/sounds/round-end.mp3",
       cardDraw: "/sounds/card-draw.mp3",
       dice: "/sounds/dice.mp3",
       countdownTick: "/sounds/countdown.mp3",
   };
   ```
4. Bump `APP_VERSION` and deploy. That's it — the files preload on the first
   user gesture and play in place of the synth.

## The six beats

| Name            | When it fires                              | Good sample type            |
|-----------------|--------------------------------------------|-----------------------------|
| `countdownTick` | each 3-2-1 step before GO                  | short UI blip / tick        |
| `go`            | the GO-GO-GO card explodes in              | short fanfare / whoosh-hit  |
| `elimination`   | an answer lands, map slice flashes         | soft whoosh / thunk         |
| `roundEnd`      | hider found / round over                   | celebratory sting / fanfare |
| `cardDraw`      | a drawn card flies to the hand             | card deal / paper swish     |
| `dice`          | rolling the d6                             | dice rattle + settle        |

Keep them **short** (< ~1 s each) and quiet — they support the moment, they
don't announce it. The master volume is modest and the in-app **Settings →
Sound** toggle mutes everything.

## Free sources (commercial-safe, no attribution required)

- **Kenney.nl** — best fit. Everything is **public domain (CC0)**: no
  attribution, commercial-OK. Grab the *Interface Sounds*, *Casino Audio*
  (dice + card deals), and *Impact Sounds* packs.
- **Mixkit** (mixkit.co) — free, commercial-OK without attribution; more
  "produced"/cinematic (good for `roundEnd`).
- **Pixabay** (pixabay.com/sound-effects) — free, commercial-OK, no attribution.

Avoid **Freesound** unless you filter to CC0 (its licenses are mixed), and
**Zapsplat** (needs attribution on the free tier).
