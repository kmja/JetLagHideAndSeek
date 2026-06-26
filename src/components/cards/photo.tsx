import { useStore } from "@nanostores/react";
import { Ban, Camera, Check, ImagePlus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "react-toastify";

import { PhotoCensorDialog } from "@/components/PhotoCensorDialog";
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
import { appConfirm } from "@/lib/confirm";
import { endgameStartedAt } from "@/lib/gameSetup";
import { gameSize } from "@/lib/gameSetup";
import { playerRole, recordPhotoAnswerDraw } from "@/lib/hiderRole";
import {
    currentGameCode,
    multiplayerEnabled,
} from "@/lib/multiplayer/session";
import {
    hiderAnswerQuestion,
    uploadGamePhoto,
} from "@/lib/multiplayer/store";
import { getSubtypes, type SubtypeMeta } from "@/lib/subtypes";
import { cn } from "@/lib/utils";
import type { PhotoQuestion } from "@/maps/schema";

import { QuestionCard } from "./base";

/**
 * Decode a captured image file and downscale it onto a canvas at the
 * given max edge. Shared by the data-URI and Blob encoders below. Phone
 * photos are routinely 4–8 MB; we resize before encoding so neither
 * localStorage nor the upload carries the raw original.
 */
async function fileToScaledCanvas(
    file: File,
    maxEdge: number,
): Promise<HTMLCanvasElement> {
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
                resolve(canvas);
            };
            img.src = reader.result as string;
        };
        reader.readAsDataURL(file);
    });
}

/**
 * Compress to a JPEG data URI at the given max edge. Used for the small
 * local thumbnail (multiplayer) and the full-res inline image (solo).
 */
