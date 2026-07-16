import { persistentAtom } from "@nanostores/persistent";

/**
 * Procedural sound engine (v911). The app had NO audio; rather than
 * ship sampled assets (licensing + bundle + offline-caching burden)
 * every SFX is SYNTHESISED on the fly with the Web Audio API — a
 * handful of oscillators + gain envelopes + noise bursts. Zero asset
 * bytes, no licensing, works offline, theme-able in code.
 *
 * Design rules:
 *   - ONE lazy `AudioContext`, created on first use and resumed on the
 *     first user gesture (browsers block audio until then). See
 *     `installSoundUnlock`, called once from `main.tsx`.
 *   - A persisted `soundMuted` toggle (default OFF = sound on), surfaced
 *     in `AppSettingsDrawer`. `play()` is a no-op while muted.
 *   - Never play while the tab is backgrounded — OS notifications own
 *     that channel, and a delayed blip on return is jarring.
 *   - Modest master volume; each recipe is short (<0.6 s).
 *
 * Wired into the highest-impact game beats (the "starter set"):
 * countdown/GO flourish, answer-lands elimination, round-end/found,
 * card draw, dice roll. More beats (curses, timer warnings, endgame
 * claim) can hang off the same `play()` dispatcher later.
 */

export const soundMuted = persistentAtom<boolean>("jlhs:soundMuted", false, {
    encode: (v) => (v ? "1" : "0"),
    decode: (s) => s === "1",
});

/* ────────────────── AudioContext plumbing ────────────────── */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** Lazily create (once) the shared AudioContext + master gain. Returns
 *  null where Web Audio is unavailable (very old browsers / SSR). */
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
        master.gain.value = 0.45; // modest — SFX support, don't dominate
        master.connect(ctx.destination);
    } catch {
        ctx = null;
        master = null;
        return null;
    }
    return ctx;
}

let unlockInstalled = false;

/** Resume the AudioContext on the first user gesture (autoplay policy).
 *  Installed once from main.tsx, outside React so it survives route
 *  changes. Self-removes after the first gesture. */
export function installSoundUnlock(): void {
    if (typeof window === "undefined" || unlockInstalled) return;
    unlockInstalled = true;
    const resume = () => {
        const c = audio();
        if (c && c.state === "suspended") void c.resume();
        window.removeEventListener("pointerdown", resume);
        window.removeEventListener("keydown", resume);
        window.removeEventListener("touchstart", resume);
    };
    window.addEventListener("pointerdown", resume, { passive: true });
    window.addEventListener("keydown", resume, { passive: true });
    window.addEventListener("touchstart", resume, { passive: true });
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
    /** Attack time to peak. */
    attack?: number;
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
    const g = c.createGain();
    const peak = s.peak ?? 0.3;
    const attack = s.attack ?? 0.006;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + s.dur);
    osc.connect(g).connect(out);
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

/* ────────────────── Sound recipes ────────────────── */

export type SoundName =
    | "countdownTick"
    | "go"
    | "elimination"
    | "roundEnd"
    | "cardDraw"
    | "dice";

const RECIPES: Record<
    SoundName,
    (c: AudioContext, out: GainNode, opts?: PlayOptions) => void
> = {
    // Countdown pluck — pitch rises step 0→2 as it approaches GO.
    countdownTick: (c, out, opts) => {
        const step = opts?.step ?? 0;
        tone(c, out, {
            type: "triangle",
            f0: 300 + step * 130,
            dur: 0.13,
            peak: 0.26,
        });
    },
    // GO burst — warm ascending triad + sub thump + airy shimmer.
    go: (c, out) => {
        tone(c, out, { type: "triangle", f0: 523.25, dur: 0.5, peak: 0.2 });
        tone(c, out, {
            type: "triangle",
            f0: 659.25,
            dur: 0.5,
            peak: 0.18,
            delay: 0.06,
        });
        tone(c, out, {
            type: "triangle",
            f0: 783.99,
            dur: 0.6,
            peak: 0.18,
            delay: 0.12,
        });
        tone(c, out, { type: "sine", f0: 165, f1: 60, dur: 0.42, peak: 0.34 });
        noise(c, out, { dur: 0.32, peak: 0.1, hp: 2200 });
    },
    // Answer lands — a downward "cut" whoosh with a soft landing thump.
    elimination: (c, out) => {
        tone(c, out, {
            type: "sawtooth",
            f0: 520,
            f1: 120,
            dur: 0.26,
            peak: 0.15,
        });
        noise(c, out, { dur: 0.28, peak: 0.13, lp: 1300 });
        tone(c, out, {
            type: "sine",
            f0: 130,
            f1: 72,
            dur: 0.22,
            peak: 0.26,
            delay: 0.11,
        });
    },
    // Round end / hider found — celebratory rising major arpeggio + sparkle.
    roundEnd: (c, out) => {
        const notes = [523.25, 659.25, 783.99, 1046.5]; // C E G C
        notes.forEach((f, i) =>
            tone(c, out, {
                type: "triangle",
                f0: f,
                dur: 0.5,
                peak: 0.18,
                delay: i * 0.12,
            }),
        );
        tone(c, out, {
            type: "sine",
            f0: 1567.98,
            dur: 0.5,
            peak: 0.08,
            delay: 0.44,
        });
        noise(c, out, { dur: 0.5, peak: 0.05, hp: 4500, delay: 0.44 });
    },
    // Card draw — light swish + tick.
    cardDraw: (c, out) => {
        noise(c, out, { dur: 0.16, peak: 0.12, hp: 1500, lp: 6500 });
        tone(c, out, {
            type: "triangle",
            f0: 900,
            f1: 1300,
            dur: 0.1,
            peak: 0.13,
            delay: 0.05,
        });
    },
    // Dice roll — a short rattle of noise bursts then a settle thunk.
    dice: (c, out) => {
        for (let i = 0; i < 4; i++) {
            noise(c, out, {
                dur: 0.05,
                peak: 0.15,
                hp: 1200,
                lp: 5200,
                delay: i * 0.07,
            });
        }
        tone(c, out, {
            type: "square",
            f0: 210,
            dur: 0.09,
            peak: 0.13,
            delay: 0.32,
        });
        noise(c, out, { dur: 0.06, peak: 0.1, hp: 900, delay: 0.32 });
    },
};

interface PlayOptions {
    /** countdownTick: 0-based step so pitch rises toward GO. */
    step?: number;
}

/** Play a game-beat sound. No-op when muted, backgrounded, or Web Audio
 *  is unavailable. Safe to call from any event handler. */
export function play(name: SoundName, opts?: PlayOptions): void {
    if (soundMuted.get()) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const c = audio();
    if (!c || !master) return;
    if (c.state === "suspended") void c.resume();
    try {
        RECIPES[name](c, master, opts);
    } catch {
        /* a scheduling hiccup must never break gameplay */
    }
}
