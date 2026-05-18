import { Copy, Eye, Share2 } from "lucide-react";
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

            <main className="flex-1 mt-4">
                <AnswerControls question={question} hiderPos={hiderPos} />
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
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
}) {
    switch (question.id) {
        case "radius":
        case "thermometer":
            return <RevealAnswer question={question} hiderPos={hiderPos} />;
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
}: {
    question: Question;
    hiderPos: { lat: number; lng: number; accuracy: number } | null;
}) {
    const [revealed, setRevealed] = useState(false);

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
                    onClick={() => setRevealed(true)}
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

    const handleShare = async () => {
        const result = await shareOrCopy({
            title: "Answer",
            text: `${shareText} Tap to send to seeker: ${url}`,
            url,
        });
        if (result.method === "share" || result.method === "copy") {
            setSent(true);
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