async function fileToCompressedDataUri(
    file: File,
    maxEdge = 1200,
    quality = 0.8,
): Promise<string> {
    const canvas = await fileToScaledCanvas(file, maxEdge);
    return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Compress to a JPEG Blob at the given max edge — the upload payload for
 * the full-detail photo that goes to R2. Defaults target ~2560px / q0.85,
 * which lands ~1–2 MB for a typical phone photo: plenty of detail for the
 * seekers to zoom into signage and fine features.
 */
async function fileToCompressedBlob(
    file: File,
    maxEdge = 2560,
    quality = 0.85,
): Promise<Blob> {
    const canvas = await fileToScaledCanvas(file, maxEdge);
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) =>
                blob ? resolve(blob) : reject(new Error("encode failed")),
            "image/jpeg",
            quality,
        );
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
    const $role = useStore(playerRole);
    const $endgame = useStore(endgameStartedAt);
    const isHideTeam = $role === "hider" || $role === "coHider";
    const inEndgame = $endgame !== null;

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

    // The full-detail photo lives at `photoUrl` (R2) when online; in
    // solo/offline play the image is inline in `photoUri`. Prefer the URL.
    const imgSrc = data.photoUrl ?? data.photoUri;

    const summary = data.drag
        ? `${subtypeLabel} · awaiting photo`
        : data.declined
          ? `${subtypeLabel} · couldn't answer`
          : imgSrc
            ? `${subtypeLabel} · photo received`
            : `${subtypeLabel} · marked answered`;

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    // Photo picked but not yet committed — drives the censor/review dialog.
    const [pendingFile, setPendingFile] = useState<File | null>(null);

    const onFile = async (file: File | null | undefined) => {
        if (!file) return;
        try {
            const wasUnanswered = data.drag;
            const online =
                isHideTeam &&
                multiplayerEnabled.get() &&
                !!currentGameCode.get();

            // Small thumbnail — instant local display, offline-safe, and
            // the wire fallback if the full-res upload fails (well under
            // the 64 KB WebSocket cap).
            const thumb = await fileToCompressedDataUri(file, 640, 0.7);

            // Online: upload the full-detail image to R2 and ship only
            // its URL. This is what lets multi-megabyte photos reach the
            // seekers — the data URI never crosses the WebSocket.
            let photoUrl: string | undefined;
            if (online) {
                try {
                    const fullBlob = await fileToCompressedBlob(
                        file,
                        2560,
                        0.85,
                    );
                    photoUrl = await uploadGamePhoto(fullBlob);
                } catch (e) {
                    console.warn(
                        "photo upload failed; falling back to inline thumbnail",
                        e,
                    );
                }
            }

            if (photoUrl) {
                // Full detail via URL; keep a thumbnail for instant local
                // render and offline viewing.
                data.photoUrl = photoUrl;
                data.photoUri = thumb;
            } else if (online) {
                // Upload failed — at least inline the thumbnail so the
                // seekers see *something*.
                data.photoUrl = undefined;
                data.photoUri = thumb;
            } else {
                // Solo / offline — inline the full-resolution image for
                // local viewing (no seeker to send it to).
                data.photoUrl = undefined;
                data.photoUri = await fileToCompressedDataUri(file, 2560, 0.85);
            }
            data.declined = false;
            data.drag = false;
            questionModified();

            // Push the answer to the seekers. Prefer the URL (a few
            // bytes); only inline the thumbnail when there's no URL.
            if (isHideTeam) {
                hiderAnswerQuestion(questionKey, {
                    ...(photoUrl
                        ? { photoUrl }
                        : { photoUri: data.photoUri }),
                    declined: false,
                    drag: false,
                });
                // Award the photo card-draw on first resolution
                // (rulebook p32, draw 1 keep 1). Idempotent + guarded
                // by `wasUnanswered` so replacing a photo doesn't farm
                // extra cards.
                if (wasUnanswered) recordPhotoAnswerDraw(questionKey);
            }

            if (online && !photoUrl) {
                toast.warn(
                    "Couldn't upload the full-size photo — sent a smaller preview instead.",
                    { autoClose: 4000 },
                );
            } else {
                toast.success("Photo attached. Question committed.", {
                    autoClose: 2500,
                });
            }
        } catch (e) {
            console.warn("photo compression failed", e);
            toast.error("Couldn't process that photo. Try another one.");
        }
    };

    // "I cannot answer the question" (rulebook p32). Valid when the
    // subject doesn't exist in the zone, and — the headline endgame
    // rule — when the hider is locked to their final spot and can't
    // travel to take the shot (rulebook p7). The hider still draws a
    // card.
    const onDecline = () => {
        const wasUnanswered = data.drag;
        data.declined = true;
        data.drag = false;
        questionModified();
        if (isHideTeam) {
            hiderAnswerQuestion(questionKey, {
                declined: true,
                drag: false,
            });
            if (wasUnanswered) recordPhotoAnswerDraw(questionKey);
        }
        toast.info('Answered "I cannot answer the question."', {
            autoClose: 2500,
        });
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

                    {imgSrc ? (
                        <div className="relative">
                            <img
                                src={imgSrc}
                                alt={subtypeLabel}
                                className="w-full rounded-md border border-border max-h-[300px] object-contain bg-black/30"
                            />
                            <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                className="absolute top-1 right-1 h-7 px-2"
                                onClick={async () => {
                                    const ok = await appConfirm({
                                        title: "Remove this photo?",
                                        confirmLabel: "Remove",
                                        destructive: true,
                                    });
                                    if (!ok) return;
                                    data.photoUri = undefined;
                                    data.photoUrl = undefined;
                                    questionModified();
                                }}
                                disabled={$isLoading}
                                aria-label="Remove photo"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                        </div>
                    ) : data.declined ? (
                        <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 flex items-start gap-2.5">
                            <Ban className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                                <div className="text-xs font-poppins font-bold uppercase tracking-wide text-yellow-400">
                                    Couldn&apos;t answer
                                </div>
                                <p className="text-xs text-muted-foreground leading-snug mt-0.5">
                                    The hider answered &quot;I cannot answer
                                    the question&quot; — the subject
                                    isn&apos;t reachable from their locked
                                    spot. A card was still drawn.
                                </p>
                            </div>
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

                    {/* Endgame hint — the rulebook's headline endgame
                        rule: a locked-down hider may legitimately
                        decline location-bound photos. Surface it so the
                        hide team knows the option is on the table. */}
                    {data.drag && isHideTeam && inEndgame && (
                        <p className="text-[11px] leading-snug text-yellow-400/90 border border-yellow-500/40 bg-yellow-500/5 rounded-md px-2.5 py-2">
                            Endgame: if this photo would mean leaving your
                            hiding spot, you can answer &quot;I cannot
                            answer&quot; and still draw a card.
                        </p>
                    )}

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        onChange={(e) => {
                            const picked = e.currentTarget.files?.[0];
                            // Reset so the same file can be picked twice
                            e.currentTarget.value = "";
                            // Route through the censor/review step instead
                            // of committing straight away — the hider gets
                            // to black out identifying detail first.
                            if (picked) setPendingFile(picked);
                        }}
                    />

                    {pendingFile && (
                        <PhotoCensorDialog
                            file={pendingFile}
                            onCancel={() => setPendingFile(null)}
                            onConfirm={(redacted) => {
                                setPendingFile(null);
                                onFile(redacted);
                            }}
                        />
                    )}

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
                            {imgSrc ? "Replace photo" : "Attach photo"}
                        </Button>
                        {data.drag && (
                            <Button
                                type="button"
                                variant="default"
                                size="sm"
                                className="flex-1 gap-1.5"
                                onClick={() => {
                                    const wasUnanswered = data.drag;
                                    data.drag = false;
                                    data.declined = false;
                                    questionModified();
                                    // Same mp-sync as onFile — hide
                                    // team marking the question done
                                    // without attaching needs to flip
                                    // drag on the seeker too.
                                    if (isHideTeam) {
                                        hiderAnswerQuestion(questionKey, {
                                            declined: false,
                                            drag: false,
                                        });
                                        if (wasUnanswered)
                                            recordPhotoAnswerDraw(
                                                questionKey,
                                            );
                                    }
                                }}
                                disabled={$isLoading}
                            >
                                <Check className="w-3.5 h-3.5" />
                                Mark answered
                            </Button>
                        )}
                    </div>

                    {/* "I cannot answer" — rulebook-valid response,
                        only meaningful for the hide team while the
                        question is still open. */}
                    {data.drag && isHideTeam && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className={cn(
                                "w-full gap-1.5",
                                inEndgame
                                    ? "text-yellow-400 hover:text-yellow-300 hover:bg-yellow-500/10"
                                    : "text-muted-foreground",
                            )}
                            onClick={onDecline}
                            disabled={$isLoading}
                        >
                            <Ban className="w-3.5 h-3.5" />
                            I cannot answer this
                        </Button>
                    )}
                </div>
            </SidebarMenuItem>
        </QuestionCard>
    );
};
