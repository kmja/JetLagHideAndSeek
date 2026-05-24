import { useStore } from "@nanostores/react";
import { Check, Crown, EyeOff, Rocket, User, UserX } from "lucide-react";
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
     * Called with the picked participant id when the user taps
     * "Start round". The parent decides what to do with it (send
     * `seekerRotateHider`, then `startNewRound`).
     */
    onConfirm: (newHiderId: string) => void;
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

    // Default selection: current hider, falling back to self,
    // falling back to the first participant. Re-derived whenever
    // the dialog (re-)opens so a long-running app doesn't keep a
    // stale selection from a previous round.
    const [selectedId, setSelectedId] = useState<string | null>(
        currentHiderId ?? $self,
    );
    useEffect(() => {
        if (open) {
            setSelectedId(currentHiderId ?? $self ?? ordered[0]?.id ?? null);
        }
    }, [open, currentHiderId, $self, ordered]);

    const handleConfirm = () => {
        if (!selectedId) return;
        onConfirm(selectedId);
    };

    const canSelect = (online: boolean) => online;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="font-inter-tight">
                        Start new round
                    </DialogTitle>
                    <DialogDescription>
                        Pick who hides next. Question log, hand and
                        zone all reset. Play area, transit and game
                        size stay the same.
                    </DialogDescription>
                </DialogHeader>

                <ul className="flex flex-col gap-2 max-h-[50dvh] overflow-y-auto">
                    {ordered.map((p) => {
                        const isCurrentHider = p.role === "hider";
                        const isSelf = p.id === $self;
                        const selectable = canSelect(p.online);
                        const isSelected = selectedId === p.id;
                        return (
                            <li key={p.id}>
                                <button
                                    type="button"
                                    onClick={() =>
                                        selectable && setSelectedId(p.id)
                                    }
                                    disabled={!selectable}
                                    aria-pressed={isSelected}
                                    className={cn(
                                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-md border text-left",
                                        "transition-colors",
                                        selectable
                                            ? "hover:bg-accent/40 cursor-pointer"
                                            : "opacity-50 cursor-not-allowed",
                                        isSelected
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
                                            <span className="font-medium truncate">
                                                {p.displayName || "Anonymous"}
                                            </span>
                                            {isSelf && (
                                                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                                    you
                                                </span>
                                            )}
                                        </span>
                                        <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                                            {isCurrentHider ? (
                                                <>
                                                    <EyeOff className="w-3 h-3" />
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
                                    {/* Selection check */}
                                    <span
                                        className={cn(
                                            "w-5 h-5 rounded-full border flex items-center justify-center shrink-0",
                                            isSelected
                                                ? "border-primary bg-primary text-primary-foreground"
                                                : "border-border",
                                        )}
                                        aria-hidden
                                    >
                                        {isSelected && (
                                            <Check className="w-3 h-3" />
                                        )}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>

                {/* Helper note when the picked hider would be a
                    different person than now — primes the user for
                    the role-swap that's about to happen. */}
                {selectedId && currentHiderId && selectedId !== currentHiderId ? (
                    <p className="text-[11px] text-muted-foreground leading-snug">
                        Hider role will move from{" "}
                        <span className="font-medium">
                            {ordered.find((p) => p.id === currentHiderId)
                                ?.displayName || "the current hider"}
                        </span>{" "}
                        to{" "}
                        <span className="font-medium">
                            {ordered.find((p) => p.id === selectedId)
                                ?.displayName || "this player"}
                        </span>
                        .
                    </p>
                ) : selectedId && !currentHiderId ? (
                    <p className="text-[11px] text-muted-foreground leading-snug">
                        No one is the hider yet — the player you pick
                        becomes the first hider for this round.
                    </p>
                ) : null}

                <DialogFooter className="gap-2">
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={handleConfirm}
                        disabled={!selectedId}
                        className="gap-2"
                    >
                        <Rocket className="w-4 h-4" />
                        Start round
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default RotateHiderDialog;
