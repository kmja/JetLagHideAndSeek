import { persistentAtom } from "@nanostores/persistent";

/**
 * Sound engine (v911, warmed + file-capable in v913).
 *
 * TWO sources, per beat, in priority order:
 *   1. A **sampled audio file** if one is registered in `SOUND_FILES`
 *      and loads — the path to genuine, produced realism. Drop CC0
 *      files (see `public/sounds/README.md`) into `public/sounds/` and
 *      add an entry; the file wins over the synth automatically.
 *   2. A **procedural Web Audio synth** fallback — no asset bytes, no
 *      licensing, offline-safe. v913 warmed these up (softer attacks,
 *      lowpass-rounded tones, a shared convolution-reverb tail) so they
 *      read as polished UI sounds rather than 8-bit bleeps. Still
 *      synthetic — samples are the way to full realism.
 *
 * Rules (both sources): one lazy shared `AudioContext`, resumed on the
 * first user gesture (`installSoundUnlock`, from `main.tsx`); a persisted
 * `soundMuted` toggle (default OFF = sound on); `play()` is a no-op while
 * muted / backgrounded / where Web Audio is unavailable, and never throws.
 */

export const soundMuted = persistentAtom<boolean>("jlhs:soundMuted", false, {
    encode: (v) => (v ? "1" : "0"),
    decode: (s) => s === "1",
});

export type SoundName =
    | "countdownTick"
    | "go"
    | "elimination"
    | "roundEnd"
    | "cardDraw"
    | "dice";

/**
 * Registered sampled audio files, per beat. EMPTY by default (every beat
 * uses the synth) so there are no 404 probes for files that don't exist
 * yet. To use real audio: drop a file in `public/sounds/` and add a line
 * here, e.g.  `go: "/sounds/go.mp3",`. A registered file that fails to
 * load falls back to the synth for that beat. See public/sounds/README.md
 * for recommended free (CC0) sources — Kenney.nl is the best fit.
 */
const SOUND_FILES: Partial<Record<SoundName, string>> = {
    // countdownTick: "/sounds/countdown.mp3",
    // go: "/sounds/go.mp3",
    // elimination: "/sounds/elimination.mp3",
    // roundEnd: "/sounds/round-end.mp3",
    // cardDraw: "/sounds/card-draw.mp3",
    // dice: "/sounds/dice.mp3",
};

/* ────────────────── AudioContext plumbing ────────────────── */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
/** Shared convolution reverb — a synthetic impulse gives the synth voices
 *  a little room/tail so they don't read as dry 8-bit bleeps. */
let reverb: ConvolverNode | null = null;

/** Build a decaying-noise impulse response for the reverb. */
function makeImpulse(c: AudioContext, seconds = 1.5, decay = 3): AudioBuffer {
    const rate = c.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
    }
    return buf;
}

/** Lazily create (once) the shared AudioContext + master gain + reverb.
 *  Returns null where Web Audio is unavailable (very old browsers / SSR). */
function audio(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (ctx) return ctx;
    const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
    if (!AC) return null;
    try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
        // Reverb return: convolver → return-gain → master. Synth voices
        // connect a wet copy of themselves to the convolver.
        reverb = ctx.createConvolver();
        reverb.buffer = makeImpulse(ctx);
        const reverbReturn = ctx.createGain();
        reverbReturn.gain.value = 0.2;
        reverb.connect(reverbReturn);
        reverbReturn.connect(master);
    } catch {
        ctx = null;
        master = null;
        reverb = null;
        return null;
    }
    return ctx;
}

let unlockInstalled = false;

/** Resume the AudioContext on the first user gesture (autoplay policy) and
 *  kick off preloading any registered sample files. Installed once from
 *  main.tsx, outside React so it survives route changes. */
export function installSoundUnlock(): void {
    if (typeof window === "undefined" || unlockInstalled) return;
    unlockInstalled = true;
    const resume = () => {
        const c = audio();
        if (c && c.state === "suspended") void c.resume();
        preloadSoundFiles();
        window.removeEventListener("pointerdown", resume);
        window.removeEventListener("keydown", resume);
        window.removeEventListener("touchstart", resume);
    };
    window.addEventListener("pointerdown", resume, { passive: true });
    window.addEventListener("keydown", resume, { passive: true });
    window.addEventListener("touchstart", resume, { passive: true });
}

/* ────────────────── Sampled-file source ────────────────── */

