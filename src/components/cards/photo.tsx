import { useStore } from "@nanostores/react";
import { Camera, Check, ImagePlus, Trash2 } from "lucide-react";
import { useRef } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import {
    isLoading,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { gameSize } from "@/lib/gameSetup";
import { getSubtypes, type SubtypeMeta } from "@/lib/subtypes";
import { cn } from "@/lib/utils";
import type { PhotoQuestion } from "@/maps/schema";

import { QuestionCard } from "./base";

/**
 * Resize a captured image down to a sensible max edge before storing it
 * as a data URI. Phone photos are routinely 4–8 MB which blows past any
 * sensible localStorage budget. We hit ~80 KB at 1200px JPEG quality 0.8,
 * which is fine for a "look, this is the tree" answer.
 */
async function fileToCompressedDataUri(
    file: File,
    maxEdge = 1200,
    quality = 0.8,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error("decode failed"));
            img.onload = () => {
                const scale = Math.min(
                    1,
                    maxEdge / Math.max(img.width, img.height),
                );
                const w = Math.round(img.width * scale);
                const h = Math.round(img.height * scale);
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                if (!ctx) return reject(new Error("no 2d ctx"));
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL("image/jpeg", quality));
            };
            img.src = reader.result as string;
        };
        reader.readAsDataURL(file);
    });
}

export const PhotoQuestionComponent = ({
    data,
    questionKey,
    forceExpanded,
    sub,
    className,
}: {
    data: PhotoQuestion;
    questionKey: number;
    sub?: string;
    forceExpanded?: boolean;
    className?: string;
    /** Accepted for API symmetry with other cards; photo has no
     *  toggle answer so this is currently a no-op. */
    compactAnswer?: boolean;
}) => {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);
    const $gameSize = useStore(gameSize);

    const label = `Photo ${
        $questions
            .filter((q) => q.id === "photo")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    const subtypes = getSubtypes("photo", $gameSize) ?? [];
    const meta: SubtypeMeta | undefined = subtypes.find(
        (s) => s.value === data.type,
    );
    const subtypeLabel = meta?.label ?? data.type;
    const subtypeDescription = meta?.description;

    const summary = data.drag
        ? `${subtypeLabel} · awaiting photo`
        : data.photoUri
          ? `${subtypeLabel} · photo received`
          : `${subtypeLabel} · marked answered`;

    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const onFile = async (file: File | null | undefined) => {
        if (!file) return;
        try {
            const dataUri = await fileToCompressedDataUri(file);
            data.photoUri = dataUri;
            data.drag = false;
            questionModified();
            toast.success("Photo attached. Question committed.", {
                autoClose: 2500,
            });
        } catch (e) {
            console.warn("photo compression failed", e);
            toast.error("Couldn't process that photo. Try another one.");
        }
    };

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub}
            category="photo"
            summary={summary}
            createdAt={data.createdAt}
            className={className}
            forceExpanded={forceExpanded}
            collapsed={data.collapsed}
            setCollapsed={(collapsed) => {
                data.collapsed = collapsed;
            }}
            locked={!data.drag}
            setLocked={(locked) => questionModified((data.drag = !locked))}
        >
            <SidebarMenuItem>
                <div className={cn(MENU_ITEM_CLASSNAME, "flex flex-col gap-3")}>
                    <div className="flex items-start gap-3">
                        <Camera className="w-5 h-5 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                            <div className="font-inter-tight font-bold uppercase tracking-wide text-sm">
                                {subtypeLabel}
                            </div>
                            {subtypeDescription && (
                                <div className="text-xs text-muted-foreground leading-snug mt-0.5">
                                    {subtypeDescription}
                                </div>
                            )}
                        </div>
                    </div>

                    {data.photoUri ? (
                        <div className="relative">
                            <img
                                src={data.photoUri}
                                alt={subtypeLabel}
                                className="w-full rounded-md border border-border max-h-[300px] object-contain bg-black/30"
                            />
                            <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                className="absolute top-1 right-1 h-7 px-2"
                                onClick={() => {
                                    if (
                                        confirm("Remove this photo?") ===
                                        true
                                    ) {
                                        data.photoUri = undefined;
                                        questionModified();
                                    }
                                }}
                                disabled={$isLoading}
                                aria-label="Remove photo"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                        </div>
                    ) : (
                        <div className="rounded-md border border-dashed border-border bg-secondary/30 p-3 flex flex-col items-center gap-2 text-center">
                            <ImagePlus className="w-7 h-7 text-muted-foreground" />
                            <p className="text-xs text-muted-foreground leading-snug">
                                Hider sends a photo. When received, attach
                                it here — or just mark the question
                                answered without uploading.
                            </p>
                        </div>
                    )}

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        onChange={(e) => {
                            onFile(e.currentTarget.files?.[0]);
                            // Reset so the same file can be picked twice
                            e.currentTarget.value = "";
                        }}
                    />

                    <div className="flex gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="flex-1 gap-1.5"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={$isLoading}
                        >
                            <ImagePlus className="w-3.5 h-3.5" />
                            {data.photoUri ? "Replace photo" : "Attach photo"}
                        </Button>
                        {data.drag && (
                            <Button
                                type="button"
                                variant="default"
                                size="sm"
                                className="flex-1 gap-1.5"
                                onClick={() => {
                                    data.drag = false;
                                    questionModified();
                                }}
                                disabled={$isLoading}
                            >
                                <Check className="w-3.5 h-3.5" />
                                Mark answered
                            </Button>
                        )}
                    </div>
                </div>
            </SidebarMenuItem>
        </QuestionCard>
    );
};
