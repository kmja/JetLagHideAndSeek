import { useStore } from "@nanostores/react";
import { Eye, MapPin, Users, UserRound } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { welcomeSeen } from "@/lib/gameSetup";
import { playerRole, rolePickerOpen } from "@/lib/hiderRole";
import {
    multiplayerEnabled,
    participants,
    selfParticipantId,
} from "@/lib/multiplayer/session";

import {
    HideSeekMark,
    HideSeekWordmark,
    SectionPill,
} from "./JetLagLogo";

/**
 * First-time role gate. Shown when the user lands on the seeker app and
 * `playerRole` hasn't been set. Picking a role is the only way to dismiss
 * this dialog — there's no Cancel option.
 *
 *   - **Seeker** continues into the existing game-setup wizard.
 *   - **Hider** redirects to `/h` (hider home).
 *
 * The role is persistent. To switch later, the user can use "Switch role"
 * in the More sheet (rendered as long as a role is set).
 */
export function RolePicker() {
    const $role = useStore(playerRole);
    const $open = useStore(rolePickerOpen);
    const $mp = useStore(multiplayerEnabled);
    const $participants = useStore(participants);
    const $self = useStore(selfParticipantId);
    const $welcomeSeen = useStore(welcomeSeen);

    // In an online room the main hider slot is exclusive — the server
    // rejects a second hider (`role_taken`). Gate the option in the UI
    // so a joiner can't pick a role that's only going to bounce back.
    const hiderHolder = $mp
        ? $participants.find(
              (p) => p.role === "hider" && p.online && p.id !== $self,
          )
        : undefined;
    const hiderTaken = Boolean(hiderHolder);

    // Auto-open when no role has been chosen yet — but only after the
    // welcome screen has been dismissed. Otherwise both dialogs race
    // to open on a fresh load and stack on top of each other.
    useEffect(() => {
        if ($role === null && $welcomeSeen) rolePickerOpen.set(true);
    }, [$role, $welcomeSeen]);

    const open = ($open || $role === null) && $welcomeSeen;

    const pickSeeker = () => {
        playerRole.set("seeker");
        rolePickerOpen.set(false);
        // Already on the seeker home (index.astro), nothing to navigate.
    };

    const pickHider = () => {
        if (hiderTaken) return;
        playerRole.set("hider");
        rolePickerOpen.set(false);
        // Send them to the hider home.
        if (typeof window !== "undefined") window.location.assign("/h");
    };

    // Co-hider only makes sense once a primary hider holds the slot —
    // you're joining their hide, not starting your own.
    const pickCoHider = () => {
        if (!hiderTaken) return;
        playerRole.set("coHider");
        rolePickerOpen.set(false);
        if (typeof window !== "undefined") window.location.assign("/h");
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                // Don't allow dismissing without a choice — same pattern
                // as the wizard's onOpenChange guard.
                if (!o && playerRole.get() === null) return;
                rolePickerOpen.set(o);
            }}
        >
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-white",
                    "flex flex-col p-0 gap-0",
                )}
            >
                <div className="px-6 pt-5 pb-4 shrink-0 border-b border-border">
                    <div className="mb-3 flex items-center gap-3">
                        <HideSeekMark size={36} onDark />
                        <HideSeekWordmark />
                        <SectionPill className="ml-auto">Pick role</SectionPill>
                    </div>
                    <DialogTitle className="font-inter-tight font-black uppercase text-2xl tracking-tight leading-tight">
                        Which side are you on?
                    </DialogTitle>
                    <DialogDescription className="mt-2 text-sm">
                        Each device runs one side of the game. Pick yours
                        — you can switch later from the More menu.
                    </DialogDescription>
                </div>

                <div className="px-6 py-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                        type="button"
                        onClick={pickSeeker}
                        className={cn(
                            "flex flex-col items-start text-left gap-2 p-4 rounded-sm",
                            "bg-secondary border-2 border-border border-t-[6px] border-t-primary",
                            "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                            "hover:bg-accent hover:-translate-y-[1px] transition-all",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <span className="inline-flex items-center justify-center w-8 h-8 rounded-sm bg-primary text-primary-foreground">
                                <Eye size={18} strokeWidth={2.4} />
                            </span>
                            <span className="font-inter-tight font-black uppercase text-sm tracking-[0.12em]">
                                Seeker
                            </span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-snug">
                            Track the hider with questions, eliminate
                            possibilities on the map, close in.
                        </p>
                    </button>

                    <button
                        type="button"
                        onClick={pickHider}
                        disabled={hiderTaken}
                        className={cn(
                            "flex flex-col items-start text-left gap-2 p-4 rounded-sm",
                            "bg-secondary border-2 border-border border-t-[6px]",
                            "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                            "transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            hiderTaken
                                ? "opacity-50 cursor-not-allowed"
                                : "hover:bg-accent hover:-translate-y-[1px]",
                        )}
                        style={{
                            borderTopColor: "hsl(44 87% 64%)" /* yellow */,
                        }}
                    >
                        <div className="flex items-center gap-2">
                            <span
                                className="inline-flex items-center justify-center w-8 h-8 rounded-sm text-white"
                                style={{ background: "hsl(44 87% 64%)" }}
                            >
                                <MapPin size={18} strokeWidth={2.4} />
                            </span>
                            <span className="font-inter-tight font-black uppercase text-sm tracking-[0.12em]">
                                Hider
                            </span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-snug">
                            Pick a hiding zone, dodge the seeker's
                            questions, hold time-bonus cards.
                        </p>
                        {hiderTaken && (
                            <p className="text-[11px] font-semibold text-destructive">
                                Taken by{" "}
                                {hiderHolder?.displayName || "another player"}
                            </p>
                        )}
                    </button>
                </div>

                {hiderTaken && (
                    <div className="px-6 pb-4">
                        <button
                            type="button"
                            onClick={pickCoHider}
                            className={cn(
                                "w-full flex items-start text-left gap-3 p-4 rounded-sm",
                                "bg-secondary border-2 border-border",
                                "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                                "hover:bg-accent hover:-translate-y-[1px] transition-all",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            <span className="inline-flex items-center justify-center w-8 h-8 rounded-sm bg-muted text-foreground shrink-0">
                                <Users size={18} strokeWidth={2.4} />
                            </span>
                            <span className="flex flex-col gap-1">
                                <span className="font-inter-tight font-black uppercase text-sm tracking-[0.12em]">
                                    Join the hide
                                </span>
                                <span className="text-xs text-muted-foreground leading-snug">
                                    Hide together with{" "}
                                    {hiderHolder?.displayName || "the hider"}.
                                    You'll see the hiding zone and incoming
                                    questions live; they manage the cards and
                                    answers.
                                </span>
                            </span>
                        </button>
                    </div>
                )}

                <DialogFooter className="px-6 py-3 shrink-0 border-t border-border text-[11px] text-muted-foreground">
                    <UserRound className="w-3.5 h-3.5 shrink-0" />
                    <span className="text-left">
                        Roles map to separate URLs: <code>/</code> (seeker)
                        and <code>/h</code> (hider).
                    </span>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default RolePicker;
