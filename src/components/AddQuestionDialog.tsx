import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { ClipboardPaste } from "lucide-react";
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
    addQuestion,
    defaultCustomQuestions,
    defaultUnit,
    isLoading,
    leafletMapContext,
    questions,
} from "@/lib/context";
import {
    encodeQuestionForHider,
    shareOrCopy,
} from "@/lib/shareLinks";
import { cn } from "@/lib/utils";

import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";
import { Button } from "./ui/button";

/**
 * A single category tile in the Add Question picker.
 * Visual identity (color + icon) comes from CATEGORIES.
 */
const CategoryTile = ({
    category,
    description,
    onClick,
    disabled,
    className,
}: {
    category: CategoryId;
    description: string;
    onClick: () => void;
    disabled?: boolean;
    className?: string;
}) => {
    const meta = CATEGORIES[category];
    const Icon = meta.icon;
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "flex flex-col gap-2 p-3 rounded-md text-left",
                "bg-secondary border border-border border-l-[3px]",
                "hover:bg-accent hover:-translate-y-[1px] transition-all",
                "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                className,
            )}
            style={{ borderLeftColor: meta.color }}
        >
            <div className="flex items-center gap-2">
                <span
                    className="inline-flex items-center justify-center w-7 h-7 rounded shrink-0"
                    style={{ backgroundColor: meta.color }}
                    aria-hidden="true"
                >
                    <Icon size={16} strokeWidth={2.5} className="text-white" />
                </span>
                <span className="font-poppins font-bold uppercase text-xs tracking-wider">
                    {meta.label}
                </span>
            </div>
            <span className="text-xs text-muted-foreground font-normal leading-snug">
                {description}
            </span>
        </button>
    );
};

