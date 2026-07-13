import { useStore } from "@nanostores/react";
import { Ban, Camera, Dices, Loader2, MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

import { CompanionView } from "@/components/CompanionView";
import { DrawPickerDialog } from "@/components/DrawPickerDialog";
import { distanceKm,HiderMap } from "@/components/HiderMap";
import { HiderShell } from "@/components/HiderShell";
import {
    fetchNearest,
    resolveFamily,
} from "@/components/NearestReferencePreview";
import { PhotoCensorDialog } from "@/components/PhotoCensorDialog";
import {
    QuestionOverlayCard,
    summarizeQuestion,
} from "@/components/questionOverlayCard";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { hiderMode } from "@/lib/context";
import {
    answeringQuestion,
    discardCard,
    hiderHand,
    hiderInbox,
    playerRole,
    presentDraw,
    priorAnsweredCount,
    questionIdentity,
    QUESTION_DRAW_BUDGET,
    recordPhotoAnswerDraw,
    roundFoundAt,
    settleLateAnswer,
} from "@/lib/hiderRole";
import { gameSize } from "@/lib/gameSetup";
import { findSubtypeMeta, getSubtypes } from "@/lib/subtypes";
import {
    currentGameCode,
    multiplayerEnabled,
} from "@/lib/multiplayer/session";
import { hiderAnswerQuestion } from "@/lib/multiplayer/store";
import { preparePhotoForSend } from "@/lib/photo";
import {
    decodeFoundFromUrl,
    decodeQuestionFromUrl,
} from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import { hiderifyQuestion } from "@/maps";
import { forwardGeocodeOne } from "@/maps/api";
import type { Question } from "@/maps/schema";

/**
 * Hider route shell. Always renders the persistent hider UI
 * (HiderShell). The "answer this question" flow used to be a full
 * page at `/h?q=…`; v301 turned it into a dialog driven by the
 * `answeringQuestion` atom so the hider can return to whatever
 * they were doing on the map afterwards instead of bouncing back
 * through history.
 *
 * URL entry point still works (share-links from devices not on the
 * multiplayer transport): on mount we decode `?q=`, push the
 * question into the inbox, set the atom (opens the dialog), and
 * strip the param so a reload doesn't re-trigger. `?f=` is the
 * round-end ping from the seeker; same shape.
 */
export function HiderView() {
    const $role = useStore(playerRole);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const q = decodeQuestionFromUrl(params);
        if (q) {
            // Auto-mark this device as the hider when they open a
            // /h?q= link — they're clearly playing the hider side.
            // Don't clobber a co-hider's role though.
            if (playerRole.get() !== "coHider") playerRole.set("hider");
            // Save to inbox if not already there. Keyed by
            // question.key for idempotency.
            const inbox = hiderInbox.get();
            const already = inbox.some((e) => e.key === q.key);
            if (!already) {
                hiderInbox.set([
                    ...inbox,
                    {
                        key: q.key,
                        id: q.id,
                        data: q.data as Record<string, unknown>,
                        arrivedAt: Date.now(),
                    },
                ]);
            }
            // Open the answer dialog.
            answeringQuestion.set(q);
            // Strip ?q= from URL so a reload doesn't reopen the
            // dialog from the URL (the inbox + atom carry the
            // state forward now).
            try {
                const url = new URL(window.location.href);
                if (url.searchParams.has("q")) {
                    url.searchParams.delete("q");
                    window.history.replaceState(
                        {},
                        "",
                        url.pathname + url.search + url.hash,
                    );
                }
            } catch {
                /* noop */
            }
        }

        // `?f=` is the round-end ping from the seeker. Adopt their
        // `foundAt` timestamp so the two devices agree on the elapsed
        // numerator used in scoring. Strip the param afterwards so a
        // reload doesn't re-toast. Idempotent: if `roundFoundAt` is
        // already set we leave it alone — picking up a later forwarded
        // link shouldn't move the end time.
        try {
            const found = decodeFoundFromUrl(params);
            if (found) {
                if (playerRole.get() !== "coHider") playerRole.set("hider");
                if (roundFoundAt.get() === null) {
                    roundFoundAt.set(found.foundAt);
                    toast.success("Seeker says they found you. Round over!", {
                        autoClose: 4000,
                    });
                }
                try {
                    const url = new URL(window.location.href);
                    if (url.searchParams.has("f")) {
                        url.searchParams.delete("f");
                        window.history.replaceState(
                            {},
                            "",
                            url.pathname + url.search + url.hash,
                        );
                    }
                } catch {
                    /* noop */
                }
            }
        } catch (e) {
            console.warn("HiderView (found path) failed:", e);
        }
    }, []);

    // Co-hiders get the read-only hide-team view, never the answer /
    // deck flow — they don't own the canonical hider state.
    if ($role === "coHider") {
        return <CompanionView />;
    }

    return (
        <>
            <HiderShell />
            <HiderAnswerDialog />
            <DrawPickerDialog />
        </>
    );
}

/**
 * Dialog wrapper for the answer flow. Reads `answeringQuestion`
 * atom; renders the question-answer body when set, dismissed when
 * the atom clears (either by Send Answer or manual close).
 */
function HiderAnswerDialog() {
    const $q = useStore(answeringQuestion);
    return (
        <Dialog
            open={$q !== null}
            onOpenChange={(o) => {
                if (!o) answeringQuestion.set(null);
            }}
        >
            <DialogContent
                // The answer dialog is opened FROM inside the Questions drawer
                // (vaul, z-[1055]); a plain Radix Dialog defaults to z-[1050],
                // so it opened BEHIND the drawer (froze the app, same class as
                // the QR dialog). Lift content + overlay above the drawer.
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                    "flex flex-col p-0 gap-0 sm:max-w-md",
                    "max-h-[92vh] z-[1060]",
                )}
                overlayClassName="z-[1060]"
            >
                {$q && <HiderQuestionAnswer question={$q} />}
            </DialogContent>
        </Dialog>
    );
}

