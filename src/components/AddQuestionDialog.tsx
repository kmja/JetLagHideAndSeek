import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { ArrowLeft } from "lucide-react";
import React from "react";
import { toast } from "react-toastify";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    defaultCustomQuestions,
    defaultUnit,
    mapContext,
    questionModified,
    questions,
} from "@/lib/context";
import { type GameSize, gameSize, playArea } from "@/lib/gameSetup";
import { fitMapToRadius } from "@/lib/mapFit";
import {
    isHiderConnected,
    seekerAddQuestion as addQuestion,
} from "@/lib/multiplayer/store";
import {
    encodeQuestionForHider,
    shareOrCopy,
} from "@/lib/shareLinks";
import { getSubtypes, type SubtypeMeta } from "@/lib/subtypes";
import { cn } from "@/lib/utils";
import { findPlacesInZone, LOCATION_FIRST_TAG } from "@/maps/api";

import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    PhotoQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";
import { Button } from "./ui/button";

/**
 * Fire-and-forget background prefetch of Overpass data for every -full
 * subtype of the given category, so that committing to a specific subtype
 * later is near-instant. Cache-only — no toast, no UI blocking, errors
 * swallowed. Limited to the `-full` family of subtypes (museum, aquarium,
 * zoo, etc.) because they all share the simple `[tag=value]` query shape
 * via LOCATION_FIRST_TAG. Subtypes with bespoke queries (airport,
 * major-city, coastline) and tentacles (radius-dependent) are skipped —
 * adding them would require duplicating their adjustment logic and the
 * marginal benefit is small for those one-off picks.
 *
 * Started already-tracked Overpass requests dedupe via the in-flight map
 * in cacheFetch, so calling this repeatedly is safe.
 */
function preloadSubtypeData(
    category: "matching" | "measuring" | "tentacles",
    size: GameSize,
) {
    const subtypes = getSubtypes(category, size);
    if (!subtypes) return;
    for (const s of subtypes) {
        if (!s.value.endsWith("-full")) continue;
        const location = s.value.slice(0, -"-full".length);
        const tag = (LOCATION_FIRST_TAG as Record<string, string | undefined>)[
            location
        ];
        if (!tag) continue;
        // No loadingText → no toast.promise wrapper; this is pure pre-fetch.
        findPlacesInZone(
            `[${tag}=${location}]`,
            undefined,
            "nwr",
            "center",
            [],
            60,
        ).catch(() => {});
    }
}

/**
 * A single category tile in the Add Question picker.
 * Visual identity (color + icon) comes from CATEGORIES.
 */
const SubtypeTile = ({
    category,
    subtype,
    onClick,
    disabled,
}: {
    category: CategoryId;
    subtype: SubtypeMeta;
    onClick: () => void;
    disabled?: boolean;
}) => {
    const catMeta = CATEGORIES[category];
    const Icon = subtype.icon;
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "relative flex flex-col items-center text-center gap-2 p-4 rounded-sm",
                "bg-secondary border border-border border-t-[5px]",
                "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                "hover:bg-accent hover:-translate-y-[1px] transition-all",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            style={{ borderTopColor: catMeta.color }}
            title={subtype.description}
        >
            <span
                className="inline-flex items-center justify-center w-10 h-10 rounded-sm shrink-0"
                style={{ backgroundColor: catMeta.color }}
                aria-hidden="true"
            >
                <Icon size={20} strokeWidth={2.4} className="text-white" />
            </span>
            <span className="font-inter-tight font-bold text-sm leading-tight uppercase tracking-wide">
                {subtype.label}
            </span>
        </button>
    );
};