export const AddQuestionDialog = ({
    children,
}: {
    children: React.ReactNode;
}) => {
    const $isLoading = useStore(isLoading);
    const $questions = useStore(questions);
    const [open, setOpen] = React.useState(false);
    // Key of the just-added question awaiting Confirm/Cancel.
    const [pendingKey, setPendingKey] = React.useState<number | null>(null);

    const pendingQuestion =
        pendingKey !== null
            ? $questions.find((q) => q.key === pendingKey)
            : null;

    // Helper: get the most recently added question's key, then promote it
    // to the "pending confirm" state and close the category picker.
    const promoteLastQuestion = () => {
        const list = questions.get();
        if (list.length === 0) return;
        const lastKey = list[list.length - 1].key;
        setPendingKey(lastKey);
        setOpen(false);
    };

    const handleCancel = () => {
        if (pendingKey === null) return;
        questions.set(questions.get().filter((q) => q.key !== pendingKey));
        setPendingKey(null);
    };

    const handleConfirm = async () => {
        if (!pendingQuestion) {
            setPendingKey(null);
            return;
        }
        // Snapshot the question before closing — pendingQuestion will become
        // null once we clear the dialog state.
        const q = pendingQuestion;
        const meta = CATEGORIES[q.id as CategoryId];
        setPendingKey(null);

        // Auto-share the question with hiders. The OS share sheet opens
        // synchronously off the user gesture; if the user dismisses it, the
        // question still stays added (this is correct — they may have just
        // changed their mind about who to send to).
        const url = encodeQuestionForHider(q);
        const result = await shareOrCopy({
            title: `${meta?.label ?? "Question"} for the hider`,
            text: `${meta?.label ?? "Question"}: tap to answer`,
            url,
        });
        if (result.method === "copy") {
            toast.info(
                "Question added. Link copied — sharing isn't supported in this browser.",
                { autoClose: 2500 },
            );
        } else if (result.method === "failed") {
            toast.error("Question added, but sharing failed");
        }
        // "share" and "cancelled" → silent (success / user dismiss)
    };

    const runAddRadius = () => {
        const map = leafletMapContext.get();
        if (!map) return false;
        const center = map.getCenter();
        addQuestion({
            id: "radius",
            data: {
                lat: center.lat,
                lng: center.lng,
                createdAt: Date.now(),
            },
        });
        return true;
    };

    const runAddThermometer = () => {
        const map = leafletMapContext.get();
        if (!map) return false;
        const center = map.getCenter();
        const unit = defaultUnit.get();
        // Sensible default offset depending on unit: 5 mi, 8 km, or 8000 m
        const offsetDistance =
            unit === "miles" ? 5 : unit === "kilometers" ? 8 : 8000;
        const destination = turf.destination(
            [center.lng, center.lat],
            offsetDistance,
            90,
            { units: unit },
        );

        addQuestion({
            id: "thermometer",
            data: {
                latA: center.lat,
                lngB: center.lng,
                latB: destination.geometry.coordinates[1],
                lngA: destination.geometry.coordinates[0],
                createdAt: Date.now(),
            },
        });

        return true;
    };

    const runAddTentacles = () => {
        const map = leafletMapContext.get();
        if (!map) return false;
        const center = map.getCenter();
        addQuestion({
            id: "tentacles",
            data: defaultCustomQuestions.get()
                ? {
                      lat: center.lat,
                      lng: center.lng,
                      locationType: "custom",
                      places: [],
                      createdAt: Date.now(),
                  }
                : {
                      lat: center.lat,
                      lng: center.lng,
                      createdAt: Date.now(),
                  },
        });
        return true;
    };

    const runAddMatching = () => {
        const map = leafletMapContext.get();
        if (!map) return false;
        const center = map.getCenter();
        addQuestion({
            id: "matching",
            data: defaultCustomQuestions.get()
                ? {
                      lat: center.lat,
                      lng: center.lng,
                      type: "custom-points",
                      createdAt: Date.now(),
                  }
                : {
                      lat: center.lat,
                      lng: center.lng,
                      createdAt: Date.now(),
                  },
        });
        return true;
    };

    const runAddMeasuring = () => {
        const map = leafletMapContext.get();
        if (!map) return false;
        const center = map.getCenter();
        addQuestion({
            id: "measuring",
            data: defaultCustomQuestions.get()
                ? {
                      lat: center.lat,
                      lng: center.lng,
                      type: "custom-measure",
                      createdAt: Date.now(),
                  }
                : {
                      lat: center.lat,
                      lng: center.lng,
                      createdAt: Date.now(),
                  },
        });
        return true;
    };

    const runPasteQuestion = async () => {
        if (!navigator || !navigator.clipboard) {
            toast.error("Clipboard API not supported in your browser");
            return false;
        }

        try {
            await toast.promise(
                navigator.clipboard.readText().then((text) => {
                    const parsed = JSON.parse(text);
                    const question =
                        parsed &&
                        typeof parsed === "object" &&
                        !Array.isArray(parsed)
                            ? { ...parsed, key: Math.random() }
                            : parsed;

                    return addQuestion(question);
                }),
                {
                    pending: "Reading from clipboard",
                    success: "Question added from clipboard!",
                    error: "No valid question found in clipboard",
                },
                { autoClose: 1000 },
            );

            return true;
        } catch {
            return false;
        }
    };

    return (
        <>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>{children}</DialogTrigger>
                <DialogContent>
                <DialogTitle>Add Question</DialogTitle>
                <DialogDescription>Pick a category.</DialogDescription>

                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <CategoryTile
                        category="matching"
                        description="Is something the same as us?"
                        onClick={() => {
                            if (runAddMatching()) promoteLastQuestion();
                        }}
                        disabled={$isLoading}
                    />
                    <CategoryTile
                        category="measuring"
                        description="Closer or further than us?"
                        onClick={() => {
                            if (runAddMeasuring()) promoteLastQuestion();
                        }}
                        disabled={$isLoading}
                    />
                    <CategoryTile
                        category="radius"
                        description="Within distance of us?"
                        onClick={() => {
                            if (runAddRadius()) promoteLastQuestion();
                        }}
                        disabled={$isLoading}
                    />
                    <CategoryTile
                        category="thermometer"
                        description="Hotter or colder after move?"
                        onClick={() => {
                            if (runAddThermometer()) promoteLastQuestion();
                        }}
                        disabled={$isLoading}
                    />
                    <CategoryTile
                        category="tentacles"
                        description="Nearest place of a type within range."
                        onClick={() => {
                            if (runAddTentacles()) promoteLastQuestion();
                        }}
                        disabled={$isLoading}
                        className="sm:col-span-2"
                    />
                </div>

                <button
                    type="button"
                    onClick={async () => {
                        const ok = await runPasteQuestion();
                        if (ok) setOpen(false);
                    }}
                    disabled={$isLoading}
                    className={cn(
                        "mt-2 flex items-center justify-center gap-2 p-3 rounded-md w-full",
                        "border border-dashed border-border",
                        "text-muted-foreground hover:text-foreground hover:border-foreground",
                        "transition-colors",
                        "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-muted-foreground disabled:hover:border-border",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                >
                    <ClipboardPaste size={14} />
                    <span className="text-xs font-poppins">
                        Paste from clipboard
                    </span>
                </button>
            </DialogContent>
            </Dialog>

            <Dialog
                open={pendingKey !== null}
                onOpenChange={(o) => {
                    if (!o) handleCancel();
                }}
            >
                <DialogContent className="!bg-[hsl(var(--sidebar-background))] !text-white">
                    <DialogTitle>Configure question</DialogTitle>
                    <DialogDescription>
                        Adjust the details below, then confirm to add it to your list.
                    </DialogDescription>

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
                                        />
                                    );
                                case "thermometer":
                                    return (
                                        <ThermometerQuestionComponent
                                            data={q.data}
                                            questionKey={q.key}
                                            forceExpanded
                                        />
                                    );
                                case "tentacles":
                                    return (
                                        <TentacleQuestionComponent
                                            data={q.data}
                                            questionKey={q.key}
                                            forceExpanded
                                        />
                                    );
                                case "matching":
                                    return (
                                        <MatchingQuestionComponent
                                            data={q.data}
                                            questionKey={q.key}
                                            forceExpanded
                                        />
                                    );
                                case "measuring":
                                    return (
                                        <MeasuringQuestionComponent
                                            data={q.data}
                                            questionKey={q.key}
                                            forceExpanded
                                        />
                                    );
                                default:
                                    return null;
                            }
                        })()}

                    <DialogFooter className="gap-2 sm:gap-2 mt-2">
                        <Button
                            variant="outline"
                            onClick={handleCancel}
                        >
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
