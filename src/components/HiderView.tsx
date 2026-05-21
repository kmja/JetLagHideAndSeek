import { Copy, Eye, MapPin, Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";

import { HiderMap, distanceKm } from "@/components/HiderMap";
import { HiderHome } from "@/components/HiderHome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    drawCards,
    hiderInbox,
    playerRole,
    QUESTION_DRAW_BUDGET,
} from "@/lib/hiderRole";
import {
    decodeQuestionFromUrl,
    encodeAnswerForSeeker,
    shareOrCopy,
} from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import { forwardGeocodeOne } from "@/maps/api";
import type { Question } from "@/maps/schema";

/**
 * Hider-side read-only view of a single question.
 *
 * Mounted at /h. Reads the question payload from the URL on mount, renders
 * a minimal "answer this question" UI specific to the question type, then
 * lets the hider share an answer URL back to the seeker.
 *
 * Deliberately spartan — no sidebar, no map, no question composer. The
 * hider just needs to see what's being asked and tap an answer.
 */
export function HiderView() {
    const [question, setQuestion] = useState<Question | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [hasQueryParam, setHasQueryParam] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setHasQueryParam(params.has("q"));
        const q = decodeQuestionFromUrl(params);
        setQuestion(q);
        // Auto-mark this device as the hider when they open a /h?q= link —
        // they're clearly playing the hider side. Same trick the seeker app
        // uses for its own role (set on the first wizard finish).
        if (q) {
            playerRole.set("hider");
            // Save to inbox if not already there. Keyed by question.key
            // for idempotency — re-opening the same link doesn't duplicate.
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
        }
        setLoaded(true);
    }, []);

    if (!loaded) {
        // Brief loading state to avoid flashing the "no question" screen
        return null;
    }

    // No `?q=` → render the persistent hider home (zone, inbox, hand).
    if (!hasQueryParam) {
        return <HiderHome />;
    }

    if (!question) {
        return (
            <div className="min-h-screen flex items-center justify-center p-6">
                <div className="max-w-sm text-center">
                    <h1 className="text-2xl font-poppins font-semibold mb-2">
                        No question
                    </h1>
                    <p className="text-muted-foreground text-sm">
                        This link doesn't contain a valid question. Ask the
                        seeker to share again, or{" "}
                        <a href="/h" className="underline">
                            go to your hider home
                        </a>
                        .
                    </p>
                </div>
            </div>
        );
    }

    return <HiderQuestionAnswer question={question} />;
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

    // Whether GPS failed (denied/unsupported). Drives the visibility of the
    // manual-location UI. We still let the user open it on demand via a
    // small link even when GPS works, for cases where the device's reported
    // position is wrong.
    const [geoFailed, setGeoFailed] = useState(false);

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

    return (
        <div className="min-h-screen flex flex-col p-4 max-w-md mx-auto">
            <header className="mt-2 mb-3">
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
                    <span className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold">
                        {categoryMeta?.label ?? question.id} question
                    </span>
                </div>
                <h1 className="font-poppins text-xl font-semibold leading-tight">
                    {questionPrompt(question)}
                </h1>
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
                    />
                </div>
                {shouldBlurMap && (
                    <div
                        className={cn(
                            "absolute inset-0 pointer-events-none",
                            "flex items-center justify-center",
                            "rounded-md",
                        )}
                        aria-hidden="true"
                    >
                        <div className="bg-background/70 backdrop-blur-sm px-4 py-2 rounded-full text-xs uppercase tracking-wider font-poppins font-semibold text-muted-foreground border border-border">
                            Tap reveal to see your position
                        </div>
                    </div>
                )}
            </div>

            <ManualLocationPanel
                geoFailed={geoFailed}
                manualPos={manualPos}
                onSet={(pos) => setManualPos(pos)}
                onClear={() => setManualPos(null)}
            />

            <main className="flex-1 mt-4">
                <AnswerControls
                    question={question}
                    hiderPos={hiderPos}
                    revealed={revealed}
                    onReveal={() => setRevealed(true)}
                />
            </main>

            <footer className="pt-3 pb-2 text-center">
                <p className="text-[10px] text-muted-foreground">
                    Jet Lag Hide and Seek · hider view
                </p>
            </footer>
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
    onReveal,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
    revealed: boolean;
    onReveal: () => void;
}) {
    switch (question.id) {
        case "radius":
        case "thermometer":
            return (
                <RevealAnswer
                    question={question}
                    hiderPos={hiderPos}
                    revealed={revealed}
                    onReveal={onReveal}
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
    onReveal,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
    revealed: boolean;
    onReveal: () => void;
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

    if (!revealed) {
        return (
            <div>
                <Button
                    onClick={onReveal}
                    className="w-full gap-2 py-7 text-base font-semibold"
                    size="lg"
                >
                    <Eye className="w-4 h-4" />
                    Reveal answer
                </Button>
                <p className="mt-2 text-xs text-muted-foreground text-center">
                    Look at the map first. Tap reveal when you're ready.
                </p>
            </div>
        );
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
 * Pair of buttons for sending the answer back. Both are full-width and
 * prominent — Share (primary) for the OS share sheet, Copy (outline) for
 * "I'll paste this somewhere myself" fallback.
 */
function ShareBackRow({
    question,
    answer,
    shareText,
}: {
    question: Question;
    answer: Record<string, unknown>;
    shareText: string;
}) {
    const [sent, setSent] = useState(false);
    const url = useMemo(
        () => encodeAnswerForSeeker(question.key, answer),
        [question.key, answer],
    );

    const markRepliedInInbox = () => {
        // First check whether this question has already been replied to
        // — if so, don't double-draw cards.
        const inbox = hiderInbox.get();
        const existing = inbox.find((e) => e.key === question.key);
        const alreadyReplied = Boolean(existing?.repliedAt);

        hiderInbox.set(
            inbox.map((e) =>
                e.key === question.key
                    ? { ...e, repliedAt: Date.now(), reply: answer }
                    : e,
            ),
        );

        // Card-draw reward (rulebook p16-37). The draw budget is by
        // category — matching draws 3/keeps 1, radar 2/1, photo 1/1,
        // tentacle 4/2 etc.  For now we auto-keep all drawn cards;
        // the proper "draw N, keep K" pick UI lands when we wire up the
        // per-question reward dialog. Hand-cap enforcement is the
        // hider's responsibility for now (HiderHandPanel surfaces the
        // over-cap warning).
        if (!alreadyReplied) {
            const budget = QUESTION_DRAW_BUDGET[question.id];
            if (budget) {
                const drawn = drawCards(budget.draw);
                if (drawn.length > 0) {
                    toast.success(
                        `Drew ${drawn.length} card${drawn.length === 1 ? "" : "s"} from the deck.`,
                        { autoClose: 2000 },
                    );
                }
            }
        }
    };

    const handleShare = async () => {
        const result = await shareOrCopy({
            title: "Answer",
            text: `${shareText} Tap to send to seeker: ${url}`,
            url,
        });
        if (result.method === "share" || result.method === "copy") {
            setSent(true);
            markRepliedInInbox();
        }
        if (result.method === "copy") {
            toast.success("Answer link copied (sharing not supported)");
        }
        if (result.method === "failed") {
            toast.error("Could not share");
        }
    };

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            setSent(true);
            markRepliedInInbox();
            toast.success("Answer link copied", { autoClose: 1500 });
        } catch {
            toast.error("Could not copy");
        }
    };

    return (
        <div className="space-y-2">
            <Button
                onClick={handleShare}
                className="w-full gap-2 py-7 text-base font-semibold"
                size="lg"
            >
                <Share2 className="w-5 h-5" />
                {sent ? "Share answer again" : "Share answer"}
            </Button>
            <Button
                onClick={handleCopy}
                variant="outline"
                className="w-full gap-2 py-5 text-sm"
            >
                <Copy className="w-4 h-4" />
                Copy answer link
            </Button>
            {sent && (
                <p className="text-xs text-muted-foreground text-center pt-1">
                    Sent. You can close this tab.
                </p>
            )}
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
