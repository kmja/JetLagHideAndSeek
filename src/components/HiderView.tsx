import { useStore } from "@nanostores/react";
import { Check, Loader2, MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { CompanionView } from "@/components/CompanionView";
import { DrawPickerDialog } from "@/components/DrawPickerDialog";
import { distanceKm,HiderMap } from "@/components/HiderMap";
import { HiderShell } from "@/components/HiderShell";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    answeringQuestion,
    hiderInbox,
    playerRole,
    presentDraw,
    QUESTION_DRAW_BUDGET,
    roundFoundAt,
    settleLateAnswer,
} from "@/lib/hiderRole";
import { hiderAnswerQuestion } from "@/lib/multiplayer/store";
import {
    decodeFoundFromUrl,
    decodeQuestionFromUrl,
} from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
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
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                    "flex flex-col p-0 gap-0 sm:max-w-md",
                    "max-h-[92vh]",
                )}
            >
                {$q && <HiderQuestionAnswer question={$q} />}
            </DialogContent>
        </Dialog>
    );
}

/** Inner component once we know we have a valid question. */
function HiderQuestionAnswer({ question }: { question: Question }) {
    const categoryMeta = CATEGORIES[question.id as CategoryId];
    const CategoryIcon = categoryMeta?.icon;

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

    // The map shows the seeker's geometry and the hider's pin together —
    // for radius/thermometer this directly reveals the answer (inside vs
    // outside the circle; closer to A vs B). Blur the map until the
    // hider explicitly taps "Reveal answer". For other question types,
    // the map doesn't reveal the answer alone, so no blur.
    const autoComputable =
        question.id === "radius" || question.id === "thermometer";
    const shouldBlurMap = autoComputable && !revealed;

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
            <header>
                <div className="flex items-center gap-2 mb-2">
                    {CategoryIcon && (
                        <span
                            className="inline-flex items-center justify-center w-7 h-7 rounded shrink-0"
                            style={{ backgroundColor: categoryMeta.color }}
                            aria-hidden="true"
                        >
                            <CategoryIcon
                                size={16}
                                strokeWidth={2.5}
                                className="text-white"
                            />
                        </span>
                    )}
                    <DialogDescription className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold">
                        {categoryMeta?.label ?? question.id} question
                    </DialogDescription>
                </div>
                <DialogTitle className="font-poppins text-lg font-semibold leading-tight">
                    {questionPrompt(question)}
                </DialogTitle>
            </header>

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

            {/* v315: manual-location panel now ONLY appears when GPS
                actually failed. The previous "set location manually"
                link that surfaced even on a working GPS is gone —
                that was noise the user never asked to see. Once the
                answer is revealed the panel also disappears so the
                override doesn't sit next to a committed answer. */}
            {geoFailed && !revealed && (
                <ManualLocationPanel
                    geoFailed={geoFailed}
                    manualPos={manualPos}
                    onSet={(pos) => setManualPos(pos)}
                    onClear={() => setManualPos(null)}
                />
            )}

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

/** Human-readable question prompt, varies by type. */
function questionPrompt(question: Question): string {
    const d = question.data as any;
    const niceSubtype = (raw: unknown): string =>
        String(raw ?? "")
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
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

/** Answer flow varies by type:
 *   - radius / thermometer: auto-computable from GPS. Use the reveal pattern.
 *   - matching / measuring: hider must judge. Manual two-button toggle.
 *   - tentacles: hider types the closest place name.
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
            return (
                <ManualBinaryAnswer
                    question={question}
                    field="same"
                    labels={{ true: "Match", false: "No match" }}
                />
            );
        case "measuring":
            return (
                <ManualBinaryAnswer
                    question={question}
                    field="hiderCloser"
                    labels={{ true: "Closer", false: "Further" }}
                />
            );
        case "tentacles":
            return <TentaclesAnswer question={question} />;
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

/** Manual two-button toggle for questions the app can't auto-compute. */
function ManualBinaryAnswer({
    question,
    field,
    labels,
}: {
    question: Question;
    field: string;
    labels: { true: string; false: string };
}) {
    const [answer, setAnswer] = useState<boolean | null>(null);

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
                {([true, false] as const).map((value) => {
                    const isSelected = answer === value;
                    return (
                        <button
                            key={String(value)}
                            type="button"
                            onClick={() => setAnswer(value)}
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

            {answer !== null && (
                <ShareBackRow
                    question={question}
                    answer={{ [field]: answer }}
                    shareText={`My answer: ${answer ? labels.true : labels.false}.`}
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
                // v315: dropped the "Drew N from deck" / "Pick K of N"
                // toasts that used to fire here. The DrawPickerDialog
                // (or the new card appearing in the fan when the
                // draw auto-resolves) is the confirmation; a
                // notification on top doubled the same moment.
                presentDraw(
                    budget.draw,
                    budget.keep,
                    question.id,
                    question.key,
                );
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
                <Check className="w-5 h-5" />
                Send answer
            </Button>
        </div>
    );
}

/** Tentacles is special: hider types the name of the closest place. */
function TentaclesAnswer({ question }: { question: Question }) {
    const [placeName, setPlaceName] = useState("");

    const trimmed = placeName.trim();

    return (
        <div className="space-y-4">
            <div>
                <label className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold block mb-2">
                    Name of the closest place
                </label>
                <Input
                    value={placeName}
                    onChange={(e) => setPlaceName(e.target.value)}
                    placeholder="e.g. Stockholm Aquarium"
                    className="text-base py-6"
                />
            </div>

            {trimmed && (
                <ShareBackRow
                    question={question}
                    answer={{ hiderPlace: trimmed }}
                    shareText={`Closest match: ${trimmed}.`}
                />
            )}
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
