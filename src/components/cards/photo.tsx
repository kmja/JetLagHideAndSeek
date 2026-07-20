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
import { hiderAnswerQuestion } from "@/lib/multiplayer/store";
import { preparePhotoForSend } from "@/lib/photo";
import { getSubtypes, type SubtypeMeta } from "@/lib/subtypes";
import { cn } from "@/lib/utils";
import type { PhotoQuestion } from "@/maps/schema";

import { QuestionCard } from "./base";

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
    const isHideTeam = $role === "hider";
    const inEndgame = $endgame !== null;
    // v869: in a multiplayer game the HIDER captures + sends the photo over
    // the wire and the seeker RECEIVES it automatically (the answer arrives
    // with `photoUrl`) — so the seeker must NOT see the manual "Attach photo"
    // / "Mark answered" controls (a stale pre-multiplayer remnant that made
    // the seeker card look broken). Manual capture stays for the hide team,
    // and for solo/offline play (no hider on the wire — the local user is
    // both roles).
    const $mp = useStore(multiplayerEnabled);
    const $code = useStore(currentGameCode);
    const inMultiplayer = $mp && !!$code;
    const showManualCapture = isHideTeam || !inMultiplayer;

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
    // v1028: a second input with `capture` for a direct camera viewfinder,
    // alongside the plain gallery/files input above.
    const cameraInputRef = useRef<HTMLInputElement | null>(null);
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

            const { photoUri, photoUrl, fellBack } = await preparePhotoForSend(
                file,
                online,
            );
            data.photoUri = photoUri;
            data.photoUrl = photoUrl; // undefined unless uploaded
            data.declined = false;
            data.drag = false;
            questionModified();

            // Push the answer to the seekers. Prefer the URL (a few
            // bytes); only inline the thumbnail when there's no URL.
            if (isHideTeam) {
                hiderAnswerQuestion(questionKey, {
                    ...(photoUrl ? { photoUrl } : { photoUri }),
                    declined: false,
                    drag: false,
                });
                // Award the photo card-draw on first resolution
                // (rulebook p32, draw 1 keep 1). Idempotent + guarded
                // by `wasUnanswered` so replacing a photo doesn't farm
                // extra cards.
                if (wasUnanswered) recordPhotoAnswerDraw(questionKey);
            }

            if (fellBack) {
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
                    {/* v1019: the subtype NAME is already the card header
                        ("PHOTO · THE SKY"), so the old icon + repeated label
                        here was pure duplication. Show just the rulebook
                        instruction for this photo (e.g. "Phone on ground, shoot
                        directly up.") as a clear callout. */}
                    {subtypeDescription && (
                        <div className="rounded-md border border-border/60 bg-secondary/40 px-3 py-2 text-sm text-muted-foreground leading-snug">
                            {subtypeDescription}
                        </div>
                    )}

                    {imgSrc ? (
                        <div className="relative">
                            <img
                                src={imgSrc}
                                alt={subtypeLabel}
                                className="w-full rounded-md border border-border max-h-[300px] object-contain bg-black/30"
                            />
                            {/* v936: only the CAPTURING side (hide team /
                                offline) may remove/replace a photo. A
                                multiplayer SEEKER views a received photo
                                read-only — removing it locally desynced from
                                the hider and read as "I can delete the
                                answer," which they shouldn't. */}
                            {showManualCapture && (
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
                            )}
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
                                    isn&apos;t in their hiding zone (rulebook
                                    p32). A card was still drawn.
                                </p>
                            </div>
                        </div>
                    ) : forceExpanded ? null : (
                        // v936: no placeholder image box in the CONFIGURE
                        // dialog (forceExpanded) — the seeker is still ASKING,
                        // there's nothing received to preview, and the empty
                        // dashed box just read as a broken image area. It
                        // still shows in the question LOG (a pending photo) so
                        // the waiting state is visible there.
                        <div className="rounded-md border border-dashed border-border bg-secondary/30 p-3 flex flex-col items-center gap-2 text-center">
                            <ImagePlus className="w-7 h-7 text-muted-foreground" />
                            <p className="text-xs text-muted-foreground leading-snug">
                                {showManualCapture
                                    ? "Hider sends a photo. When received, attach it here — or just mark the question answered without uploading."
                                    : "Waiting for the hider to take and send a photo. It'll appear here automatically."}
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

                    {/* Gallery / files input (no `capture`). */}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
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
                    {/* Camera input — opens the rear camera viewfinder. */}
                    <input
                        ref={cameraInputRef}
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

                    <div
                        className={cn(
                            "flex flex-wrap gap-2",
                            !showManualCapture && "hidden",
                        )}
                    >
                        <Button
                            type="button"
                            variant="default"
                            size="sm"
                            className="flex-1 gap-1.5 min-w-[8rem]"
                            onClick={() => cameraInputRef.current?.click()}
                            disabled={$isLoading}
                        >
                            <Camera className="w-3.5 h-3.5" />
                            {imgSrc ? "Retake photo" : "Take photo"}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="flex-1 gap-1.5 min-w-[8rem]"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={$isLoading}
                        >
                            <ImagePlus className="w-3.5 h-3.5" />
                            {imgSrc ? "Replace from gallery" : "Upload from gallery"}
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
