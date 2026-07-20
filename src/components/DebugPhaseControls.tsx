import { useStore } from "@nanostores/react";
import { Bug, LayoutGrid, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "react-toastify";

import { appConfirm } from "@/lib/confirm";
import {
    addQuestion,
    mapContext,
    mapGeoLocation,
    polyGeoJSON,
    questionModified,
    questions,
} from "@/lib/context";
import {
    clearGpsSpoof,
    spoofedPosition,
    spoofPickMode,
} from "@/lib/debugGpsSpoof";
import { spoofRandomInPlayArea } from "@/lib/debugSpoofArea";
import {
    debugPanelOpen,
    lastBodyOfWaterDiag,
    stationLabelMaxChars,
} from "@/lib/debugState";
import { clearAllLocalDataAndReload } from "@/lib/debugTools";
import { type Card, shuffledDeck } from "@/lib/hiderDeck";
import { hiddenCreditMs } from "@/lib/gameSetup";
import {
    hiderHand,
    hiderInbox,
    playerRole,
    presentDraw,
    QUESTION_DRAW_BUDGET,
    roundLog,
} from "@/lib/hiderRole";
import { startDemoGame, stopDemoGame } from "@/lib/multiplayer/demoBroker";
import {
    demoMode,
    multiplayerEnabled,
    seekerLocations,
} from "@/lib/multiplayer/session";
import { getTransport } from "@/lib/multiplayer/transport";
import { endHidingPeriodEarly } from "@/lib/roundActions";
import { triggerCurseReveal } from "@/lib/curseReveal";
import { receivedCurses } from "@/lib/seekerInbound";
import { encodeQuestionForHider } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import type { Question } from "@/maps/schema";

import { DICE_FIZZLE } from "./CastCurseDialog";

/** Rotating sample curses for the debug "Cast test curse" action (v747).
 *  Covers the distinct CurseInbox paths: an untimed manual-clear curse, a
 *  timed countdown curse ("for the next N minutes" is parsed by curseMeta),
 *  and a dice-roll curse. Replaces the demo bot's removed auto-cast loop. */
const DEBUG_TEST_CURSES: {
    name: string;
    description: string;
    castingCost: string | null;
}[] = [
    {
        name: "Curse of the Tourist",
        description:
            "Each seeker must take a selfie at the nearest tourist landmark before they may continue.",
        castingCost: "Discard 1 card",
    },
    {
        name: "Curse of the Polyglot",
        description:
            "For the next 10 minutes, every seeker must speak only in a language they don't fluently know.",
        castingCost: "Discard 2 cards",
    },
    {
        name: "Curse of the Gambler's Feet",
        description:
            "Before your next question, roll a die. You may only travel that many blocks.",
        castingCost: "Discard 1 card",
    },
];

/**
 * Temporary developer panel for jumping the latest question between any
 * of its lifecycle phases. Float-mounted on both `/` (seeker) and `/h`
 * (hider).
 *
 * The phase buttons are **stateless setters**, not transitions — each
 * one moves the latest question to that exact phase, regardless of
 * which phase it's currently in. So you can bounce back and forth
 * freely (e.g. Answered → Waiting → Not sent → Overdue → Answered)
 * without having to reset between attempts.
 *
 * Phase definitions:
 *
 *   • Not sent           — `drag:true`, `createdAt` undefined
 *   • Waiting for answer — `drag:true`, `createdAt` = now
 *   • Overdue            — `drag:true`, `createdAt` = 6 min ago
 *   • Answered · Yes     — `drag:false`, positive answer field
 *   • Answered · No      — `drag:false`, negative answer field
 *
 * Remove this component (and its mount sites in `index.astro` and
 * `h.astro`) before shipping a release.
 */

type Phase =
    | "not-sent"
    | "waiting"
    | "overdue"
    | "answered-yes"
    | "answered-no";

/**
 * Legacy prop, retained so existing call sites still type-check. It used to
 * gate WHERE the floating "debug" chip appeared; v883 removed the chip
 * entirely (the panel opens via the hidden top-centre 5-tap gesture), so this
 * value is now ignored.
 */
type DebugFloating = "always" | "desktop" | "never";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function DebugPhaseControls(_props: { floating?: DebugFloating } = {}) {
    const open = useStore(debugPanelOpen);
    const $labelMaxChars = useStore(stationLabelMaxChars);
    const $bowDiag = useStore(lastBodyOfWaterDiag);
    const $questions = useStore(questions);
    const $inbox = useStore(hiderInbox);
    const $map = useStore(mapContext);
    const $role = useStore(playerRole);
    const $demo = useStore(demoMode);
    const $spoof = useStore(spoofedPosition);
    const $pickMode = useStore(spoofPickMode);

    /* ─────── seeker actions ─────── */

    /** Map center if available, else a Stockholm-ish fallback. */
    const pickCenter = (): { lat: number; lng: number } => {
        if ($map) {
            const c = $map.getCenter();
            return { lat: c.lat, lng: c.lng };
        }
        return { lat: 59.3293, lng: 18.0686 };
    };

    /** The most-recently-added question — what the phase buttons act on. */
    const latestQuestion = (): Question | null => {
        const list = questions.get();
        return list[list.length - 1] ?? null;
    };

    const addRadarQuestion = () => {
        const { lat, lng } = pickCenter();
        addQuestion({
            id: "radius",
            data: {
                lat,
                lng,
                radius: 5,
                unit: "kilometers",
            },
        });
    };

    const addMatchingQuestion = () => {
        const { lat, lng } = pickCenter();
        addQuestion({
            id: "matching",
            data: {
                lat,
                lng,
                type: "airport",
            } as never,
        });
    };

    const addMeasuringQuestion = () => {
        const { lat, lng } = pickCenter();
        addQuestion({
            id: "measuring",
            data: {
                lat,
                lng,
                type: "coastline",
            } as never,
        });
    };

    const addTentaclesQuestion = () => {
        const { lat, lng } = pickCenter();
        addQuestion({
            id: "tentacles",
            data: {
                lat,
                lng,
                radius: 30,
                unit: "miles",
                location: false,
                locationType: "aquarium",
            } as never,
        });
    };

    const addThermometerQuestion = () => {
        const { lat, lng } = pickCenter();
        // Already-finished 500m thermometer pair: A is the centre, B
        // is roughly 500m east (lng offset ≈ 0.005° at mid latitudes).
        addQuestion({
            id: "thermometer",
            data: {
                latA: lat,
                lngA: lng,
                latB: lat,
                lngB: lng + 0.005,
                distance: "500m",
                status: "finished",
                startedAt: Date.now() - 60_000,
            } as never,
        });
    };

    const addPhotoQuestion = () => {
        addQuestion({
            id: "photo",
            data: {
                type: "tree",
            } as never,
        });
    };

    /**
     * Catalogue of the variety-pack injectors so the rotating
     * "Add random" button can hit each type at uniform probability.
     */
    const EXAMPLE_QUESTION_ADDERS: Array<{
        label: string;
        run: () => void;
    }> = [
        { label: "Radar", run: addRadarQuestion },
        { label: "Matching", run: addMatchingQuestion },
        { label: "Measuring", run: addMeasuringQuestion },
        { label: "Tentacles", run: addTentaclesQuestion },
        { label: "Thermometer", run: addThermometerQuestion },
        { label: "Photo", run: addPhotoQuestion },
    ];

    const addRandomQuestion = () => {
        const pick =
            EXAMPLE_QUESTION_ADDERS[
                Math.floor(Math.random() * EXAMPLE_QUESTION_ADDERS.length)
            ];
        pick.run();
    };

    /**
     * Move the latest question to a specific phase. Stateless — works
     * regardless of where the question currently is, so the user can
     * jump backward (e.g. "answered" → "not sent") freely.
     */
    const setPhase = (target: Phase) => {
        const q = latestQuestion();
        if (!q) return;
        const d = q.data as Record<string, unknown>;

        // drag flag: false only for answered phases.
        d.drag = !target.startsWith("answered");

        // createdAt management
        if (target === "not-sent") {
            delete d.createdAt;
        } else if (target === "overdue") {
            // Past the 5-min answer window for non-photo questions.
            d.createdAt = Date.now() - 6 * 60_000;
        } else {
            // waiting + answered both want a createdAt so the
            // "answered" pill replaces the "waiting" pill cleanly.
            d.createdAt = Date.now();
        }

        // Answer-field management. Each question type uses a different
        // field for its answer; we apply the boolean (or stub string)
        // when the target phase is one of the answered phases.
        if (target === "answered-yes" || target === "answered-no") {
            const positive = target === "answered-yes";
            switch (q.id) {
                case "radius":
                    d.within = positive;
                    break;
                case "matching":
                    d.same = positive;
                    break;
                case "measuring":
                    d.hiderCloser = positive;
                    break;
                case "thermometer":
                    d.warmer = positive;
                    break;
                case "tentacles":
                    d.hiderPlace = positive ? "Test Place" : "";
                    break;
                case "photo":
                    // Photo has no boolean answer — drag:false is enough.
                    break;
            }
        }

        questionModified();
    };

    /** Derive the latest question's current phase, for highlighting
     *  the active button in the panel. */
    const currentPhase = (): Phase | null => {
        const q = latestQuestion();
        if (!q) return null;
        const d = q.data as { drag?: boolean; createdAt?: number };
        if (d.drag === false) {
            // We can't easily tell "yes" vs "no" without reading the
            // per-category answer field; pick the "yes" highlight for
            // simplicity since both share the same visual phase
            // (answered + slide-out animation).
            return "answered-yes";
        }
        if (d.createdAt === undefined) return "not-sent";
        const ageMs = Date.now() - d.createdAt;
        const windowMs = q.id === "photo" ? 10 * 60_000 : 5 * 60_000;
        return ageMs >= windowMs ? "overdue" : "waiting";
    };

    /** Labels for the answered-yes / answered-no buttons based on the
     *  latest question's type. */
    const answerLabels = (() => {
        const q = latestQuestion();
        switch (q?.id) {
            case "radius":
                return { positive: "Inside", negative: "Outside" };
            case "matching":
                return { positive: "Match", negative: "Different" };
            case "measuring":
                return { positive: "Closer", negative: "Further" };
            case "thermometer":
                return { positive: "Warmer", negative: "Colder" };
            case "tentacles":
                return { positive: "Has answer", negative: "Empty answer" };
            case "photo":
                return { positive: "Sent", negative: "Sent (no)" };
            default:
                return { positive: "Yes", negative: "No" };
        }
    })();

    const resetQuestions = () => {
        questions.set([]);
    };

    /**
     * Testing-only: flip the device to hider role and open the latest
     * pending question's `?q=` URL directly. Production "Switch to
     * hider" deliberately doesn't do this (roles lock once a game has
     * started), but for round-tripping the answer flow on a single
     * device this is the path the seeker would otherwise text to the
     * hider.
     */
    const openLatestAsHider = () => {
        const all = questions.get();
        const latest = [...all].reverse().find((q) => {
            if (q.data.drag !== true) return false;
            if (q.id === "thermometer") {
                const status =
                    (q.data as { status?: string }).status ?? "finished";
                if (status === "started") return false;
            }
            return true;
        });
        if (!latest) return;
        playerRole.set("hider");
        const url = encodeQuestionForHider(latest);
        try {
            const parsed = new URL(url);
            window.location.assign(
                parsed.pathname + parsed.search + parsed.hash,
            );
        } catch {
            window.location.assign("/h");
        }
    };

    /* ─────── role switching (bypasses production lock) ─────── */

    /**
     * Force-switch the device's role and route to the matching page,
     * regardless of whether the production "Switch to seeker / hider"
     * affordances are currently locked (they hide once the game has
     * a question history to prevent mid-game role flips).
     *
     * When flipping to the hider side, also ferry every pending
     * seeker-side question (`drag === true`, except for started-but-
     * not-finished thermometer questions) into the hider's inbox.
     * Otherwise the hider lands on `/h` with an empty question log
     * and the round-trip can't be tested on a single device.
     * Deduped by question key so repeat presses don't pile up.
     *
     * Debug-only — production code paths should keep using their
     * gated switchers, and in a real game the question would arrive
     * via share link.
     */
    const forceRole = (target: "seeker" | "hider") => {
        if (target === "hider") {
            const pending = questions.get().filter((q) => {
                if (q.data.drag !== true) return false;
                if (q.id === "thermometer") {
                    const status =
                        (q.data as { status?: string }).status ?? "finished";
                    if (status === "started") return false;
                }
                return true;
            });
            if (pending.length > 0) {
                const inbox = hiderInbox.get();
                const existingKeys = new Set(inbox.map((e) => e.key));
                const additions = pending
                    .filter((q) => !existingKeys.has(q.key))
                    .map((q) => ({
                        key: q.key,
                        id: q.id,
                        data: q.data as Record<string, unknown>,
                        arrivedAt: Date.now(),
                    }));
                if (additions.length > 0) {
                    hiderInbox.set([...inbox, ...additions]);
                }
            }
        }
        playerRole.set(target);
        const path = target === "hider" ? "/h" : "/";
        if (window.location.pathname === path) {
            // Refresh so the page re-mounts under the new role.
            window.location.reload();
        } else {
            window.location.assign(path);
        }
    };

    /* ─────── hider actions ─────── */

    /**
     * Pick a uniformly-random index using `crypto.getRandomValues`
     * instead of `Math.random`. Lets the debug tool stay
     * deterministically random even if a test eval has pinned
     * `Math.random` to a fixed value (the GPS spoof + dice-roll
     * mocks earlier in the session do this) — using `Math.random`
     * directly would make the debug tool deal the same card
     * every click. Falls back to `Math.random` if `crypto` isn't
     * available (older / locked-down browsers).
     */
    const randIdx = (len: number): number => {
        if (len <= 0) return 0;
        try {
            const buf = new Uint32Array(1);
            crypto.getRandomValues(buf);
            return buf[0] % len;
        } catch {
            return Math.floor(Math.random() * len);
        }
    };

    /**
     * Drop a fresh card into the hider's hand. Picks from the full
     * deck of 100 cards — proportional kind distribution matches
     * the real deck (55 time-bonus / 21 powerup / 24 curse).
     * Ignores the hand cap so the user can stack however many they
     * want for UI testing.
     *
     * `kind` lets you bias the pick to one of the three card kinds.
     */
    const drawRandomCard = (kind?: Card["kind"]) => {
        const deck = shuffledDeck();
        const pool = kind ? deck.filter((c) => c.kind === kind) : deck;
        if (pool.length === 0) return;
        const card = pool[randIdx(pool.length)];
        hiderHand.set([...hiderHand.get(), card]);
    };

    /**
     * Same draw flow as `drawRandomCard`, but filters to the
     * subset of curses that have a pre-cast die roll (the
     * Endless Tumble / Gambler's Feet family). Quick way to
     * smoke-test the dice tumble, confetti, and fizzle effects
     * without spamming the random-curse button until you land on
     * a rollable one.
     */
    const drawRandomRollableCurse = () => {
        const rollableNames = new Set(
            Object.keys(DICE_FIZZLE).filter(
                (name) => DICE_FIZZLE[name] !== undefined,
            ),
        );
        const deck = shuffledDeck();
        const pool = deck.filter(
            (c) => c.kind === "curse" && rollableNames.has(c.name),
        );
        if (pool.length === 0) return;
        const card = pool[randIdx(pool.length)];
        hiderHand.set([...hiderHand.get(), card]);
    };

    /**
     * Fill the hand with a batch of DISTINCT random curses so every
     * curse's cast flow (dice, discard cost, photo/film capture, Drained
     * Brain's category picker, …) can be exercised in one go. Draws from a
     * freshly shuffled deck — each curse has one copy, so slicing the
     * shuffled curse pool gives distinct picks. Ignores the hand cap.
     */
    const fillHandWithCurses = (count = 6) => {
        const deck = shuffledDeck();
        const picks = deck.filter((c) => c.kind === "curse").slice(0, count);
        if (picks.length === 0) return;
        hiderHand.set([...hiderHand.get(), ...picks]);
        toast.info(
            `Added ${picks.length} random curse${
                picks.length === 1 ? "" : "s"
            } to your hand.`,
            { autoClose: 2000 },
        );
    };

    /**
     * Location to anchor a debug inbox question at: the bot seeker's MOST
     * RECENT live position (demo mode broadcasts `loc` into `seekerLocations`),
     * so an injected question reads as if that seeker asked it from where they
     * actually are — falling back to the map centre / Stockholm only when no
     * seeker has broadcast yet.
     */
    const pickSeekerLocation = (): { lat: number; lng: number } => {
        const locs = Object.values(seekerLocations.get());
        if (locs.length > 0) {
            const latest = locs.reduce((a, b) => (b.ts > a.ts ? b : a));
            return { lat: latest.lat, lng: latest.lng };
        }
        return pickCenter();
    };

    /** Debug question `data` for each category, anchored at (lat,lng). Mirrors
     *  the seeker-side injectors so the hider sees a real, answerable question. */
    const buildInboxData = (
        id: string,
        lat: number,
        lng: number,
    ): Record<string, unknown> => {
        switch (id) {
            case "matching":
                return { lat, lng, type: "airport", drag: true };
            case "measuring":
                return { lat, lng, type: "coastline", drag: true };
            case "tentacles":
                return {
                    lat,
                    lng,
                    radius: 30,
                    unit: "miles",
                    location: false,
                    locationType: "aquarium",
                    drag: true,
                };
            case "thermometer":
                return {
                    latA: lat,
                    lngA: lng,
                    latB: lat,
                    lngB: lng + 0.005,
                    distance: "500m",
                    status: "finished",
                    startedAt: Date.now() - 60_000,
                    drag: true,
                };
            case "photo":
                return { type: "tree", drag: true };
            case "radius":
            default:
                return { lat, lng, radius: 5, unit: "kilometers", drag: true };
        }
    };

    /** Every category, so the debug panel can inject any of the six. */
    const INBOX_QUESTION_CATEGORIES: Array<{ label: string; id: string }> = [
        { label: "Radar", id: "radius" },
        { label: "Matching", id: "matching" },
        { label: "Measuring", id: "measuring" },
        { label: "Tentacles", id: "tentacles" },
        { label: "Thermometer", id: "thermometer" },
        { label: "Photo", id: "photo" },
    ];

    const injectInboxQuestion = (id: string) => {
        const { lat, lng } = pickSeekerLocation();
        // v879: real question keys are in [0,1); use the same convention so the
        // demo broker + randomize-split logic treat this like a real question.
        const key = Math.random();
        const data = buildInboxData(id, lat, lng);
        if (multiplayerEnabled.get()) {
            // In demo / real multiplayer the hider inbox is a bridge-managed
            // MIRROR of the synced `questions` store (rebuilt from it on every
            // snapshot), so writing `hiderInbox` directly gets wiped on the
            // next welcome/snapshot AND is un-answerable over the wire (the
            // broker/server has no matching questions key). Route through the
            // SAME `addQ` path a real seeker uses: broker → qAdded →
            // mergeIncomingQuestion upserts BOTH `questions` + `hiderInbox`, so
            // it survives snapshots and the hider's answer round-trips.
            getTransport()?.send({
                t: "addQ",
                question: { id, key, data } as Question,
            });
        } else {
            hiderInbox.set([
                ...hiderInbox.get(),
                { key, id, data, arrivedAt: Date.now() },
            ]);
        }
    };

    const markLatestInboxReplied = () => {
        const list = hiderInbox.get();
        if (list.length === 0) return;
        const sorted = [...list].sort((a, b) => b.arrivedAt - a.arrivedAt);
        const target = sorted.find((e) => !e.repliedAt);
        if (!target) return;
        // Stamp the inbox entry as replied so it moves from
        // "Awaiting answer" into "Answered" in the hider's log.
        hiderInbox.set(
            list.map((e) =>
                e.key === target.key
                    ? { ...e, repliedAt: Date.now(), reply: { within: true } }
                    : e,
            ),
        );
        // Mirror the card-draw side effect the real share-back flow
        // produces (see ShareBackRow.markRepliedInInbox in
        // HiderView). Without this, replying via the debug button
        // never queues a draw and the hand/deck flows can't be
        // tested end-to-end.
        const budget = QUESTION_DRAW_BUDGET[target.id];
        if (budget) {
            const autoResolved = presentDraw(
                budget.draw,
                budget.keep,
                target.id,
                target.key,
            );
            void autoResolved;
        }
    };

    const unreplyLatestInbox = () => {
        const list = hiderInbox.get();
        if (list.length === 0) return;
        const sorted = [...list].sort((a, b) => b.arrivedAt - a.arrivedAt);
        const target = sorted.find((e) => e.repliedAt);
        if (!target) return;
        hiderInbox.set(
            list.map((e) =>
                e.key === target.key
                    ? { ...e, repliedAt: undefined, reply: undefined }
                    : e,
            ),
        );
    };

    const clearInbox = () => {
        hiderInbox.set([]);
    };

    const pendingCount = $questions.filter((q) => q.data.drag === true).length;
    const inboxUnreplied = $inbox.filter((e) => !e.repliedAt).length;
    const hasLatest = latestQuestion() !== null;
    const phase = currentPhase();

    // Render into a fresh body-level portal so the bug button + open
    // panel are never trapped inside another component's stacking
    // context or Radix's modal-Dialog sibling tree (which can mark
    // siblings as inert and swallow clicks even when z-index is
    // higher). Combined with z-[9999] and explicit pointer-events,
    // this guarantees the debug control is clickable in every app
    // state — over the welcome screen, lobby, role picker, GO GO GO
    // celebration, anything.
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);
    if (!mounted || typeof document === "undefined") return null;

    // v883: the floating debug launcher chip was REMOVED so users can't tap
    // it by accident. The panel now opens ONLY via the hidden top-centre
    // 5-tap gesture (installDebugSecretTap, main.tsx) → debugPanelOpen.
    if (!open) return null;

    const content = (
        <div
            className={cn(
                "fixed left-3 top-3 z-[9999] pointer-events-auto",
                "w-[300px] max-h-[85vh] overflow-y-auto",
                "bg-background text-foreground border-2 border-amber-500 rounded-md shadow-2xl",
                "text-xs",
            )}
            role="dialog"
            aria-label="Debug phase controls"
        >
            <div className="flex items-center justify-between bg-amber-500 text-white px-2.5 py-1.5">
                <span className="font-poppins font-bold uppercase tracking-wider flex items-center gap-1.5">
                    <Bug className="w-3.5 h-3.5" />
                    Phase tester
                    <span className="font-mono font-semibold normal-case tracking-normal text-[10px] bg-white/20 rounded px-1.5 py-0.5">
                        {APP_VERSION}
                    </span>
                </span>
                <button
                    type="button"
                    onClick={() => debugPanelOpen.set(false)}
                    aria-label="Close debug panel"
                    className="hover:bg-white/20 w-6 h-6 flex items-center justify-center rounded"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            <div className="p-2.5 space-y-3">
                {/* Live counters + current phase indicator. */}
                <div className="text-[10px] text-muted-foreground tabular-nums leading-tight space-y-0.5">
                    <div>
                        Pending: {pendingCount} · All: {$questions.length} ·
                        Inbox unreplied: {inboxUnreplied}
                    </div>
                    <div>
                        Latest question:{" "}
                        <span className="font-semibold text-foreground">
                            {latestQuestion()?.id ?? "—"}
                        </span>
                        {phase && (
                            <>
                                {" · phase: "}
                                <span className="font-semibold text-foreground">
                                    {phaseLabel(phase)}
                                </span>
                            </>
                        )}
                    </div>
                </div>

                {/* Hiding-zone label length. Names are abbreviated
                    (Street → St, …) then truncated to this many chars.
                    0 = abbreviate only, no truncation. */}
                <div className="flex items-center gap-2 text-[11px] rounded border border-border/60 bg-secondary/40 px-2 py-1.5">
                    <span className="shrink-0">
                        Zone label max chars:{" "}
                        <span className="tabular-nums font-semibold">
                            {$labelMaxChars === 0 ? "off" : $labelMaxChars}
                        </span>
                    </span>
                    <input
                        type="range"
                        min={0}
                        max={30}
                        step={1}
                        value={$labelMaxChars}
                        onChange={(e) =>
                            stationLabelMaxChars.set(Number(e.target.value))
                        }
                        className="flex-1 accent-amber-500"
                        aria-label="Hiding-zone label max characters"
                    />
                </div>

                {/* v1009: last body-of-water elimination diagnostic — shows
                    which stage produced (no) overlay: the basemap-water
                    capture, the cold OSM fallback, or the buffer. Configure a
                    body-of-water question, then open this panel to read it. */}
                <div className="text-[11px] rounded border border-border/60 bg-secondary/40 px-2 py-1.5">
                    <span className="text-muted-foreground">
                        Body-of-water:{" "}
                    </span>
                    <span className="tabular-nums break-all">
                        {$bowDiag || "— (configure one to see)"}
                    </span>
                </div>

                <Section
                    title={`GPS spoof · ${$spoof ? "ON" : "off (real GPS)"}`}
                >
                    <DebugButton
                        onClick={() => {
                            if (!spoofRandomInPlayArea()) {
                                toast.error(
                                    "No play area set — pick one first.",
                                    { autoClose: 2500 },
                                );
                                return;
                            }
                            toast.success(
                                "GPS spoofed to a random point in the play area.",
                                { autoClose: 2000 },
                            );
                        }}
                        variant="primary"
                    >
                        🎲 Random point in play area
                    </DebugButton>
                    <DebugButton
                        onClick={() => {
                            if (
                                !polyGeoJSON.get()?.features?.length &&
                                !(
                                    mapGeoLocation.get()?.properties as {
                                        extent?: number[];
                                    }
                                )?.extent
                            ) {
                                toast.error(
                                    "No play area set — pick one first.",
                                    { autoClose: 2500 },
                                );
                                return;
                            }
                            spoofPickMode.set(true);
                            debugPanelOpen.set(false);
                            toast.info(
                                "Tap anywhere inside the play area to set your spoofed location.",
                                { autoClose: 3500 },
                            );
                        }}
                        variant="primary"
                    >
                        📍 Set spoof by tapping the map
                    </DebugButton>
                    {$pickMode && (
                        <DebugButton
                            onClick={() => {
                                spoofPickMode.set(false);
                                toast.info("Spoof pick cancelled.", {
                                    autoClose: 1400,
                                });
                            }}
                            variant="danger"
                        >
                            Cancel tap-to-spoof
                        </DebugButton>
                    )}
                    {$spoof && (
                        <DebugButton
                            onClick={() => {
                                clearGpsSpoof();
                                toast.info(
                                    "Spoof cleared — real GPS resumed.",
                                    {
                                        autoClose: 1800,
                                    },
                                );
                            }}
                            variant="danger"
                        >
                            Clear spoof (use real GPS)
                        </DebugButton>
                    )}
                    {$spoof && (
                        <p className="text-[10px] text-amber-400/90 font-mono px-1">
                            {$spoof.lat.toFixed(5)}, {$spoof.lng.toFixed(5)}
                        </p>
                    )}
                    <p className="text-[10px] text-muted-foreground italic px-1">
                        Overrides your device GPS everywhere (blue dot, question
                        anchors, thermometer, multiplayer broadcast) so you can
                        test play areas worldwide without travelling. Clears on
                        reload.
                    </p>
                </Section>

                <Section title={`Demo game · ${$demo ? "running" : "off"}`}>
                    {$demo ? (
                        <DebugButton onClick={stopDemoGame} variant="danger">
                            Stop demo game
                        </DebugButton>
                    ) : (
                        <div className="grid grid-cols-2 gap-1.5">
                            <DebugButton
                                onClick={() =>
                                    startDemoGame({ asRole: "seeker" })
                                }
                                variant="primary"
                            >
                                Play as seeker
                            </DebugButton>
                            <DebugButton
                                onClick={() =>
                                    startDemoGame({ asRole: "hider" })
                                }
                                variant="primary"
                            >
                                Play as hider
                            </DebugButton>
                        </div>
                    )}
                    <p className="text-[10px] text-muted-foreground italic px-1">
                        Spawns fake bot peers in-browser — no second device
                        needed. Bot hider auto-answers your questions; bot
                        seekers ping locations.
                    </p>
                    <DebugButton
                        onClick={() => {
                            const list = receivedCurses.get();
                            const curse =
                                DEBUG_TEST_CURSES[
                                    list.length % DEBUG_TEST_CURSES.length
                                ];
                            const received = {
                                ...curse,
                                receivedAt: Date.now(),
                                acknowledged: false,
                            };
                            receivedCurses.set([...list, received]);
                            // v1021: also play the reveal animation so it can
                            // be tested on demand.
                            triggerCurseReveal(received);
                        }}
                    >
                        Cast test curse (seeker)
                    </DebugButton>
                    <p className="text-[10px] text-muted-foreground italic px-1">
                        Adds an active curse to the seeker&apos;s inbox — cycles
                        through untimed / timed / dice-roll curses so you can
                        test the CurseInbox UI on demand.
                    </p>
                </Section>

                <Section title="Hidden time (screenshots)">
                    <DebugButton
                        onClick={() => {
                            hiddenCreditMs.set(
                                hiddenCreditMs.get() + 7 * 60_000,
                            );
                            toast.success("+7 min to the current round");
                        }}
                    >
                        +7 min · current round
                    </DebugButton>
                    <DebugButton
                        onClick={() => {
                            const log = roundLog.get();
                            if (log.length === 0) {
                                toast.info("No past rounds yet");
                                return;
                            }
                            roundLog.set(
                                log.map((r) => ({
                                    ...r,
                                    hidingMs: r.hidingMs + 7 * 60_000,
                                })),
                            );
                            toast.success(
                                `+7 min to ${log.length} past round${log.length === 1 ? "" : "s"}`,
                            );
                        }}
                    >
                        +7 min · past rounds
                    </DebugButton>
                    <DebugButton
                        onClick={() => {
                            hiddenCreditMs.set(
                                hiddenCreditMs.get() + 30 * 60_000,
                            );
                            toast.success("+30 min to the current round");
                        }}
                    >
                        +30 min · current round
                    </DebugButton>
                    <DebugButton
                        onClick={() => {
                            const log = roundLog.get();
                            if (log.length === 0) {
                                toast.info("No past rounds yet");
                                return;
                            }
                            roundLog.set(
                                log.map((r) => ({
                                    ...r,
                                    hidingMs: r.hidingMs + 30 * 60_000,
                                })),
                            );
                            toast.success(
                                `+30 min to ${log.length} past round${log.length === 1 ? "" : "s"}`,
                            );
                        }}
                    >
                        +30 min · past rounds
                    </DebugButton>
                    <p className="text-[10px] text-muted-foreground italic px-1">
                        Pads the hidden-time clock for marketing screenshots.
                        Current adds to the live seeking timer (hiddenCredit);
                        past bumps every leaderboard round.
                    </p>
                </Section>

                <Section title={`Role · current: ${$role}`}>
                    <div className="grid grid-cols-2 gap-1.5">
                        <DebugButton
                            onClick={() => forceRole("seeker")}
                            variant={$role === "seeker" ? "primary" : "default"}
                        >
                            → Seeker
                        </DebugButton>
                        <DebugButton
                            onClick={() => forceRole("hider")}
                            variant={$role === "hider" ? "primary" : "default"}
                        >
                            → Hider
                        </DebugButton>
                    </div>
                    <p className="text-[10px] text-muted-foreground italic px-1">
                        Bypasses the production role lock. Resets the route to
                        `/` or `/h` to match.
                    </p>
                </Section>

                <Section title="Hiding period">
                    <DebugButton onClick={endHidingPeriodEarly}>
                        End hiding period now
                    </DebugButton>
                    <p className="text-[10px] text-muted-foreground italic px-1">
                        Snaps the timer to zero so the seeking phase starts
                        immediately. The live UI version of this only lives on
                        the hider's home; the debug copy is for testing from the
                        seeker view.
                    </p>
                </Section>

                <Section title="Add">
                    <DebugButton onClick={addRandomQuestion}>
                        Add random question
                    </DebugButton>
                    <div className="grid grid-cols-2 gap-1.5">
                        {EXAMPLE_QUESTION_ADDERS.map((adder) => (
                            <DebugButton key={adder.label} onClick={adder.run}>
                                {adder.label}
                            </DebugButton>
                        ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground italic px-1">
                        Each injects an example question of that type at the
                        current map centre. Use "Open latest as hider" below to
                        ferry the most recent one into the hider's inbox for
                        round-trip testing. The phase buttons further down
                        operate on whichever question was added last.
                    </p>
                </Section>

                <Section title="Set phase (latest question)">
                    <PhaseButton
                        label="Not sent"
                        active={phase === "not-sent"}
                        disabled={!hasLatest}
                        onClick={() => setPhase("not-sent")}
                    />
                    <PhaseButton
                        label="Waiting for answer"
                        active={phase === "waiting"}
                        disabled={!hasLatest}
                        onClick={() => setPhase("waiting")}
                    />
                    <PhaseButton
                        label="Overdue"
                        active={phase === "overdue"}
                        disabled={!hasLatest}
                        onClick={() => setPhase("overdue")}
                    />
                    <PhaseButton
                        label={`Answered · ${answerLabels.positive}`}
                        active={phase === "answered-yes"}
                        disabled={!hasLatest}
                        onClick={() => setPhase("answered-yes")}
                        accent="primary"
                    />
                    <PhaseButton
                        label={`Answered · ${answerLabels.negative}`}
                        active={phase === "answered-yes"} // visually grouped — see currentPhase()
                        disabled={!hasLatest}
                        onClick={() => setPhase("answered-no")}
                        accent="primary"
                    />
                </Section>

                <Section title="Hider side">
                    <DebugButton
                        onClick={openLatestAsHider}
                        disabled={!hasLatest}
                        variant="primary"
                    >
                        Open latest question as hider →
                    </DebugButton>
                    <div className="text-[10px] uppercase tracking-wider text-white/50 pt-1">
                        Inject question to inbox (from bot seeker's location)
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                        {INBOX_QUESTION_CATEGORIES.map((c) => (
                            <DebugButton
                                key={c.id}
                                onClick={() => injectInboxQuestion(c.id)}
                            >
                                {c.label}
                            </DebugButton>
                        ))}
                    </div>
                    <DebugButton onClick={markLatestInboxReplied}>
                        Mark latest inbox replied
                    </DebugButton>
                    <DebugButton onClick={unreplyLatestInbox}>
                        Un-reply latest inbox
                    </DebugButton>
                    <DebugButton onClick={clearInbox} variant="danger">
                        Clear inbox
                    </DebugButton>

                    {/* Hand-card injection — pulls from a freshly
                        shuffled full deck so the kind distribution
                        matches the real deck. Useful for stacking
                        the hand to test the grid layout, the cast
                        flow, the casting-cost UIs, etc. */}
                    <DebugButton onClick={() => drawRandomCard()}>
                        Add random card to hand
                    </DebugButton>
                    <div className="grid grid-cols-3 gap-1.5">
                        <DebugButton
                            onClick={() => drawRandomCard("time-bonus")}
                        >
                            + Time bonus
                        </DebugButton>
                        <DebugButton onClick={() => drawRandomCard("powerup")}>
                            + Powerup
                        </DebugButton>
                        <DebugButton onClick={() => drawRandomCard("curse")}>
                            + Curse
                        </DebugButton>
                    </div>
                    {/* Specifically pick a curse that requires a
                        die-roll pre-cast — quick way to smoke-test
                        the dice tumble, confetti, and fizzle
                        effects without rolling the random "+ Curse"
                        button until one happens to land. */}
                    <DebugButton
                        onClick={drawRandomRollableCurse}
                        variant="primary"
                    >
                        + Curse with die-roll cost
                    </DebugButton>
                    {/* Batch-fill the hand with distinct random curses so
                        the whole curse-cast flow (dice, discard cost,
                        photo/film capture, Drained Brain picker, …) can be
                        tested in one go. */}
                    <DebugButton
                        onClick={() => fillHandWithCurses()}
                        variant="primary"
                    >
                        Fill hand with random curses
                    </DebugButton>
                </Section>

                <DebugButton onClick={resetQuestions} variant="danger">
                    Reset · clear all questions
                </DebugButton>

                <Section title="Developer tools">
                    <DebugButton
                        onClick={() => {
                            window.location.assign("/debug/cards");
                        }}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            <LayoutGrid className="w-3.5 h-3.5" />
                            Card gallery (all unique cards)
                        </span>
                    </DebugButton>
                    <DebugButton
                        onClick={() => {
                            window.location.assign("/debug/overlays");
                        }}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            <LayoutGrid className="w-3.5 h-3.5" />
                            Overlay gallery (timers, banners, status)
                        </span>
                    </DebugButton>
                    <DebugButton
                        variant="danger"
                        onClick={async () => {
                            const ok = await appConfirm({
                                title: "Clear all local data?",
                                description:
                                    "Wipes every cache, saved game, role, and setting on this device, then reloads as a brand-new first-time player. Can't be undone.",
                                confirmLabel: "Clear & reload",
                                destructive: true,
                            });
                            if (!ok) return;
                            await clearAllLocalDataAndReload();
                        }}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            <Trash2 className="w-3.5 h-3.5" />
                            Clear all data · simulate first visit
                        </span>
                    </DebugButton>
                </Section>

                <p className="text-[10px] text-muted-foreground leading-snug italic pt-1 border-t border-border">
                    Temporary widget for testing the question lifecycle. Remove
                    via `DebugPhaseControls` before release.
                </p>
            </div>
        </div>
    );

    return createPortal(content, document.body);
}

function phaseLabel(p: Phase): string {
    switch (p) {
        case "not-sent":
            return "Not sent";
        case "waiting":
            return "Waiting";
        case "overdue":
            return "Overdue";
        case "answered-yes":
        case "answered-no":
            return "Answered";
    }
}

function Section({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}) {
    return (
        <div>
            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground mb-1.5">
                {title}
            </div>
            <div className="flex flex-col gap-1.5">{children}</div>
        </div>
    );
}

function DebugButton({
    onClick,
    children,
    variant = "default",
    disabled,
}: {
    onClick: () => void;
    children: React.ReactNode;
    variant?: "default" | "primary" | "danger";
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "w-full text-left px-2.5 py-1.5 rounded-sm border border-border",
                "text-xs font-poppins font-medium",
                "transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                variant === "default" && "bg-secondary hover:bg-accent",
                variant === "primary" &&
                    "bg-primary/15 hover:bg-primary/25 text-primary border-primary/40",
                variant === "danger" &&
                    "bg-destructive/15 hover:bg-destructive/25 text-destructive border-destructive/40",
            )}
        >
            {children}
        </button>
    );
}

/**
 * Phase setter button. Highlights when the latest question is currently
 * in this phase so the user can see "you are here" at a glance and can
 * still click to no-op-confirm or apply elsewhere.
 */
function PhaseButton({
    label,
    onClick,
    active,
    disabled,
    accent = "default",
}: {
    label: string;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
    accent?: "default" | "primary";
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={active}
            className={cn(
                "w-full text-left px-2.5 py-1.5 rounded-sm border",
                "text-xs font-poppins font-medium",
                "transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                active
                    ? "bg-amber-500/20 border-amber-500 text-amber-200 font-semibold"
                    : accent === "primary"
                      ? "bg-primary/10 hover:bg-primary/20 text-primary border-primary/30"
                      : "bg-secondary hover:bg-accent border-border",
            )}
        >
            <span className="flex items-center gap-2">
                {active && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
                )}
                {label}
            </span>
        </button>
    );
}

export default DebugPhaseControls;
