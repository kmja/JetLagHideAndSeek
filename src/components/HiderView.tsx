import { Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";

import { HiderMap, distanceKm } from "@/components/HiderMap";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    decodeQuestionFromUrl,
    encodeAnswerForSeeker,
    shareOrCopy,
} from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
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

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setQuestion(decodeQuestionFromUrl(params));
        setLoaded(true);
    }, []);

    if (!loaded) {
        // Brief loading state to avoid flashing the "no question" screen
        return null;
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
                        seeker to share again.
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

    // Hider's live position, lifted out of HiderMap so the distance hint
    // and answer pre-suggestion can also use it.
    const [hiderPos, setHiderPos] = useState<{
        lat: number;
        lng: number;
        accuracy: number;
    } | null>(null);

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

            <HiderMap
                question={question}
                onHiderLocationChange={(lat, lng, accuracy) =>
                    setHiderPos({ lat, lng, accuracy })
                }
            />

            <DistanceHint question={question} hiderPos={hiderPos} />

            <main className="flex-1 mt-4">
                <AnswerControls question={question} />
            </main>

            <footer className="pt-3 pb-2 text-center">
                <p className="text-[10px] text-muted-foreground">
                    Jet Lag Hide and Seek · hider view
                </p>
            </footer>
        </div>
    );
}

/**
 * Live distance display under the map. For radius questions also shows
 * whether the hider is inside or outside the circle — a visual hint, not
 * an auto-answer (GPS accuracy can fool us, and the hider should still
 * make the call).
 */
function DistanceHint({
    question,
    hiderPos,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
}) {
    if (!hiderPos) {
        return (
            <p className="text-xs text-center text-muted-foreground mt-2">
                Waiting for your location…
            </p>
        );
    }

    const d = question.data as any;

    // For thermometer, distance from each end.
    if (question.id === "thermometer") {
        const dA = distanceKm(hiderPos.lat, hiderPos.lng, d.latA, d.lngA);
        const dB = distanceKm(hiderPos.lat, hiderPos.lng, d.latB, d.lngB);
        return (
            <div className="mt-2 text-sm text-center">
                <div>
                    Distance from start:{" "}
                    <span className="font-semibold tabular-nums">
                        {dA.toFixed(2)} km
                    </span>
                </div>
                <div>
                    Distance from end:{" "}
                    <span className="font-semibold tabular-nums">
                        {dB.toFixed(2)} km
                    </span>
                </div>
            </div>
        );
    }

    if (
        question.id === "radius" ||
        question.id === "matching" ||
        question.id === "measuring" ||
        question.id === "tentacles"
    ) {
        const km = distanceKm(hiderPos.lat, hiderPos.lng, d.lat, d.lng);

        let extra: React.ReactNode = null;
        if (question.id === "radius") {
            const rKm =
                d.unit === "miles"
                    ? d.radius * 1.609344
                    : d.unit === "meters"
                      ? d.radius / 1000
                      : d.radius;
            const inside = km <= rKm;
            extra = (
                <span
                    className={cn(
                        "ml-2 px-1.5 py-0.5 rounded text-xs font-semibold",
                        inside
                            ? "bg-green-500/20 text-green-400"
                            : "bg-orange-500/20 text-orange-400",
                    )}
                >
                    {inside ? "Inside" : "Outside"}
                </span>
            );
        }

        return (
            <p className="mt-2 text-sm text-center">
                You are{" "}
                <span className="font-semibold tabular-nums">
                    {km.toFixed(2)} km
                </span>{" "}
                from the seeker's point
                {extra}
            </p>
        );
    }

    return null;
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

/** Answer toggle + share-back, varies by type. */
function AnswerControls({ question }: { question: Question }) {
    switch (question.id) {
        case "radius":
            return (
                <BinaryAnswer
                    question={question}
                    field="within"
                    labels={{ true: "Inside", false: "Outside" }}
                    primary="true"
                />
            );
        case "thermometer":
            return (
                <BinaryAnswer
                    question={question}
                    field="warmer"
                    labels={{ true: "Warmer", false: "Colder" }}
                    primary="true"
                />
            );
        case "matching":
            return (
                <BinaryAnswer
                    question={question}
                    field="same"
                    labels={{ true: "Match", false: "No match" }}
                    primary="true"
                />
            );
        case "measuring":
            return (
                <BinaryAnswer
                    question={question}
                    field="hiderCloser"
                    labels={{ true: "Closer", false: "Further" }}
                    primary="true"
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

/** Reusable two-button toggle + share for binary-answer question types. */
function BinaryAnswer({
    question,
    field,
    labels,
    primary,
}: {
    question: Question;
    field: string;
    labels: { true: string; false: string };
    primary: "true" | "false";
}) {
    const [answer, setAnswer] = useState<boolean | null>(null);
    const [shared, setShared] = useState(false);

    const handleShare = async () => {
        if (answer === null) return;
        const url = encodeAnswerForSeeker(question.key, { [field]: answer });
        const choiceLabel = answer ? labels.true : labels.false;
        const result = await shareOrCopy({
            title: "Answer",
            text: `My answer: ${choiceLabel}. Tap to send back to seeker: ${url}`,
            url,
        });
        if (result.method === "share") setShared(true);
        else if (result.method === "copy") {
            setShared(true);
            toast.success("Answer link copied (sharing not supported)");
        } else if (result.method === "failed") {
            toast.error("Could not share answer");
        }
    };

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

            <Button
                onClick={handleShare}
                disabled={answer === null}
                className="w-full gap-2 py-6 text-base"
                size="lg"
            >
                <Share2 className="w-4 h-4" />
                {shared ? "Share answer again" : "Share answer with seeker"}
            </Button>

            {shared && (
                <p className="text-xs text-muted-foreground text-center">
                    Sent. You can close this tab.
                </p>
            )}
        </div>
    );
}

/** Tentacles is special: hider types the name of the closest place. */
function TentaclesAnswer({ question }: { question: Question }) {
    const [placeName, setPlaceName] = useState("");
    const [shared, setShared] = useState(false);

    const handleShare = async () => {
        const trimmed = placeName.trim();
        if (!trimmed) return;
        // Tentacles' real answer is a `places` array. For the share-link flow
        // we send back a simplified `hiderPlace` field that the seeker can
        // see in the card (won't auto-populate the place picker; seeker may
        // need to verify against the live list).
        const url = encodeAnswerForSeeker(question.key, {
            hiderPlace: trimmed,
        });
        const result = await shareOrCopy({
            title: "Answer",
            text: `Closest match: ${trimmed}. Send back to seeker: ${url}`,
            url,
        });
        if (result.method === "share") setShared(true);
        else if (result.method === "copy") {
            setShared(true);
            toast.success("Answer link copied (sharing not supported)");
        } else if (result.method === "failed") {
            toast.error("Could not share answer");
        }
    };

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

            <Button
                onClick={handleShare}
                disabled={!placeName.trim()}
                className="w-full gap-2 py-6 text-base"
                size="lg"
            >
                <Share2 className="w-4 h-4" />
                {shared ? "Share answer again" : "Share answer with seeker"}
            </Button>

            {shared && (
                <p className="text-xs text-muted-foreground text-center">
                    Sent. You can close this tab.
                </p>
            )}
        </div>
    );
}