// Decoded sample buffers. A `null` entry means "tried and failed" (or no
// file registered) — the beat then uses the synth.
const buffers = new Map<SoundName, AudioBuffer | null>();

async function loadFile(name: SoundName, url: string): Promise<void> {
    const c = audio();
    if (!c) return;
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            buffers.set(name, null);
            return;
        }
        const arr = await resp.arrayBuffer();
        buffers.set(name, await c.decodeAudioData(arr));
    } catch {
        buffers.set(name, null);
    }
}

/** Preload every registered sample file into a decoded buffer. Idempotent;
 *  safe to call repeatedly (skips already-attempted names). */
export function preloadSoundFiles(): void {
    for (const [name, url] of Object.entries(SOUND_FILES) as [
        SoundName,
        string,
    ][]) {
        if (url && !buffers.has(name)) void loadFile(name, url);
    }
}

function playBuffer(c: AudioContext, buf: AudioBuffer): void {
    if (!master) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    // Sampled files are already produced — play them DRY (no synth reverb).
    src.connect(master);
    src.start();
}

/* ────────────────── Synth primitives ────────────────── */

interface ToneSpec {
    type?: OscillatorType;
    /** Start frequency (Hz). */
    f0: number;
    /** Optional end frequency for a glide (exponential ramp). */
    f1?: number;
    /** Duration in seconds (gain decays to ~0 over this). */
    dur: number;
    /** Peak gain (0..1, scaled by master). */
    peak?: number;
    /** Start offset in seconds. */
    delay?: number;
    /** Attack time to peak (bigger = softer, less "bleepy"). */
    attack?: number;
    /** Optional low-pass cutoff (Hz) to round off the harsh harmonics. */
    lp?: number;
}

function tone(c: AudioContext, out: GainNode, s: ToneSpec): void {
    const t = c.currentTime + (s.delay ?? 0);
    const osc = c.createOscillator();
    osc.type = s.type ?? "sine";
    osc.frequency.setValueAtTime(s.f0, t);
    if (s.f1 !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(
            Math.max(1, s.f1),
            t + s.dur,
        );
    }
    let node: AudioNode = osc;
    if (s.lp) {
        const f = c.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.value = s.lp;
        node.connect(f);
        node = f;
    }
    const g = c.createGain();
    const peak = s.peak ?? 0.3;
    const attack = s.attack ?? 0.01;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + s.dur);
    node.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + s.dur + 0.03);
}

interface NoiseSpec {
    dur: number;
    peak?: number;
    delay?: number;
    /** High-pass cutoff (Hz). */
    hp?: number;
    /** Low-pass cutoff (Hz). */
    lp?: number;
}

function noise(c: AudioContext, out: GainNode, s: NoiseSpec): void {
    const t = c.currentTime + (s.delay ?? 0);
    const frames = Math.max(1, Math.floor(c.sampleRate * s.dur));
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    let node: AudioNode = src;
    if (s.hp) {
        const f = c.createBiquadFilter();
        f.type = "highpass";
        f.frequency.value = s.hp;
        node.connect(f);
        node = f;
    }
    if (s.lp) {
        const f = c.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.value = s.lp;
        node.connect(f);
        node = f;
    }
    const g = c.createGain();
    const peak = s.peak ?? 0.2;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + s.dur);
    node.connect(g).connect(out);
    src.start(t);
    src.stop(t + s.dur + 0.03);
}

/* ────────────────── Synth recipes ────────────────── */

const RECIPES: Record<
    SoundName,
    (c: AudioContext, out: GainNode, opts?: PlayOptions) => void
