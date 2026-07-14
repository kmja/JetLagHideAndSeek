import { useStore } from "@nanostores/react";
import { Check, Crown, EyeOff, User, UserX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    participants,
    selfParticipantId,
} from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/**
 * "Start new round" dialog that lets the user pick which participant
 * becomes the next hider before the round resets.
 *
 * Defaults the selection to the participant currently holding the
 * `hider` role (so "same hider continues" is one click). The action
 * button is "Start round" — confirming both rotates the role and
 * triggers the local `startNewRound` cleanup. Offline / empty rooms
 * never see this dialog: the BottomNav / HiderHome callsites
 * short-circuit straight to the no-rotation path in that case.
 *
 * Pure UI — the wire send + local reset live in the parent
 * (`onConfirm`). This component just gathers intent.
 */
export interface RotateHiderDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /**
     * Called when the user taps "Start round" with the selected hide team.
     * Every hider is equal (v829), so the first id + the rest are just the
     * wire shape the parent forwards to `seekerRotateHider` — all become
     * `hider`. Then the parent runs `startNewRound`.
     */
    onConfirm: (primaryHiderId: string, coHiderIds: string[]) => void;
}

export function RotateHiderDialog({
    open,
    onOpenChange,
    onConfirm,
}: RotateHiderDialogProps) {
    const $participants = useStore(participants);
    const $self = useStore(selfParticipantId);

    // Stable display order: current hider first, self second,
    // then the rest by joinedAt. The current hider gets the visual
    // top spot so the "keep same hider" default is obvious.
    const ordered = useMemo(() => {
        const list = [...$participants];
        list.sort((a, b) => {
            if (a.role === "hider" && b.role !== "hider") return -1;
            if (b.role === "hider" && a.role !== "hider") return 1;
            if (a.id === $self && b.id !== $self) return -1;
            if (b.id === $self && a.id !== $self) return 1;
            return a.joinedAt - b.joinedAt;
        });
        return list;
    }, [$participants, $self]);

    const currentHiderId =
        ordered.find((p) => p.role === "hider")?.id ?? null;

    // Suggested next hider — a simple round-robin: the next online
    // player after the current hider, by join order, wrapping around.
    // This rotates the hide through the table over successive rounds
    // while staying predictable. With no current hider yet, suggest
    // the first online player. The table can always override.
    const suggestedId = useMemo(() => {
        const online = [...$participants]
            .filter((p) => p.online)
            .sort((a, b) => a.joinedAt - b.joinedAt);
        if (online.length === 0) return null;
        const curIdx = online.findIndex((p) => p.role === "hider");
        if (curIdx === -1) return online[0].id;
        return online[(curIdx + 1) % online.length].id;
    }, [$participants]);

    // MULTI-select hide team (v829: every hider is equal — no main/co
    // distinction). `selectedIds` = everyone hiding this round; everyone not
    // selected becomes a seeker. Default: the suggested single hider. Re-
    // derived on every (re-)open so a long-running app never keeps a stale
    // selection.
    const [selectedIds, setSelectedIds] = useState<Set<string>>(
        () => new Set(),
    );
    useEffect(() => {
        if (!open) return;
        const def =
            suggestedId ?? currentHiderId ?? $self ?? ordered[0]?.id ?? null;
        setSelectedIds(def ? new Set([def]) : new Set());
    }, [open, suggestedId, currentHiderId, $self, ordered]);

    const canSelect = (online: boolean) => online;

    const toggleMember = (id: string) => {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelectedIds(next);
    };

    const handleConfirm = () => {
        const ids = [...selectedIds];
        if (ids.length === 0) return;
        // All become equal hiders; the (first, rest) split is just the wire
        // shape the parent forwards.
        onConfirm(ids[0], ids.slice(1));
    };

    const firstSelectedName =
        ordered.find((p) => selectedIds.has(p.id))?.displayName || "This player";

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            {/* Launched from TWO surfaces: the lobby drawer (RoundEndSection,
                content z-[1055]) AND the EndOfRoundDialog celebration (a fixed
                overlay at z-[1072]). The shared DialogContent/overlay default
                to z-[1050], so it must clear BOTH — v826 bug: at z-[1060] it
                opened BEHIND the EndOfRoundDialog and "New round did nothing".
                z-[1080] sits above every launch context. */}
            <DialogContent
                className="sm:max-w-md z-[1080]"
                overlayClassName="z-[1080]"
            >
                <DialogHeader>
                    <DialogTitle className="font-inter-tight text-2xl font-bold">
                        Rotate hider
                    </DialogTitle>
                    <DialogDescription className="text-sm">
                        Pick who hides next — select one or more. Everyone you
                        pick hides together; everyone else becomes a seeker.
                        Question log, hand and zone all reset; play area,
                        transit and game size stay the same.
                    </DialogDescription>
                </DialogHeader>

                <ul className="flex flex-col gap-2 max-h-[50dvh] overflow-y-auto">
                    {ordered.map((p) => {
                        const isCurrentHider = p.role === "hider";
                        const isSelf = p.id === $self;
                        const selectable = canSelect(p.online);
                        const isMember = selectedIds.has(p.id);
                        const isSuggested =
                            p.id === suggestedId && p.id !== currentHiderId;
                        return (
                            <li key={p.id}>
                                <button
                                    type="button"
                                    onClick={() =>
                                        selectable && toggleMember(p.id)
                                    }
                                    disabled={!selectable}
                                    aria-pressed={isMember}
                                    className={cn(
                                        "w-full flex items-center gap-3 px-3 py-3 rounded-md border text-left",
                                        "transition-colors",
                                        selectable
                                            ? "hover:bg-accent/40 cursor-pointer"
                                            : "opacity-50 cursor-not-allowed",
                                        isMember
                                            ? "border-primary bg-primary/10"
                                            : "border-border",
                                    )}
                                >
                                    {/* Avatar */}
                                    <span
                                        className={cn(
                                            "w-9 h-9 rounded-full flex items-center justify-center shrink-0",
                                            isCurrentHider
                                                ? "bg-primary/20 text-primary"
                                                : "bg-muted text-muted-foreground",
                                        )}
                                    >
                                        {isCurrentHider ? (
                                            <Crown className="w-4 h-4" />
                                        ) : !p.online ? (
                                            <UserX className="w-4 h-4" />
                                        ) : (
                                            <User className="w-4 h-4" />
                                        )}
                                    </span>
                                    {/* Name + role */}
                                    <span className="flex flex-col min-w-0 grow">
                                        <span className="flex items-center gap-1.5">
                                            <span className="text-base font-medium truncate">
                                                {p.displayName || "Anonymous"}
                                            </span>
                                            {isSelf && (
                                                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                                                    you
                                                </span>
                                            )}
                                            {isSuggested && (
                                                <span className="text-xs uppercase tracking-wider font-semibold text-primary">
                                                    suggested
                                                </span>
                                            )}
                                        </span>
                                        <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                                            {isMember ? (
                                                <span className="inline-flex items-center gap-1 text-primary font-semibold">
                                                    <EyeOff className="w-3.5 h-3.5" />
                                                    Hiding this round
                                                </span>
                                            ) : isCurrentHider ? (
                                                <>
                                                    <EyeOff className="w-3.5 h-3.5" />
                                                    Current hider
                                                </>
                                            ) : p.role === "seeker" ? (
                                                "Seeker"
                                            ) : (
                                                "Unassigned"
                                            )}
                                            {!p.online && (
                                                <span className="text-destructive">
                                                    · offline
                                                </span>
                                            )}
                                        </span>
                                    </span>
                                    {/* Membership checkbox */}
                                    <span
                                        className={cn(
                                            "w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0",
                                            isMember
                                                ? "border-primary bg-primary text-primary-foreground"
                                                : "border-border",
                                        )}
                                        aria-hidden
                                    >
                                        {isMember && (
                                            <Check className="w-4 h-4" />
                                        )}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>

                {/* Helper note: summarise the hide team about to be set. */}
                {selectedIds.size > 0 ? (
                    <p className="text-sm text-muted-foreground leading-snug">
                        {selectedIds.size > 1 ? (
                            <>
                                <span className="font-medium">
                                    {selectedIds.size} players
                                </span>{" "}
                                hide this round; everyone else becomes a seeker.
                            </>
                        ) : (
                            <>
                                <span className="font-medium">
                                    {firstSelectedName}
                                </span>{" "}
                                hides this round; everyone else becomes a
                                seeker.
                            </>
                        )}
                    </p>
                ) : (
                    <p className="text-sm text-muted-foreground leading-snug">
                        Select at least one player to hide this round.
                    </p>
                )}

                <DialogFooter className="gap-2">
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleConfirm}
                        disabled={selectedIds.size === 0}
                    >
                        Start round
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default RotateHiderDialog;
