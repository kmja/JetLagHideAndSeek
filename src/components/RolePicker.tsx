import { useStore } from "@nanostores/react";
import { Footprints, Users, VenetianMask } from "lucide-react";
import { useState } from "react";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { setupCompleted, welcomeSeen } from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import {
    currentGameCode,
    displayName as displayNameAtom,
    multiplayerEnabled,
    participants,
    pickRandomCastName,
    selfParticipantId,
} from "@/lib/multiplayer/session";
import { setOnlineRole } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";

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
    const $mp = useStore(multiplayerEnabled);
    const $participants = useStore(participants);
    const $self = useStore(selfParticipantId);
    const $welcomeSeen = useStore(welcomeSeen);
    const $setupCompleted = useStore(setupCompleted);
    const $code = useStore(currentGameCode);

    // In an online room the main hider slot is exclusive — the server
    // rejects a second hider (`role_taken`). Gate the option in the UI
    // so a joiner can't pick a role that's only going to bounce back.
    // The hider slot is exclusive AND persistent: the server's
    // max-one-hider check keys off role alone, not connection status, so
    // a transiently-offline hider (subway, backgrounded app) still holds
    // it. Gate on role presence — NOT `online` — otherwise a brief blip
    // would re-enable the Hider tile (claim bounces with role_taken) and
    // hide the co-hider "Join the hide" option mid-round.
    const hiderHolder = $mp
        ? $participants.find((p) => p.role === "hider" && p.id !== $self)
        : undefined;
    const hiderTaken = Boolean(hiderHolder);

    // v448: the host's role + name dialog. It layers OVER the lobby once
    // the game room exists ($code), so the host sees the lobby they just
    // created behind it. Joiners never see this — they pick their role
    // (and name) in the Welcome "Join" flow before the lobby mounts, so
    // they arrive with a role already set. Derived purely from state; no
    // imperative open atom.
    const open =
        $role === null &&
        $welcomeSeen &&
        $setupCompleted &&
        Boolean($code);

    // v279: name input moved here from the setup wizard. Roles +
    // display name are the same "this is me" decision; co-locating
    // them keeps the wizard about game settings only. Pre-fills from
    // the persistent atom so a returning user / role-switcher sees
    // their existing name; a fresh device gets a Jet Lag cast-name
    // placeholder so blank submissions get a reasonable default
    // server-side.
    const [draftName, setDraftName] = useState(displayNameAtom.get() || "");
    const [castPlaceholder] = useState(() => pickRandomCastName());

    // Persist the typed name to the displayName atom right before the
    // role click navigates away. Empty string OK — the server picks a
    // cast name when it sees `""`.
    const commitName = () => {
        displayNameAtom.set(draftName.trim());
    };

    const pickSeeker = () => {
        commitName();
        playerRole.set("seeker");
        // Push the choice to the server so the multiplayer roster
        // reflects the switch immediately (no-op when offline).
        setOnlineRole("seeker");
        // If we're on /h (hider page) and just became a seeker,
        // navigate back to / so we don't sit on the wrong surface.
        if (
            typeof window !== "undefined" &&
            window.location.pathname.startsWith("/h")
        ) {
            window.location.assign("/");
        }
    };

    const pickHider = () => {
        if (hiderTaken) return;
        commitName();
        playerRole.set("hider");
        setOnlineRole("hider");
        // Send them to the hider home.
        if (typeof window !== "undefined") window.location.assign("/h");
    };

    // Co-hider only makes sense once a primary hider holds the slot —
    // you're joining their hide, not starting your own.
    const pickCoHider = () => {
        if (!hiderTaken) return;
        commitName();
        playerRole.set("coHider");
        // No setOnlineRole — coHider is not a server-tracked role
        // (the server only knows seeker / hider / null).
        if (typeof window !== "undefined") window.location.assign("/h");
    };

    return (
        <Dialog
            open={open}
            // Not dismissible without a choice — picking a role flips
            // `open` (derived from $role) on its own, so Esc / outside-
            // click are intentionally no-ops here.
            onOpenChange={() => {}}
        >
            <DialogContent
                closeIcon={false}
                // z-[1060] (content + overlay) so it stacks ABOVE the
                // lobby drawer, whose content sits at z-[1055].
                className={cn(
                    "z-[1060]",
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                    "flex flex-col p-0 gap-0",
                )}
                overlayClassName="z-[1060]"
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

                <div className="px-6 pt-4 pb-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Icon + tone choices mirror the lobby roster
                        cards: Footprints for seekers (tracking
                        the hider — the older magnifying-glass icon
                        read as a generic "search field"),
                        VenetianMask for hiders, muted instead of
                        brand-coloured so the role identity doesn't
                        fight the question-category palette
                        downstream. */}
                    <button
                        type="button"
                        onClick={pickSeeker}
                        className={cn(
                            "flex flex-col items-start text-left gap-2 p-4 rounded-sm",
                            "bg-secondary/40 border-2 border-border",
                            "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                            "hover:bg-accent hover:-translate-y-[1px] transition-all",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <span className="inline-flex items-center justify-center w-8 h-8 rounded-sm bg-secondary text-muted-foreground">
                                <Footprints size={18} strokeWidth={2.4} />
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
                            "bg-secondary/20 border-2 border-border/70",
                            "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                            "transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            hiderTaken
                                ? "opacity-50 cursor-not-allowed"
                                : "hover:bg-accent hover:-translate-y-[1px]",
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <span className="inline-flex items-center justify-center w-8 h-8 rounded-sm bg-secondary/60 text-muted-foreground/70">
                                <VenetianMask size={18} strokeWidth={2.4} />
                            </span>
                            <span className="font-inter-tight font-black uppercase text-sm tracking-[0.12em]">
                                Hider
                            </span>
                        </div>
                        <p className="text-xs text-muted-foreground leading-snug">
                            Answers the seekers' questions and manages
                            the deck of hider cards. One per game.
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
                                    Co-hider
                                </span>
                                <span className="text-xs text-muted-foreground leading-snug">
                                    View-only. You see{" "}
                                    {hiderHolder?.displayName || "the hider"}
                                    's view live — hiding zone, incoming
                                    questions, deck — but they answer
                                    questions and play the cards.
                                </span>
                            </span>
                        </button>
                    </div>
                )}

                {/* Display name — placed BELOW the role tiles so the
                    on-screen keyboard (which slides up from the bottom
                    when this field is focused) covers only this input,
                    never the role buttons above. Optional: a blank
                    submission lets the server assign a Jet Lag cast
                    name. Pre-filled from the persistent atom. */}
                <div className="px-6 pt-1 pb-5 space-y-1.5 border-t border-border">
                    <label
                        htmlFor="rolepicker-display-name"
                        className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground"
                    >
                        Your display name
                    </label>
                    <Input
                        id="rolepicker-display-name"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        placeholder={`What others see (e.g. ${castPlaceholder})`}
                        maxLength={24}
                    />
                </div>
            </DialogContent>
        </Dialog>
    );
}

export default RolePicker;