/** Inner component once we know we have a valid question. */
function HiderQuestionAnswer({ question }: { question: Question }) {
    const categoryMeta = CATEGORIES[question.id as CategoryId];

    // Hider's live position, lifted out of HiderMap so the answer logic
    // and reveal state can also reference it.
    const [hiderPos, setHiderPos] = useState<{
        lat: number;
        lng: number;
        accuracy: number;
    } | null>(null);

    // Manual fallback for when GPS is denied/unavailable. When set, this
    // overrides the GPS-derived position inside HiderMap, and the manual
    // location panel collapses to a small "edit" affordance.
    const [manualPos, setManualPos] = useState<{
        lat: number;
        lng: number;
        label: string;
    } | null>(null);

    // Whether GPS failed (denied/unsupported). v315: the only thing
    // driving the manual-location UI now. Previously a tiny "set
    // manually" link surfaced even when GPS worked; that's gone —
    // the override is only offered when the device can't locate.
    const [geoFailed, setGeoFailed] = useState(false);

    // v315: map basemap tiles painted? Used together with hiderPos /
    // manualPos / geoFailed to gate the Reveal call-to-action so the
    // hider only sees it once the underlying view is actually ready.
    const [mapReady, setMapReady] = useState(false);

    // Reveal state, lifted so the map can apply a blur until reveal.
    const [revealed, setRevealed] = useState(false);

    // The map shows the seeker's geometry and the hider's pin together,
    // and every question type is now auto-graded through the same engine
    // the seeker uses to preview answer regions. The map can therefore
    // give the answer away (inside vs outside the circle, which Voronoi
    // cell, which side of a boundary), so blur it until the hider
    // explicitly taps to reveal. Photo (and anything unknown) can't be
    // auto-graded, so it isn't blurred.
    const autoComputable =
        question.id === "radius" ||
        question.id === "thermometer" ||
        question.id === "matching" ||
        question.id === "measuring" ||
        question.id === "tentacles";
    const shouldBlurMap = autoComputable && !revealed;

    // Photo answers don't use the hider's location at all — the answer is
    // the image, not a point. Skip the map, its loading/reveal overlays,
    // and the manual-location fallback entirely so the photo dialog is
    // just the prompt + capture controls.
    const isPhoto = question.id === "photo";

    // v315: single readiness gate covering GPS + map. The Reveal
    // overlay (and any answer flow that needs the hider's
    // position) waits behind this until both are in.
    const haveLocation =
        hiderPos !== null || manualPos !== null || geoFailed;
    const allReady = mapReady && haveLocation;
    const loadingStage = !mapReady
        ? "Loading map…"
        : !haveLocation
          ? "Locating you…"
          : null;

    return (
        <div className="flex flex-col min-h-0 flex-1 px-5 pt-4 pb-5 gap-4 overflow-y-auto">
            {/* The question banner uses the SAME shared `QuestionOverlayCard`
                chrome as every card in the seeker view (on-map overlays +
                the questions list) — solid category-colour icon block on the
                left, big bold uppercase label in the deepened category
                colour, one detail line — so the hider's answer dialog reads
                as one system with the rest of the app (v792). A
                visually-hidden DialogTitle/DialogDescription satisfies the
                Radix Dialog a11y contract since the card renders no
                heading. */}
            <DialogTitle className="sr-only">
                {questionPrompt(question)}
            </DialogTitle>
            <DialogDescription className="sr-only">
                {categoryMeta?.label ?? question.id} · answer needed
            </DialogDescription>
            <QuestionOverlayCard
                categoryId={question.id}
                summary={summarizeQuestion({
                    id: question.id,
                    data: question.data as Record<string, unknown>,
                })}
                eyebrow={
                    <span className="text-[color:var(--cat-deep)]">
                        Answer needed
                    </span>
                }
            />

            {!isPhoto && (
                <div className="relative">
                    <div
                        className={cn(
                            "transition-all duration-500",
                            shouldBlurMap && "blur-md scale-[1.02]",
                        )}
                        style={{
                            // Avoid the blur bleeding past the rounded corners
                            // of the map by clipping the wrapper too.
                            overflow: "hidden",
                            borderRadius: "0.375rem",
                        }}
                    >
                        <HiderMap
                            question={question}
                            overridePos={manualPos}
                            onHiderLocationChange={(lat, lng, accuracy) =>
                                setHiderPos({ lat, lng, accuracy })
                            }
                            onGeoError={() => setGeoFailed(true)}
                            onMapReady={() => setMapReady(true)}
                        />
                    </div>
                    {/* v315: unified loading overlay — covers map tiles
                        AND GPS fix. The Reveal CTA only mounts when
                        everything's in, so the hider never taps a fake
                        reveal that drops them into a half-painted view
                        or a "waiting for your location" wall. */}
                    {!allReady && (
                        <div
                            className={cn(
                                "absolute inset-0 rounded-md z-10",
                                "flex items-center justify-center",
                                "bg-background/95 backdrop-blur-sm",
                            )}
                            aria-live="polite"
                        >
                            <div className="flex items-center gap-2">
                                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                                <span className="text-xs uppercase tracking-wider font-poppins font-semibold text-foreground">
                                    {loadingStage}
                                </span>
                            </div>
                        </div>
                    )}
                    {allReady && shouldBlurMap && (
                        /* The blurred map is the tap target — v288 dropped
                           the separate "Reveal answer" button below the
                           map in favour of this single in-place gesture. */
                        <button
                            type="button"
                            onClick={() => setRevealed(true)}
                            aria-label="Tap the map to reveal your answer"
                            className={cn(
                                "absolute inset-0 rounded-md",
                                "flex items-center justify-center",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            <span className="bg-background/70 backdrop-blur-sm px-4 py-2 rounded-full text-xs uppercase tracking-wider font-poppins font-semibold text-foreground border border-border">
                                Tap the map to reveal your answer
                            </span>
                        </button>
                    )}
                </div>
            )}

            {/* v315: manual-location panel now ONLY appears when GPS
                actually failed. The previous "set location manually"
                link that surfaced even on a working GPS is gone —
                that was noise the user never asked to see. Once the
                answer is revealed the panel also disappears so the
                override doesn't sit next to a committed answer. */}
            {!isPhoto && geoFailed && !revealed && (
                <ManualLocationPanel
                    geoFailed={geoFailed}
                    manualPos={manualPos}
                    onSet={(pos) => setManualPos(pos)}
                    onClear={() => setManualPos(null)}
                />
            )}

            {/* Cards the hider can play in RESPONSE to this question
                (rulebook p65). The answer dialog is modal, so without
                surfacing them here the hand is unreachable at the one
                moment Veto / Randomize are meant to be used. */}
            <ResponseCardActions question={question} hiderPos={hiderPos} />

            <main>
                <AnswerControls
                    question={question}
                    hiderPos={hiderPos}
                    revealed={revealed}
                />
            </main>
        </div>
    );
}

/**
 * Veto / Randomize actions, shown in the answer dialog only when the
 * hider actually holds the matching card.
 *
 *   - Veto: discard the card, mark this question handled WITHOUT an
 *     answer (so it stops nagging as unanswered) and earn no card. The
 *     seekers get no answer but may ask their next question.
 *   - Randomize: discard the card; the app picks a random different
 *     substitute question of the same category, auto-grades it through
 *     the universal `hiderifyQuestion` engine (the same code the seeker
 *     uses to preview answer regions), and sends the verdict. Works for
 *     every question type.
 */
function ResponseCardActions({
    question,
    hiderPos,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
}) {
    const $hand = useStore(hiderHand);
    const [busy, setBusy] = useState(false);
    const vetoCard = $hand.find(
        (c) => c.kind === "powerup" && c.powerup === "veto",
    );
    const randomizeCard = $hand.find(
        (c) => c.kind === "powerup" && c.powerup === "randomize",
    );
    // Randomize swaps the question to a random different substitute of
    // the SAME category. For the five spatial types it auto-grades the
    // substitute through the universal hider engine and sends the verdict
    // immediately. For photo there's nothing to auto-grade — a substitute
    // photo still has to be taken — so it swaps the requested subtype in
    // place and leaves the dialog open for the hider to take that photo.
    const showRandomize = Boolean(randomizeCard);
    const isPhoto = question.id === "photo";
    if (!vetoCard && !showRandomize) return null;

    const markHandled = (
        reply: Record<string, unknown>,
        // v673: optional patch merged into the answered entry's `data`.
        // Used by Randomize to swap the entry's identity to the SUBSTITUTE
        // question (rulebook p376: the ORIGINAL is NOT considered asked —
        // re-askable at its original cost — while the SUBSTITUTE was
        // asked). Locally this makes `questionIdentity`/`priorAnsweredCount`
        // key on the substitute; it also exactly mirrors what the
        // multiplayer/demo echo already does (`{...q.data, ...answer}` in
        // GameRoom/demoBroker), so solo and online behave identically.
        // Veto passes no patch — a vetoed question IS considered asked, so
        // its original identity must stay.
        dataPatch?: Record<string, unknown>,
    ) => {
        const inbox = hiderInbox.get();
        hiderInbox.set(
            inbox.map((e) =>
                e.key === question.key && !e.repliedAt
                    ? {
                          ...e,
                          data: dataPatch
                              ? { ...e.data, ...dataPatch }
                              : e.data,
                          repliedAt: Date.now(),
                          reply,
                      }
                    : e,
            ),
        );
        // Mirror to the seeker over the wire (drag:false + the marker),
        // so they're notified + the question log shows it.
        hiderAnswerQuestion(question.key, reply);
    };

    const playVeto = () => {
        if (!vetoCard || busy) return;
        discardCard(vetoCard.id);
        // No presentDraw — veto earns no reward (rulebook p65). The
        // `vetoed` marker makes the seeker eliminate nothing.
        markHandled({ drag: false, vetoed: true });
        toast.info(
            "Veto played — the seekers are told no answer is coming. You earn no reward, but they can still ask their next question.",
            { autoClose: 5000 },
        );
        answeringQuestion.set(null);
    };

    // Photo randomize: pick a random different photo subtype, swap the
    // request in place, and keep the dialog open so the hider takes THAT
    // photo. The randomized markers ride along when the photo is committed
    // (PhotoAnswer reads them off the question data).
    const playRandomizePhoto = () => {
        if (!randomizeCard || busy) return;
        const d = question.data as { type?: string };
        const candidates = (getSubtypes("photo", gameSize.get()) ?? []).filter(
            (s) => s.value !== d.type,
        );
        if (candidates.length === 0) {
            toast.error("No other photo type to randomize to.");
            return;
        }
        const pick =
            candidates[Math.floor(Math.random() * candidates.length)];
        const fromLabel =
            (d.type && findSubtypeMeta(d.type)?.label) ?? d.type ?? "photo";
        discardCard(randomizeCard.id);
        const newData = {
            ...(question.data as Record<string, unknown>),
            type: pick.value,
            randomized: true,
            randomizedFrom: fromLabel,
        };
        // Persist the swap to the inbox and the open dialog so the prompt
        // + capture flow reflect the new subtype.
        const inbox = hiderInbox.get();
        hiderInbox.set(
            inbox.map((e) =>
                e.key === question.key ? { ...e, data: newData } : e,
            ),
        );
        answeringQuestion.set({ ...question, data: newData } as Question);
        toast.success(
            `Randomized to a "${pick.label}" photo — take that photo instead.`,
            { autoClose: 5000 },
        );
        // Dialog stays open; the hider now takes the new photo.
    };

    const playRandomize = async () => {
        if (!randomizeCard || busy) return;
        if (isPhoto) {
            playRandomizePhoto();
            return;
        }
        if (!hiderPos) {
            toast.error("Need your GPS fix before randomizing.");
            return;
        }
        setBusy(true);
        try {
            const result = await computeRandomizedAnswer(question, hiderPos);
            if (!result) {
                toast.error(
                    "Couldn't auto-answer a substitute question here — no usable category to randomize to.",
                );
                return;
            }
            discardCard(randomizeCard.id);
            const reply = {
                drag: false,
                randomized: true,
                randomizedFrom: result.fromLabel,
                ...result.answer,
            };
            // Re-key the answered entry to the SUBSTITUTE question's
            // identity (result.answer carries the swapped type /
            // locationType / radius+unit) so repeat-cost counts the
            // substitute as asked and leaves the original re-askable at
            // its original cost. Same shape the online echo merges.
            markHandled(reply, reply);
            toast.success(
                `Randomized to a ${result.toLabel} question — answered automatically and sent to the seeker.`,
                { autoClose: 5000 },
            );
            answeringQuestion.set(null);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-2">
            {showRandomize && (
                <button
                    type="button"
                    onClick={playRandomize}
                    disabled={busy}
                    className={cn(
                        "w-full flex items-center gap-3 rounded-lg border-2 p-3 text-left transition-colors",
                        "border-[hsl(265,60%,60%)]/40 bg-[hsl(265,60%,60%)]/10",
                        "hover:bg-[hsl(265,60%,60%)]/15 disabled:opacity-50",
                    )}
                >
                    <Dices className="w-5 h-5 shrink-0 text-[hsl(265,60%,72%)]" />
                    <span className="min-w-0">
                        <span className="block text-sm font-poppins font-bold">
                            {busy ? "Randomizing…" : "Play Randomize"}
                        </span>
                        <span className="block text-[11px] text-muted-foreground leading-snug">
                            {isPhoto
                                ? "Switch to a random different photo and take that one instead."
                                : `Answer a random different ${question.id} question instead — auto-graded and sent.`}
                        </span>
                    </span>
                </button>
            )}
            {vetoCard && (
                <button
                    type="button"
                    onClick={playVeto}
                    disabled={busy}
                    className={cn(
                        "w-full flex items-center gap-3 rounded-lg border-2 p-3 text-left transition-colors",
                        "border-destructive/40 bg-destructive/10",
                        "hover:bg-destructive/15 disabled:opacity-50",
                    )}
                >
                    <Ban className="w-5 h-5 shrink-0 text-destructive" />
                    <span className="min-w-0">
                        <span className="block text-sm font-poppins font-bold">
                            Play Veto
                        </span>
                        <span className="block text-[11px] text-muted-foreground leading-snug">
                            Send no answer. No reward, but the seekers can
                            ask their next question.
                        </span>
                    </span>
                </button>
            )}
        </div>
    );
}

/**
 * Grade a question through the canonical hider engine — the exact same
 * `hiderifyQuestion` the seeker uses to preview answer regions. Clones
 * the question (so the live one is never mutated), flips the global
 * `hiderMode` atom to the hider's live GPS for the duration of the
 * grade, then restores it. Returns the graded `data` (with `within` /
 * `warmer` / `same` / `hiderCloser` / `location` filled in).
 */
async function gradeViaEngine(
    question: Question,
    hiderPos: { lat: number; lng: number },
): Promise<Record<string, unknown>> {
    const clone = {
        ...question,
        data: { ...(question.data as Record<string, unknown>), drag: true },
    } as Question;
    const prev = hiderMode.get();
    hiderMode.set({ latitude: hiderPos.lat, longitude: hiderPos.lng });
    try {
        await hiderifyQuestion(clone);
    } finally {
        hiderMode.set(prev);
    }
    return clone.data as Record<string, unknown>;
}

/** Radar (radius) presets — randomize picks a different one. */
const RADIUS_PRESETS = [
    { label: "500 m", radius: 500, unit: "meters" },
    { label: "1 km", radius: 1, unit: "kilometers" },
    { label: "2 km", radius: 2, unit: "kilometers" },
    { label: "5 km", radius: 5, unit: "kilometers" },
    { label: "10 km", radius: 10, unit: "kilometers" },
] as const;

/**
 * Auto-grade a randomized substitute through the SAME engine the seeker
 * uses to preview answer regions (`hiderifyQuestion`).
 *
 * The rulebook's Randomize replaces the asked question with a randomly
 * chosen different question of the same category. We do exactly that:
 * clone the question, swap it to a random substitute (a different
 * subtype for matching/measuring/tentacles, a different radius for
 * radar; thermometer has no parameter to vary so it grades as-is), put
 * the engine into hider mode at the hider's live GPS, run
 * `hiderifyQuestion`, then read back the graded fields.
 *
 * Because it's the canonical grader, EVERY question type is gradable —
 * there is no "couldn't auto-compute" path anymore. Returns the wire
 * answer fields (swapped parameters + grade) plus from/to labels for the
 * toast, or null only if there's genuinely no GPS fix.
 */
async function computeRandomizedAnswer(
    question: Question,
    hiderPos: { lat: number; lng: number },
): Promise<{
    answer: Record<string, unknown>;
    fromLabel: string;
    toLabel: string;
} | null> {
    const cat = question.id;
    // Deep-ish clone so we never mutate the live question while grading.
    // `drag: true` is what gates the engine into "compute the answer".
    const clone = {
        ...question,
        data: { ...(question.data as Record<string, unknown>), drag: true },
    } as Question;
    const data = clone.data as Record<string, unknown>;

    let fromLabel: string = CATEGORIES[cat as CategoryId]?.label ?? cat;
    let toLabel: string = fromLabel;

    if (cat === "matching" || cat === "measuring" || cat === "tentacles") {
        const subs = getSubtypes(cat, gameSize.get());
        const currentSub = (
            cat === "tentacles" ? data.locationType : data.type
        ) as string | undefined;
        const candidates = (subs ?? []).filter((s) => s.value !== currentSub);
        if (candidates.length > 0) {
            const pick =
                candidates[Math.floor(Math.random() * candidates.length)];
            fromLabel =
                (currentSub && findSubtypeMeta(currentSub)?.label) ??
                currentSub ??
                fromLabel;
            toLabel = pick.label;
            if (cat === "tentacles") data.locationType = pick.value;
            else data.type = pick.value;
        }
    } else if (cat === "radius") {
        const candidates = RADIUS_PRESETS.filter(
            (p) => !(p.radius === data.radius && p.unit === data.unit),
        );
        const pick =
            candidates[Math.floor(Math.random() * candidates.length)] ??
            RADIUS_PRESETS[0];
        fromLabel = `Radar ${data.radius} ${data.unit}`;
        toLabel = `Radar ${pick.label}`;
        data.radius = pick.radius;
        data.unit = pick.unit;
    }
    // thermometer: no parameter to randomize — grade the question as-is.

    const out = await gradeViaEngine(clone, hiderPos);
    // Send the swapped parameters + the engine's verdict. `drag:false`
    // is added by the caller's `markHandled`.
    let answer: Record<string, unknown>;
    switch (cat) {
        case "radius":
            answer = {
                radius: out.radius,
                unit: out.unit,
                within: out.within,
            };
            break;
        case "thermometer":
            answer = { warmer: out.warmer };
            break;
        case "matching":
            answer = {
                type: out.type,
                same: out.same,
                lengthComparison: out.lengthComparison,
            };
            break;
        case "measuring":
            answer = { type: out.type, hiderCloser: out.hiderCloser };
            break;
        case "tentacles":
            answer = { locationType: out.locationType, location: out.location };
            break;
        default:
            answer = {};
    }
    return { answer, fromLabel, toLabel };
}

/** Title-cases a hyphenated subtype slug ("same-street" → "Same Street"). */
function niceSubtype(raw: unknown): string {
    return String(raw ?? "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Human-readable question prompt, varies by type. */
function questionPrompt(question: Question): string {
    const d = question.data as any;
    switch (question.id) {
        case "radius":
            return `Are you within ${question.data.radius} ${unitLabel(
                question.data.unit,
            )} of the seeker's point?`;
        case "thermometer":
            return `After the seeker moved, did they get warmer or colder relative to you?`;
        case "matching":
            return d.type
                ? `Do we both share the same ${niceSubtype(d.type)}?`
                : `Do we match on this attribute?`;
        case "measuring":
            return d.type
                ? `Are you closer or further than the seeker to the nearest ${niceSubtype(d.type)}?`
                : `Are you closer or further than the seeker from this feature?`;
        case "tentacles":
            return `What is the closest ${niceSubtype(d.locationType) || "location"} to you?`;
        case "photo":
            return d.type
                ? `Send a photo of ${niceSubtype(d.type)}`
                : `Send the requested photo`;
        default:
            return "Answer this question";
    }
}

function unitLabel(unit: string): string {
    switch (unit) {
        case "miles":
            return "miles";
        case "meters":
            return "meters";
        case "kilometers":
        default:
            return "km";
    }
}

/** Answer flow. Every type below is auto-graded through the same engine
 *  the seeker uses to preview answer regions, behind the tap-to-reveal
 *  gesture:
 *   - radius / thermometer: computed locally from GPS (exact, synchronous).
 *   - matching / measuring: graded via `hiderifyQuestion`; the binary
 *     toggle is pre-selected to the verdict and stays available as an
 *     override (GPS noise / missing boundary data).
 *   - tentacles: graded via `hiderifyQuestion` (nearest Voronoi cell);
 *     the detected place can be overridden by hand.
 */
function AnswerControls({
    question,
    hiderPos,
    revealed,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
    revealed: boolean;
}) {
    switch (question.id) {
        case "radius":
        case "thermometer":
            return (
                <RevealAnswer
                    question={question}
                    hiderPos={hiderPos}
                    revealed={revealed}
                />
            );
        case "matching":
            // same-length-station is a 3-way length comparison, not a binary
            // match — it needs its own control that sends `lengthComparison`
            // (v824). Every other matching subtype is binary Match/No-match.
            if (
                (question.data as { type?: string }).type ===
                "same-length-station"
            ) {
                return (
                    <AutoGradedLengthAnswer
                        question={question}
                        hiderPos={hiderPos}
                        revealed={revealed}
                    />
                );
            }
            return (
                <AutoGradedBinaryAnswer
                    question={question}
                    hiderPos={hiderPos}
                    revealed={revealed}
                    field="same"
                    labels={{ true: "Match", false: "No match" }}
                />
            );
        case "measuring":
            return (
                <AutoGradedBinaryAnswer
                    question={question}
                    hiderPos={hiderPos}
                    revealed={revealed}
                    field="hiderCloser"
                    labels={{ true: "Closer", false: "Further" }}
                />
            );
        case "tentacles":
            return (
                <AutoGradedTentaclesAnswer
                    question={question}
                    hiderPos={hiderPos}
                    revealed={revealed}
                />
            );
        case "photo":
            return <PhotoAnswer question={question} />;
        default:
            return (
                <p className="text-sm text-muted-foreground text-center py-8">
                    This question type isn't supported for share-link answers
                    yet. Reply to the seeker directly.
                </p>
            );
    }
}

/**
 * Photo answer, in-dialog. The hider takes/picks a photo, runs it through
 * the crop/censor editor, and it's compressed + uploaded (full detail to
 * R2, thumbnail locally) via the shared `preparePhotoForSend` pipeline —
 * the exact same path the photo card uses. "I cannot answer" is the
 * rulebook decline (p32). Either resolution sends to the seeker, stamps
 * the inbox + draws the photo reward via `recordPhotoAnswerDraw`, and
 * closes the dialog.
 *
 * This is what makes photo answerable from the hider's primary flow — the
 * unanswered-overlay / question-log row that opens this dialog used to
 * dead-end on photo (no case → "not supported").
 */
function PhotoAnswer({ question }: { question: Question }) {
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [pendingFile, setPendingFile] = useState<File | null>(null);
    const [busy, setBusy] = useState(false);

    const d = question.data as {
        type?: string;
        randomized?: boolean;
        randomizedFrom?: string;
    };
    const subtypeLabel = d.type ? findSubtypeMeta(d.type)?.label : undefined;

    // Carry the current subtype + any randomize markers along with the
    // answer, so a photo randomized to a different subtype reaches the
    // seeker as that subtype (and shows as randomized in their log).
    const markers: Record<string, unknown> = {
        ...(d.type ? { type: d.type } : {}),
        ...(d.randomized
            ? { randomized: true, randomizedFrom: d.randomizedFrom }
            : {}),
    };

    const commit = async (file: File) => {
        setBusy(true);
        try {
            const online = multiplayerEnabled.get() && !!currentGameCode.get();
            const { photoUri, photoUrl, fellBack } = await preparePhotoForSend(
                file,
                online,
            );
            // Local reply keeps both so the hider's own log renders it;
            // the wire reply prefers the URL to stay tiny.
            const localReply = {
                ...markers,
                photoUri,
                ...(photoUrl ? { photoUrl } : {}),
                declined: false,
                drag: false,
            };
            hiderAnswerQuestion(
                question.key,
                photoUrl
                    ? { ...markers, photoUrl, declined: false, drag: false }
                    : { ...markers, photoUri, declined: false, drag: false },
            );
            recordPhotoAnswerDraw(question.key, localReply);
            toast[fellBack ? "warn" : "success"](
                fellBack
                    ? "Couldn't upload the full-size photo — sent a smaller preview instead."
                    : "Photo sent.",
                { autoClose: fellBack ? 4000 : 2000 },
            );
            answeringQuestion.set(null);
        } catch (e) {
            console.warn("photo answer failed", e);
            toast.error("Couldn't process that photo. Try another one.");
        } finally {
            setBusy(false);
        }
    };

    const decline = () => {
        if (busy) return;
        const reply = { ...markers, declined: true, drag: false };
        hiderAnswerQuestion(question.key, reply);
        recordPhotoAnswerDraw(question.key, reply);
        toast.info('Answered "I cannot answer the question."', {
            autoClose: 2500,
        });
        answeringQuestion.set(null);
    };

    return (
        <div className="space-y-3">
            <p className="text-xs text-muted-foreground leading-snug text-center">
                {subtypeLabel
                    ? `Take a photo for "${subtypeLabel}". `
                    : "Take the requested photo. "}
                You can crop and black out identifying detail before it sends.
            </p>

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(e) => {
                    const picked = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (picked) setPendingFile(picked);
                }}
            />

            <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="w-full gap-2 py-7 text-base font-semibold"
                size="lg"
            >
                <Camera className="w-5 h-5" />
                {busy ? "Sending…" : "Take or choose photo"}
            </Button>

            <Button
                type="button"
                variant="ghost"
                onClick={decline}
                disabled={busy}
                className="w-full gap-2 text-muted-foreground"
            >
                <Ban className="w-4 h-4" />
                I cannot answer this
            </Button>

            {pendingFile && (
                <PhotoCensorDialog
                    file={pendingFile}
                    onCancel={() => setPendingFile(null)}
                    onConfirm={(redacted) => {
                        setPendingFile(null);
                        commit(redacted);
                    }}
                />
            )}
        </div>
    );
}

/**
 * Reveal-then-share flow for auto-computable questions (radius, thermometer).
 *
 * Before reveal: shows a big "Reveal answer" button. Map is the spatial hint.
 * After reveal: shows the auto-computed answer with distance numbers, then
 * morphs into share / copy buttons for sending back to the seeker.
 */
function RevealAnswer({
    question,
    hiderPos,
    revealed,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
    revealed: boolean;
}) {
    // Don't allow reveal until we have a GPS fix.
    if (!hiderPos) {
        return (
            <p className="text-sm text-center text-muted-foreground py-6">
                Waiting for your location…
            </p>
        );
    }

    const computed = computeAnswer(question, hiderPos);
    if (!computed) {
        // Shouldn't happen for radius/thermometer, but guard for safety.
        return null;
    }

    // v288: the reveal gesture moved onto the blurred map itself.
    // Before reveal, this slot is empty — the map's overlay button
    // is the only call-to-action; the answer card + send button
    // appear here once revealed.
    if (!revealed) {
        return null;
    }

    return (
        <div className="space-y-4">
            <div className="rounded-lg p-5 border-2 border-primary bg-primary/10 text-center">
                <div className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold mb-2">
                    Your answer
                </div>
                <div className="text-3xl font-poppins font-bold text-primary mb-1">
                    {computed.label}
                </div>
                <div className="text-sm text-muted-foreground">
                    {computed.detail}
                </div>
            </div>

            <ShareBackRow
                question={question}
                answer={computed.payload}
                shareText={`My answer: ${computed.label}.`}
            />
        </div>
    );
}

/**
 * Compute the answer for question types we can derive from GPS alone.
 * Returns { label, detail, payload } where payload is the partial-data
 * merge sent back to the seeker.
 */
function computeAnswer(
    question: Question,
    hiderPos: { lat: number; lng: number },
): { label: string; detail: string; payload: Record<string, unknown> } | null {
    const d = question.data as any;
    if (question.id === "radius") {
        const km = distanceKm(hiderPos.lat, hiderPos.lng, d.lat, d.lng);
        const rKm =
            d.unit === "miles"
                ? d.radius * 1.609344
                : d.unit === "meters"
                  ? d.radius / 1000
                  : d.radius;
        const inside = km <= rKm;
        return {
            label: inside ? "Inside" : "Outside",
            detail: `You are ${km.toFixed(2)} km from the seeker's point (radius ${d.radius} ${unitLabel(d.unit)}).`,
            payload: { within: inside },
        };
    }
    if (question.id === "thermometer") {
        const dA = distanceKm(hiderPos.lat, hiderPos.lng, d.latA, d.lngA);
        const dB = distanceKm(hiderPos.lat, hiderPos.lng, d.latB, d.lngB);
        // "warmer" means the new location (B) is closer to the hider than the
        // start (A). That means dB < dA.
        const warmer = dB < dA;
        return {
            label: warmer ? "Warmer" : "Colder",
            detail: `Start: ${dA.toFixed(2)} km away · End: ${dB.toFixed(2)} km away.`,
            payload: { warmer },
        };
    }
    return null;
}

/**
 * Auto-graded binary answer (matching / measuring). Runs the question
 * through the universal `hiderifyQuestion` engine at the hider's live
 * GPS and pre-selects the resulting verdict. The two-button toggle stays
 * live as an override — the engine can be wrong when the hider device is
 * missing the play-area boundary (zone matching) or GPS is noisy, so the
 * hider always has the final say. Hidden until the map is revealed,
 * mirroring the radius/thermometer reveal gesture.
 */
function AutoGradedBinaryAnswer({
    question,
    hiderPos,
    revealed,
    field,
    labels,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
    revealed: boolean;
    field: "same" | "hiderCloser";
    labels: { true: string; false: string };
}) {
    // null = not graded yet; the engine's verdict otherwise.
    const [computed, setComputed] = useState<boolean | null>(null);
    const [grading, setGrading] = useState(false);
    // The hider's manual override, if they tapped a button.
    const [override, setOverride] = useState<boolean | null>(null);

    useEffect(() => {
        if (!hiderPos) return;
        let cancelled = false;
        setGrading(true);
        const d = question.data as Record<string, unknown>;

        const compute = async (): Promise<boolean | null> => {
            // v792: for MEASURING (closer/further) with a resolvable nearest
            // reference (coastline / airport / POI / …), derive the verdict
            // straight from the seeker's and hider's nearest-reference
            // distances — the same numbers the map now draws, and far more
            // reliable than the full-area elimination engine (which returned
            // NO verdict for coastline, leaving nothing selected). Matching's
            // station-property subtypes (same train line / name length) can't
            // use a nearest-reference identity, so they stay on the engine.
            if (
                field === "hiderCloser" &&
                typeof d.lat === "number" &&
                typeof d.lng === "number"
            ) {
                const family = resolveFamily(d.type as string);
                if (family) {
                    const [s, h] = await Promise.all([
                        fetchNearest(family, d.lat as number, d.lng as number).catch(
                            () => null,
                        ),
                        fetchNearest(family, hiderPos.lat, hiderPos.lng).catch(
                            () => null,
                        ),
                    ]);
                    if (s && h) return h.distanceMeters < s.distanceMeters;
                }
            }
            const data = await gradeViaEngine(question, hiderPos);
            const v = data[field];
            return typeof v === "boolean" ? v : null;
        };

        compute()
            .then((v) => {
                if (!cancelled && v !== null) setComputed(v);
            })
            .catch(() => {
                /* leave computed null → hider picks manually */
            })
            .finally(() => {
                if (!cancelled) setGrading(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [question.key, hiderPos?.lat, hiderPos?.lng, field]);

    if (!revealed) return null;

    if (!hiderPos) {
        return (
            <p className="text-sm text-center text-muted-foreground py-6">
                Waiting for your location…
            </p>
        );
    }

    const effective = override ?? computed;

    return (
        <div className="space-y-3">
            <p className="text-xs text-center text-muted-foreground font-poppins">
                {grading && computed === null ? (
                    <span className="inline-flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Computing your answer…
                    </span>
                ) : computed === null && override === null ? (
                    // Grading finished but produced no verdict (e.g. the
                    // coastline geometry couldn't be fetched) — be honest and
                    // ask the hider to pick, rather than claiming it was
                    // auto-computed while nothing is selected (v790).
                    "Couldn't auto-compute your answer — pick it below."
                ) : (
                    "Auto-computed from your location — tap to change if it's wrong."
                )}
            </p>
            <div className="grid grid-cols-2 gap-3">
                {([true, false] as const).map((value) => {
                    const isSelected = effective === value;
                    return (
                        <button
                            key={String(value)}
                            type="button"
                            onClick={() => setOverride(value)}
                            className={cn(
                                "py-6 rounded-lg font-poppins font-semibold text-lg",
                                "transition-all border-2",
                                isSelected
                                    ? "bg-primary text-primary-foreground border-primary"
                                    : "bg-secondary text-foreground border-border hover:bg-accent",
                            )}
                        >
                            {value ? labels.true : labels.false}
                        </button>
                    );
                })}
            </div>

            {effective !== null && (
                <ShareBackRow
                    question={question}
                    answer={{ [field]: effective }}
                    shareText={`My answer: ${
                        effective ? labels.true : labels.false
                    }.`}
                />
            )}
        </div>
    );
}

/**
 * Auto-graded 3-way answer for matching `same-length-station` — the
 * rulebook "Station Name's Length" question compares the LENGTHS of the
 * hider's and seeker's nearest station names (shorter / same / longer),
 * NOT a binary match. It grades through the same `hiderifyQuestion` engine
 * (which sets `lengthComparison`) and sends THAT field, so the seeker's
 * elimination (`matchingStationBoundary`, keyed on `lengthComparison`)
 * agrees. v824 fix: this subtype was wrongly routed through the binary
 * `same` control, which never set `lengthComparison`, so the seeker graded
 * every "shorter"/"longer" answer as "same" → wrong map cut.
 */
function AutoGradedLengthAnswer({
    question,
    hiderPos,
    revealed,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
    revealed: boolean;
}) {
    type Cmp = "shorter" | "same" | "longer";
    const [computed, setComputed] = useState<Cmp | null>(null);
    const [grading, setGrading] = useState(false);
    const [override, setOverride] = useState<Cmp | null>(null);

    useEffect(() => {
        if (!hiderPos) return;
        let cancelled = false;
        setGrading(true);
        gradeViaEngine(question, hiderPos)
            .then((data) => {
                const v = data.lengthComparison;
                if (
                    !cancelled &&
                    (v === "shorter" || v === "same" || v === "longer")
                ) {
                    setComputed(v);
                }
            })
            .catch(() => {
                /* leave null → hider picks manually */
            })
            .finally(() => {
                if (!cancelled) setGrading(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [question.key, hiderPos?.lat, hiderPos?.lng]);

    if (!revealed) return null;
    if (!hiderPos) {
        return (
            <p className="text-sm text-center text-muted-foreground py-6">
                Waiting for your location…
            </p>
        );
    }

    const effective = override ?? computed;
    const OPTIONS: Array<{ value: Cmp; label: string }> = [
        { value: "shorter", label: "Shorter" },
        { value: "same", label: "Same" },
        { value: "longer", label: "Longer" },
    ];

    return (
        <div className="space-y-3">
            <p className="text-xs text-center text-muted-foreground font-poppins">
                {grading && computed === null ? (
                    <span className="inline-flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Computing your answer…
                    </span>
                ) : computed === null && override === null ? (
                    "Couldn't auto-compute your answer — pick it below."
                ) : (
                    "Your station name vs the seeker's — tap to change if wrong."
                )}
            </p>
            <div className="grid grid-cols-3 gap-2">
                {OPTIONS.map(({ value, label }) => {
                    const isSelected = effective === value;
                    return (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setOverride(value)}
                            className={cn(
                                "py-6 rounded-lg font-poppins font-semibold text-base",
                                "transition-all border-2",
                                isSelected
                                    ? "bg-primary text-primary-foreground border-primary"
                                    : "bg-secondary text-foreground border-border hover:bg-accent",
                            )}
                        >
                            {label}
                        </button>
                    );
                })}
            </div>

            {effective !== null && (
                <ShareBackRow
                    question={question}
                    answer={{ lengthComparison: effective }}
                    shareText={`My station name is ${effective} than yours.`}
                />
            )}
        </div>
    );
}

/**
 * Single "Send answer" CTA. In multiplayer the answer rides the
 * wire transport directly via `hiderAnswerQuestion` (called inside
 * `markRepliedInInbox`); in solo/offline it just stamps the local
 * inbox. Either way no share/copy URL is surfaced — the hider
 * answers in-app, the share-link round-trip was retired in v287.
 */
function ShareBackRow({
    question,
    answer,
}: {
    question: Question;
    answer: Record<string, unknown>;
    /** Retained for call-site symmetry across question types but no
     *  longer rendered — kept optional to ease the migration. */
    shareText?: string;
}) {
    const markRepliedInInbox = () => {
        const inbox = hiderInbox.get();
        const existing = inbox.find((e) => e.key === question.key);
        const alreadyReplied = Boolean(existing?.repliedAt);

        // Rulebook p61: settle the answer's timing first. An overdue
        // answer pauses the hider's clock (accrued in hiddenDebitMs)
        // and earns no card. Only meaningful on the first reply.
        const late = !alreadyReplied
            ? settleLateAnswer(question.key, question.id)
            : false;

        hiderInbox.set(
            inbox.map((e) =>
                e.key === question.key
                    ? { ...e, repliedAt: Date.now(), reply: answer }
                    : e,
            ),
        );

        // Mirror the answer through the multiplayer transport so the
        // seeker's `questions` store flips to drag:false + answer
        // merged. No-op in local-only mode.
        hiderAnswerQuestion(question.key, answer);

        // Card-draw reward (rulebook p16-37). The draw budget is by
        // category — matching draws 3/keeps 1, radar 2/1, photo 1/1,
        // tentacle 4/2 etc.  When `keep === draw` (photo) the draw
        // auto-resolves into the hand; otherwise the DrawPickerDialog
        // modal opens and the hider picks K of N. Skipped when the
        // answer was late — no reward for an overdue answer.
        if (!alreadyReplied && !late) {
            const budget = QUESTION_DRAW_BUDGET[question.id];
            if (budget) {
                // Rulebook p65: a repeated question pays its cost N×.
                // The seekers' N-th ask runs the draw-keep cycle N
                // times — NOT once with a multiplied draw count
                // (rulebook is explicit: "draw 3, keep 1, then draw 3,
                // keep 1 again. Importantly: hiders cannot draw 6 and
                // keep 2"). Identity excludes this question's own key
                // so we count prior answers only.
                const identity = questionIdentity(question.id, question.data);
                const cycles = priorAnsweredCount(question.key, identity) + 1;
                if (cycles > 1) {
                    toast.info(
                        `Repeat question — running the draw cycle ${cycles}× (rulebook p65).`,
                        { autoClose: 4000 },
                    );
                }
                // v315: dropped the "Drew N from deck" / "Pick K of N"
                // toasts that used to fire here. The DrawPickerDialog
                // (or the new card appearing in the fan when the
                // draw auto-resolves) is the confirmation; a
                // notification on top doubled the same moment.
                for (let i = 0; i < cycles; i++) {
                    presentDraw(
                        budget.draw,
                        budget.keep,
                        question.id,
                        question.key,
                    );
                }
            }
        } else if (late) {
            toast.info(
                "Answered after the time limit — your clock was paused until now and no card is drawn (rulebook).",
                { autoClose: 5000 },
            );
        }
    };

    return (
        <div className="space-y-2">
            <Button
                onClick={() => {
                    markRepliedInInbox();
                    // v315: the "Answer sent." confirmation toast is
                    // gone. The dialog closing IS the confirmation;
                    // the toast on top of that just stacked notif
                    // chrome over the same moment.
                    answeringQuestion.set(null);
                }}
                className="w-full gap-2 py-7 text-base font-semibold"
                size="lg"
            >
                Send answer
            </Button>
        </div>
    );
}

/**
 * Tentacles answer. Runs the question through the universal
 * `hiderifyQuestion` engine, which resolves the hider's containing
 * Voronoi cell → the nearest candidate place. We send that `location`
 * Feature (which is what the seeker keys elimination on, via
 * `location.properties.name`) so the answer actually grades. If the
 * engine can't resolve a place (hider outside the tentacle radius, or
 * the candidate scan came back empty), or the hider knows it picked
 * wrong, they fall back to typing the name by hand. Hidden until reveal.
 */
function AutoGradedTentaclesAnswer({
    question,
    hiderPos,
    revealed,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
    revealed: boolean;
}) {
    const [computed, setComputed] = useState<{
        feature: unknown;
        name: string;
    } | null>(null);
    // v824: the engine returns `location:false` when the hider is OUTSIDE the
    // tentacle radius — a LEGITIMATE "none within range" answer, not a
    // detection failure. Track it so we can offer an explicit sendable answer
    // (which eliminates the reach-circle interior seeker-side) instead of
    // forcing manual entry (which used to send a name with no `location` and
    // mis-graded the seeker's map).
    const [outOfRange, setOutOfRange] = useState(false);
    const [graded, setGraded] = useState(false);
    const [manual, setManual] = useState(false);
    const [placeName, setPlaceName] = useState("");

    useEffect(() => {
        if (!hiderPos) return;
        let cancelled = false;
        setOutOfRange(false);
        gradeViaEngine(question, hiderPos)
            .then((data) => {
                if (cancelled) return;
                const loc = data.location as
                    | { properties?: { name?: unknown } }
                    | false
                    | undefined;
                if (loc && typeof loc === "object") {
                    setComputed({
                        feature: loc,
                        name: String(loc.properties?.name ?? ""),
                    });
                } else if (loc === false) {
                    // Engine resolved "outside the radius" — a real verdict.
                    setOutOfRange(true);
                }
            })
            .catch(() => {
                /* leave computed null → manual entry */
            })
            .finally(() => {
                if (!cancelled) setGraded(true);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [question.key, hiderPos?.lat, hiderPos?.lng]);

    if (!revealed) return null;

    if (!hiderPos) {
        return (
            <p className="text-sm text-center text-muted-foreground py-6">
                Waiting for your location…
            </p>
        );
    }

    if (!graded) {
        return (
            <p className="text-sm text-center text-muted-foreground py-6">
                <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Finding the closest place…
                </span>
            </p>
        );
    }

    // v824: explicit "you're out of range" answer. Sends `location:false`,
    // which the seeker's elimination reads as "the hider is NOT within the
    // tentacle radius of any candidate" and eliminates the reach-circle
    // interior — the correct semantics for an outside-range hider. The hider
    // can still switch to naming a place if the engine got it wrong.
    if (outOfRange && !manual) {
        return (
            <div className="space-y-3">
                <p className="text-sm text-center text-muted-foreground font-poppins">
                    You&apos;re outside the tentacle range — no candidate place
                    is within reach of you.
                </p>
                <ShareBackRow
                    question={question}
                    answer={{ location: false }}
                    shareText="No candidate place is within range of me."
                />
                <button
                    type="button"
                    onClick={() => setManual(true)}
                    className="block mx-auto text-xs text-muted-foreground hover:text-foreground hover:underline"
                >
                    Actually, I&apos;m near one — name it
                </button>
            </div>
        );
    }

    const showManual = manual || (!computed && !outOfRange);

    if (showManual) {
        const trimmed = placeName.trim();
        return (
            <div className="space-y-3">
                <label className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold block">
                    {computed
                        ? "Type the correct closest place"
                        : "Couldn't auto-detect — name the closest place"}
                </label>
                <Input
                    value={placeName}
                    onChange={(e) => setPlaceName(e.target.value)}
                    placeholder="e.g. Stockholm Aquarium"
                    className="text-base py-6"
                />
                {trimmed && (
                    <ShareBackRow
                        question={question}
                        answer={{ hiderPlace: trimmed }}
                        shareText={`Closest match: ${trimmed}.`}
                    />
                )}
                {computed && (
                    <button
                        type="button"
                        onClick={() => setManual(false)}
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                        Use auto-detected place instead
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-3">
            <div className="rounded-lg p-5 border-2 border-primary bg-primary/10 text-center">
                <div className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold mb-2">
                    Closest place
                </div>
                <div className="text-2xl font-poppins font-bold text-primary mb-1">
                    {computed!.name || "Unnamed place"}
                </div>
                <div className="text-sm text-muted-foreground">
                    Auto-detected from your location.
                </div>
            </div>

            <ShareBackRow
                question={question}
                answer={{ location: computed!.feature, hiderPlace: computed!.name }}
                shareText={`Closest match: ${computed!.name}.`}
            />

            <button
                type="button"
                onClick={() => setManual(true)}
                className="w-full text-center text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
                Wrong place? Enter it manually
            </button>
        </div>
    );
}

/**
 * Manual location fallback. Appears as:
 *   - A prominent banner when GPS has failed and no manual override is set
 *   - A small "edit manual location" link when an override is in use, with
 *     a separate "use GPS again" option
 *   - Nothing when GPS works and the hider hasn't asked for manual
 *
 * The lookup uses Nominatim forward-geocoding (via @/lib/geocoding); first
 * matching result wins. Free-form text — "Stockholm city center", "10115
 * Berlin", "Eiffel Tower" all work.
 */
function ManualLocationPanel({
    geoFailed,
    manualPos,
    onSet,
    onClear,
}: {
    geoFailed: boolean;
    manualPos: { lat: number; lng: number; label: string } | null;
    onSet: (pos: { lat: number; lng: number; label: string }) => void;
    onClear: () => void;
}) {
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const [expanded, setExpanded] = useState(false);

    // Auto-expand when geolocation fails and the user hasn't set a manual
    // position yet — otherwise the hider would stare at a frozen map.
    useEffect(() => {
        if (geoFailed && !manualPos) setExpanded(true);
    }, [geoFailed, manualPos]);

    const doLookup = async () => {
        if (!query.trim()) return;
        setBusy(true);
        const result = await forwardGeocodeOne(query);
        setBusy(false);
        if (!result) {
            toast.error("Couldn't find that place. Try being more specific.");
            return;
        }
        onSet({
            lat: result.lat,
            lng: result.lng,
            label: result.displayName,
        });
        setExpanded(false);
        setQuery("");
        toast.success("Location set", { autoClose: 1500 });
    };

    // Case A: manual position set, panel collapsed.
    if (manualPos && !expanded) {
        return (
            <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                <div className="text-muted-foreground truncate min-w-0">
                    <MapPin className="w-3 h-3 inline mr-1 -mt-0.5" />
                    Using manual location:{" "}
                    <span className="text-foreground">
                        {manualPos.label.split(",")[0]}
                    </span>
                </div>
                <div className="flex gap-2 shrink-0">
                    <button
                        type="button"
                        onClick={() => setExpanded(true)}
                        className="text-primary hover:underline"
                    >
                        change
                    </button>
                    <button
                        type="button"
                        onClick={onClear}
                        className="text-muted-foreground hover:text-foreground hover:underline"
                    >
                        use GPS
                    </button>
                </div>
            </div>
        );
    }

    // Case B: manual entry UI (expanded — either because GPS failed or the
    // hider clicked "change").
    if (expanded || geoFailed) {
        return (
            <div
                className={cn(
                    "mt-2 p-3 rounded-md",
                    "bg-secondary/30 border border-border",
                )}
            >
                {geoFailed && !manualPos && (
                    <p className="text-xs text-destructive-foreground mb-2">
                        Couldn't get your GPS location. Enter your location
                        manually instead.
                    </p>
                )}
                <label className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold block mb-2">
                    Where are you?
                </label>
                <div className="flex gap-2">
                    <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="City, neighborhood, or address"
                        className="text-base"
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                doLookup();
                            }
                        }}
                    />
                    <Button onClick={doLookup} disabled={busy || !query.trim()}>
                        {busy ? "…" : "Set"}
                    </Button>
                </div>
                {expanded && manualPos && (
                    <button
                        type="button"
                        onClick={() => setExpanded(false)}
                        className="mt-2 text-xs text-muted-foreground hover:underline"
                    >
                        Cancel
                    </button>
                )}
            </div>
        );
    }

    // Case C: GPS working, no manual override → tiny "set manually" link.
    return (
        <div className="mt-2 text-right">
            <button
                type="button"
                onClick={() => setExpanded(true)}
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
                Set location manually
            </button>
        </div>
    );
}