const CategoryTile = ({
    category,
    description,
    onClick,
    disabled,
    className,
    blockedReason,
}: {
    category: CategoryId;
    description: string;
    onClick: () => void;
    disabled?: boolean;
    className?: string;
    blockedReason?: string;
}) => {
    const meta = CATEGORIES[category];
    const Icon = meta.icon;
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={blockedReason}
            className={cn(
                "relative flex flex-col gap-2 p-3 rounded-sm text-left",
                "bg-secondary border border-border border-t-[6px]",
                "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                "hover:bg-accent hover:-translate-y-[1px] transition-all",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                className,
            )}
            style={{ borderTopColor: meta.color }}
        >
            <div className="flex items-center gap-2">
                <span
                    className="inline-flex items-center justify-center w-7 h-7 rounded-sm shrink-0"
                    style={{ backgroundColor: meta.color }}
                    aria-hidden="true"
                >
                    <Icon size={16} strokeWidth={2.5} className="text-white" />
                </span>
                <span className="font-inter-tight font-black uppercase text-xs tracking-[0.12em]">
                    {meta.label}
                </span>
            </div>
            <span className="text-xs text-muted-foreground font-normal leading-snug">
                {blockedReason ?? description}
            </span>
        </button>
    );
};

export const AddQuestionDialog = ({
    children,
}: {
    children: React.ReactNode;
}) => {
    const $questions = useStore(questions);
    const $gameSize = useStore(gameSize);
    const [open, setOpen] = React.useState(false);
    // Step 2 of the add flow: when the user picks a category that has
    // multiple subtypes (matching / measuring / tentacles / photo), we
    // show a subtype picker before opening the configure dialog. Null when
    // we're either on step 1 (category picker) or past step 2 (configure).
    const [subtypePickerFor, setSubtypePickerFor] = React.useState<
        "matching" | "measuring" | "tentacles" | "photo" | null
    >(null);
    // Key of the just-added question awaiting Confirm/Cancel.
    const [pendingKey, setPendingKey] = React.useState<number | null>(null);

    const pendingQuestion =
        pendingKey !== null
            ? $questions.find((q) => q.key === pendingKey)
            : null;

    // Helper: get the most recently added question's key, then promote it
    // to the "pending confirm" state and close the category picker.
    //
    // We close the category picker first, then open the configure dialog
    // on the next tick. Two simultaneously-mounting Radix Dialogs confuse
    // Radix's body scroll-lock reference counting and leave
    // `pointer-events: none` stuck on <body> after both eventually close,
    // silently blocking every click on the rest of the UI (e.g. the
    // bottom-nav "Questions" button). The setTimeout gives Radix a tick
    // to finish cleanup before the second dialog mounts.
    const promoteLastQuestion = () => {
        const list = questions.get();
        if (list.length === 0) return;
        const lastKey = list[list.length - 1].key;
        setOpen(false);
        setTimeout(() => setPendingKey(lastKey), 150);
    };

    // Safety net for a Radix UI body-lock cleanup race: Radix can leave
    // `pointer-events: none` on <body> after a Dialog closes, silently
    // blocking every click on the rest of the UI. We sequence the picker
    // and configure dialogs to avoid this (see `promoteLastQuestion`), but
    // also clear the stale inline style here at a few checkpoints in case
    // any path is missed. Multiple poll intervals because Radix re-applies
    // the style during its close animation.
    const releaseBodyLock = () => {
        const clear = () => {
            if (document.body.style.pointerEvents === "none") {
                document.body.style.pointerEvents = "";
            }
        };
        requestAnimationFrame(clear);
        setTimeout(clear, 200);
        setTimeout(clear, 500);
    };

    const handleCancel = () => {
        if (pendingKey === null) return;
        questions.set(questions.get().filter((q) => q.key !== pendingKey));
        setPendingKey(null);
        releaseBodyLock();
    };

    const handleConfirm = async () => {
        if (!pendingQuestion) {
            setPendingKey(null);
            releaseBodyLock();
            return;
        }
        // Snapshot the question before closing — pendingQuestion will become
        // null once we clear the dialog state.
        const q = pendingQuestion;
        const meta = CATEGORIES[q.id as CategoryId];
        setPendingKey(null);
        releaseBodyLock();

        // If the hider is online and connected we've already pushed
        // the question via `seekerAddQuestion` — skip the share sheet
        // entirely and just start the 5-min answer clock. Otherwise
        // fall through to share-link delivery.
        if (isHiderConnected()) {
            (q.data as { createdAt?: number }).createdAt = Date.now();
            questionModified();
            toast.success("Sent to hider", { autoClose: 1500 });
            return;
        }

        // Auto-share the question with the hider. We deliberately wait for
        // `shareOrCopy` to resolve before stamping `createdAt` so that the
        // hider's 5-min answer window starts when the share sheet actually
        // closes (i.e. the hider has the link), not while it was open or
        // before the seeker even chose a recipient. This also keeps the
        // countdown off the card during the configure dialog: createdAt is
        // undefined until a share completes.
        const url = encodeQuestionForHider(q);
        const result = await shareOrCopy({
            title: `${meta?.label ?? "Question"} for the hider`,
            text: `${meta?.label ?? "Question"}: tap to answer`,
            url,
        });
        if (result.method === "share" || result.method === "copy") {
            (q.data as { createdAt?: number }).createdAt = Date.now();
            questionModified();
        }
        if (result.method === "copy") {
            toast.info(
                "Question added. Link copied — sharing isn't supported in this browser.",
                { autoClose: 2500 },
            );
        }
        // "cancelled" / "failed" → countdown stays off until the seeker
        // shares manually from the questions panel. That re-share path also
        // stamps `createdAt` on success.
    };

    // None of these helpers stamp `createdAt` upfront — the answer-window
    // countdown only starts once the question is actually delivered to the
    // hider. `handleConfirm` (configure dialog) and the per-question share
    // button (questions panel) are the two paths that stamp it post-share.
    // Resolve a center point for new questions. Prefer the live map
    // viewport (so the seeker drops the question where they're looking),
    // but fall back to the play-area centroid when the map ref isn't
    // ready yet — e.g. on initial mount before MapLibre has registered
    // its context. Without this fallback, tapping a subtype tile was a
    // silent no-op for users who picked a category before the map
    // finished its first frame.
    const resolveCenter = (): { lat: number; lng: number } | null => {
        const map = mapContext.get();
        if (map) {
            const c = map.getCenter();
            return { lat: c.lat, lng: c.lng };
        }
        const pa = playArea.get();
        if (pa) return { lat: pa.lat, lng: pa.lng };
        return null;
    };

    const runAddRadius = () => {
        const center = resolveCenter();
        if (!center) return false;
        const map = mapContext.get();
        addQuestion({
            id: "radius",
            data: {
                lat: center.lat,
                lng: center.lng,
                // Default to 5 km — the previous 10 km starting point
                // tended to swallow most cities at typical zoom levels,
                // making the dragged-pin preview hard to read. 5 km is
                // a more common opening radar guess in actual play.
                radius: 5,
                unit: "kilometers",
            },
        });
        // Fit the map to the new radius so the entire circle is
        // visible — otherwise opening the configure dialog can show
        // the seeker a radius that extends off-screen, which is
        // confusing when picking a different preset.
        if (map) {
            fitMapToRadius(map, center.lat, center.lng, 5, "kilometers");
        }
        return true;
    };

    const runAddThermometer = () => {
        const center = resolveCenter();
        if (!center) return false;
        // Thermometer per rulebook: capture the seeker's current location
        // as point A and enter "started" state. Point B mirrors A until the
        // seeker has moved and hits Finish in the question card. Map center
        // is the best proxy we have for "seeker's current location" without
        // a GPS prompt at this step (we'd block the tap-to-add flow).
        //
        // Note: no `createdAt` — the answer countdown shouldn't run during
        // the "started" phase (seeker is moving, not waiting for an
        // answer). It gets stamped once the seeker finishes + shares the
        // ending point.
        addQuestion({
            id: "thermometer",
            data: {
                latA: center.lat,
                lngA: center.lng,
                latB: center.lat,
                lngB: center.lng,
                status: "started",
                startedAt: Date.now(),
            },
        });

        return true;
    };

    const runAddTentacles = (subtype?: string) => {
        const center = resolveCenter();
        if (!center) return false;
        // Tentacles uses `locationType` as the type field (unlike matching
        // and measuring which use `type`). When the user picks a subtype in
        // step 2 we set it here so the resulting question has the right
        // place category baked in.
        // Cast to never on each branch — the schema-side discriminated
        // union is too narrow for TS to verify the dynamic subtype
        // string. `addQuestion` runs the value through Zod parsing at
        // runtime so an invalid subtype would surface as a parse error
        // long before it could corrupt state.
        addQuestion({
            id: "tentacles",
            data: defaultCustomQuestions.get()
                ? ({
                      lat: center.lat,
                      lng: center.lng,
                      locationType: subtype ?? "custom",
                      places: [],
                  } as never)
                : ({
                      lat: center.lat,
                      lng: center.lng,
                      ...(subtype ? { locationType: subtype } : {}),
                  } as never),
        });
        return true;
    };

    const runAddMatching = (subtype?: string) => {
        const center = resolveCenter();
        if (!center) return false;
        addQuestion({
            id: "matching",
            data: defaultCustomQuestions.get()
                ? ({
                      lat: center.lat,
                      lng: center.lng,
                      type: subtype ?? "custom-points",
                  } as never)
                : ({
                      lat: center.lat,
                      lng: center.lng,
                      ...(subtype ? { type: subtype } : {}),
                  } as never),
        });
        return true;
    };

    const runAddMeasuring = (subtype?: string) => {
        const center = resolveCenter();
        if (!center) return false;
        addQuestion({
            id: "measuring",
            data: defaultCustomQuestions.get()
                ? ({
                      lat: center.lat,
                      lng: center.lng,
                      type: subtype ?? "custom-measure",
                  } as never)
                : ({
                      lat: center.lat,
                      lng: center.lng,
                      ...(subtype ? { type: subtype } : {}),
                  } as never),
        });
        return true;
    };

    /**
     * Photo questions don't need a map location — the photo IS the answer.
     * We just create the question with the chosen subtype and drag:true
     * (awaiting answer). The hider will eventually attach a photo (or the
     * seeker will mark answered manually if the photo came via SMS).
     */
    const runAddPhoto = (subtype?: string) => {
        addQuestion({
            id: "photo",
            data: {
                type: subtype ?? "tree",
            },
        });
        return true;
    };

    return (
        <>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>{children}</DialogTrigger>
                <DialogContent>
                <DialogTitle>Add Question</DialogTitle>
                <DialogDescription>Pick a category.</DialogDescription>

                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(() => {
                        // Rulebook (p38): "Tentacle questions cannot be used
                        // in SMALL games." This is the only category-level
                        // size restriction in the book.
                        const tentacleBlockedSize = $gameSize === "small";
                        // Rulebook implicitly: only one thermometer can be in
                        // progress at a time, since a thermometer is one
                        // start point + one end point per question. If a
                        // started thermometer exists, block adding another.
                        const thermInProgress = $questions.some(
                            (q) =>
                                q.id === "thermometer" &&
                                (q.data as { status?: string }).status ===
                                    "started",
                        );
                        return (
                            <>
                                <CategoryTile
                                    category="matching"
                                    description="Is your nearest ___ the same as mine?"
                                    onClick={() => {
                                        preloadSubtypeData(
                                            "matching",
                                            $gameSize,
                                        );
                                        setSubtypePickerFor("matching");
                                    }}
                                />
                                <CategoryTile
                                    category="measuring"
                                    description="Are you closer or further to ___ than me?"
                                    onClick={() => {
                                        preloadSubtypeData(
                                            "measuring",
                                            $gameSize,
                                        );
                                        setSubtypePickerFor("measuring");
                                    }}
                                />
                                <CategoryTile
                                    category="radius"
                                    description="Are you within ___ of me?"
                                    onClick={() => {
                                        if (runAddRadius())
                                            promoteLastQuestion();
                                    }}
                                />
                                <CategoryTile
                                    category="thermometer"
                                    description="After traveling ___, am I hotter or colder?"
                                    onClick={() => {
                                        if (runAddThermometer()) {
                                            setOpen(false);
                                            toast.info(
                                                "Thermometer started. Move away from here to finish.",
                                                { autoClose: 3000 },
                                            );
                                        }
                                    }}
                                    disabled={thermInProgress}
                                    blockedReason={
                                        thermInProgress
                                            ? "A thermometer is already in progress — finish it before starting another"
                                            : undefined
                                    }
                                />
                                <CategoryTile
                                    category="photo"
                                    description="Send me a photo of ___."
                                    onClick={() => {
                                        setSubtypePickerFor("photo");
                                    }}
                                />
                                <CategoryTile
                                    category="tentacles"
                                    description="Within ___ km of me, which ___ are you nearest to?"
                                    onClick={() => {
                                        preloadSubtypeData(
                                            "tentacles",
                                            $gameSize,
                                        );
                                        setSubtypePickerFor("tentacles");
                                    }}
                                    disabled={tentacleBlockedSize}
                                    blockedReason={
                                        tentacleBlockedSize
                                            ? "Tentacle questions aren't used in Small games (rulebook p38)."
                                            : undefined
                                    }
                                />
                            </>
                        );
                    })()}
                </div>

                {/* House rules reminders — rulebook p13. Google Street View
                    is banned (too powerful for photo matches and station
                    verification); questions must be asked one at a time. */}
                <div className="mt-3 pt-3 border-t border-border text-[11px] leading-snug text-muted-foreground space-y-0.5">
                    <div>
                        <span className="font-semibold text-foreground">
                            No Google Street View
                        </span>{" "}
                        — the only banned research tool.
                    </div>
                    <div>
                        One question at a time — wait for the hider's
                        answer before asking the next.
                    </div>
                </div>
            </DialogContent>
            </Dialog>

            {/* Step 2: subtype picker for matching/measuring/tentacles. The
                user lands here after tapping a category that has multiple
                subtypes. Picking a tile adds the question with that subtype
                preselected, then opens the configure dialog. */}
            <Dialog
                open={subtypePickerFor !== null}
                onOpenChange={(o) => {
                    if (!o) setSubtypePickerFor(null);
                }}
            >
                <DialogContent
                    className={cn(
                        "!bg-[hsl(var(--sidebar-background))] !text-white",
                        "flex flex-col p-0 gap-0",
                    )}
                >
                    {subtypePickerFor &&
                        (() => {
                            const meta = CATEGORIES[subtypePickerFor];
                            const subtypes = getSubtypes(
                                subtypePickerFor,
                                $gameSize,
                            );
                            // Rulebook-template description for this category.
                            // Lives here (subdialog header) rather than on the
                            // small category tiles so the grid stays clean.
                            const templateByCategory: Record<string, string> = {
                                matching:
                                    "Is your nearest ___ the same as mine?",
                                measuring:
                                    "Are you closer or further to ___ than me?",
                                tentacles:
                                    "Within ___ km of me, which ___ are you nearest to?",
                                photo: "Send me a photo of ___.",
                            };
                            const template =
                                templateByCategory[subtypePickerFor];
                            return (
                                <>
                                    <div className="px-6 pt-6 pb-3 shrink-0 border-b border-border">
                                        <DialogTitle className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setSubtypePickerFor(null);
                                                    setOpen(true);
                                                }}
                                                aria-label="Back to categories"
                                                title="Back to categories"
                                                className={cn(
                                                    "inline-flex items-center justify-center w-7 h-7 rounded shrink-0",
                                                    "bg-secondary text-foreground hover:bg-accent",
                                                    "border border-border transition-colors",
                                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                                )}
                                            >
                                                <ArrowLeft
                                                    size={14}
                                                    strokeWidth={2.5}
                                                />
                                            </button>
                                            <span
                                                className="inline-flex items-center justify-center w-7 h-7 rounded shrink-0"
                                                style={{
                                                    backgroundColor:
                                                        meta.color,
                                                }}
                                            >
                                                <meta.icon
                                                    size={16}
                                                    strokeWidth={2.5}
                                                    className="text-white"
                                                />
                                            </span>
                                            {meta.label}
                                        </DialogTitle>
                                        <DialogDescription>
                                            {template ??
                                                `Pick a ${meta.label.toLowerCase()} type.`}
                                        </DialogDescription>
                                    </div>
                                    <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
                                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                            {subtypes?.map((subtype) => (
                                                <SubtypeTile
                                                    key={subtype.value}
                                                    category={
                                                        subtypePickerFor
                                                    }
                                                    subtype={subtype}
                                                    onClick={() => {
                                                        const cat =
                                                            subtypePickerFor;
                                                        let ok = false;
                                                        if (
                                                            cat === "matching"
                                                        )
                                                            ok =
                                                                runAddMatching(
                                                                    subtype.value,
                                                                );
                                                        else if (
                                                            cat ===
                                                            "measuring"
                                                        )
                                                            ok =
                                                                runAddMeasuring(
                                                                    subtype.value,
                                                                );
                                                        else if (
                                                            cat ===
                                                            "tentacles"
                                                        )
                                                            ok =
                                                                runAddTentacles(
                                                                    subtype.value,
                                                                );
                                                        else if (
                                                            cat === "photo"
                                                        )
                                                            ok = runAddPhoto(
                                                                subtype.value,
                                                            );
                                                        if (ok) {
                                                            setSubtypePickerFor(
                                                                null,
                                                            );
                                                            promoteLastQuestion();
                                                        } else {
                                                            // Surfaces a previously-silent
                                                            // failure path: if neither map
                                                            // nor play area resolve a
                                                            // center, tell the seeker
                                                            // instead of doing nothing.
                                                            toast.error(
                                                                "Couldn't add the question — map not ready. Try again in a moment.",
                                                            );
                                                        }
                                                    }}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                </>
                            );
                        })()}
                </DialogContent>
            </Dialog>

            <Dialog
                open={pendingKey !== null}
                onOpenChange={(o) => {
                    if (!o) handleCancel();
                }}
            >
                <DialogContent
                    className={cn(
                        "!bg-[hsl(var(--sidebar-background))] !text-white",
                        "flex flex-col p-0 gap-0",
                    )}
                >
                    <div className="px-6 pt-6 pb-3 shrink-0 border-b border-border">
                        <DialogTitle>Configure question</DialogTitle>
                    </div>

                    <div className="flex-1 overflow-y-auto px-6 py-3 min-h-0">
                        {pendingQuestion &&
                            (() => {
                                const q = pendingQuestion;
                                switch (q.id) {
                                    case "radius":
                                        return (
                                            <RadiusQuestionComponent
                                                data={q.data}
                                                questionKey={q.key}
                                                forceExpanded
                                                compactAnswer
                                            />
                                        );
                                    case "thermometer":
                                        return (
                                            <ThermometerQuestionComponent
                                                data={q.data}
                                                questionKey={q.key}
                                                forceExpanded
                                                compactAnswer
                                            />
                                        );
                                    case "tentacles":
                                        return (
                                            <TentacleQuestionComponent
                                                data={q.data}
                                                questionKey={q.key}
                                                forceExpanded
                                                compactAnswer
                                            />
                                        );
                                    case "matching":
                                        return (
                                            <MatchingQuestionComponent
                                                data={q.data}
                                                questionKey={q.key}
                                                forceExpanded
                                                compactAnswer
                                            />
                                        );
                                    case "measuring":
                                        return (
                                            <MeasuringQuestionComponent
                                                data={q.data}
                                                questionKey={q.key}
                                                forceExpanded
                                                compactAnswer
                                            />
                                        );
                                    case "photo":
                                        return (
                                            <PhotoQuestionComponent
                                                data={q.data}
                                                questionKey={q.key}
                                                forceExpanded
                                                compactAnswer
                                            />
                                        );
                                    default:
                                        return null;
                                }
                            })()}
                    </div>

                    <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:justify-end">
                        <Button variant="outline" onClick={handleCancel}>
                            Cancel
                        </Button>
                        <Button onClick={handleConfirm}>
                            Confirm &amp; share
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
};