> = {
    // Soft marimba-ish blip; pitch rises step 0→2 toward GO.
    countdownTick: (c, out, opts) => {
        const step = opts?.step ?? 0;
        const base = 330 + step * 90;
        tone(c, out, {
            type: "sine",
            f0: base,
            dur: 0.18,
            peak: 0.28,
            attack: 0.004,
            lp: 1800,
        });
        tone(c, out, {
            type: "triangle",
            f0: base * 2,
            dur: 0.12,
            peak: 0.07,
            attack: 0.004,
            lp: 2600,
        });
    },
    // Warm swell: sub whoomph + a rounded bell triad + airy shimmer.
    go: (c, out) => {
        tone(c, out, {
            type: "sine",
            f0: 180,
            f1: 70,
            dur: 0.5,
            peak: 0.3,
            attack: 0.012,
        });
        [523.25, 659.25, 783.99].forEach((f, i) => {
            tone(c, out, {
                type: "triangle",
                f0: f,
                dur: 0.6,
                peak: 0.15,
                attack: 0.014,
                delay: i * 0.05,
                lp: 3000,
            });
            tone(c, out, {
                type: "sine",
                f0: f,
                dur: 0.6,
                peak: 0.1,
                attack: 0.014,
                delay: i * 0.05,
            });
        });
        noise(c, out, { dur: 0.4, peak: 0.05, hp: 3000, lp: 9000 });
    },
    // Rounded downward "whoosh-thunk" as the ruled-out slice flashes.
    elimination: (c, out) => {
        tone(c, out, {
            type: "triangle",
            f0: 480,
            f1: 120,
            dur: 0.3,
            peak: 0.18,
            attack: 0.005,
            lp: 1400,
        });
        noise(c, out, { dur: 0.32, peak: 0.1, lp: 900 });
        tone(c, out, {
            type: "sine",
            f0: 120,
            f1: 64,
            dur: 0.28,
            peak: 0.28,
            attack: 0.006,
            delay: 0.1,
        });
    },
    // Warm rising major arpeggio + octave sparkle + soft shimmer.
    roundEnd: (c, out) => {
        const notes = [523.25, 659.25, 783.99, 1046.5]; // C E G C
        notes.forEach((f, i) => {
            tone(c, out, {
                type: "triangle",
                f0: f,
                dur: 0.6,
                peak: 0.15,
                attack: 0.014,
                delay: i * 0.11,
                lp: 3500,
            });
            tone(c, out, {
                type: "sine",
                f0: f * 2,
                dur: 0.5,
                peak: 0.05,
                attack: 0.014,
                delay: i * 0.11,
            });
        });
        tone(c, out, {
            type: "sine",
            f0: 1567.98,
            dur: 0.7,
            peak: 0.07,
            attack: 0.02,
            delay: 0.44,
        });
        noise(c, out, { dur: 0.6, peak: 0.04, hp: 5000, delay: 0.44 });
    },
    // Soft paper swish + tick as a card flies to the hand.
    cardDraw: (c, out) => {
        noise(c, out, { dur: 0.2, peak: 0.1, hp: 1200, lp: 5000 });
        tone(c, out, {
            type: "sine",
            f0: 820,
            f1: 1150,
            dur: 0.12,
            peak: 0.08,
            attack: 0.004,
            delay: 0.04,
            lp: 3000,
        });
    },
    // Wooden clacks then a settle — a rounded rattle, not a buzzer.
    dice: (c, out) => {
        for (let i = 0; i < 4; i++) {
            const at = i * 0.075;
            noise(c, out, {
                dur: 0.045,
                peak: 0.14,
                hp: 900,
                lp: 3500,
                delay: at,
            });
            tone(c, out, {
                type: "triangle",
                f0: 180 + (i % 2) * 40,
                dur: 0.05,
                peak: 0.06,
                attack: 0.002,
                delay: at,
                lp: 2000,
            });
        }
        tone(c, out, {
            type: "triangle",
            f0: 150,
            dur: 0.12,
            peak: 0.12,
            attack: 0.003,
            delay: 0.33,
            lp: 1500,
        });
        noise(c, out, { dur: 0.07, peak: 0.08, hp: 700, lp: 2500, delay: 0.33 });
    },
};

interface PlayOptions {
    /** countdownTick: 0-based step so pitch rises toward GO. */
    step?: number;
}

/** Play a game-beat sound. Prefers a registered sample file, else the
 *  warmed synth. No-op when muted, backgrounded, or Web Audio is
 *  unavailable. Safe to call from any event handler; never throws. */
export function play(name: SoundName, opts?: PlayOptions): void {
    if (soundMuted.get()) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const c = audio();
    if (!c || !master) return;
    if (c.state === "suspended") void c.resume();
    try {
        const buf = buffers.get(name);
        if (buf) {
            playBuffer(c, buf);
            return;
        }
        // Synth voice bus: dry to master + a wet copy through the reverb.
        const bus = c.createGain();
        bus.connect(master);
        if (reverb) bus.connect(reverb);
        RECIPES[name](c, bus, opts);
    } catch {
        /* a scheduling hiccup must never break gameplay */
    }
}
