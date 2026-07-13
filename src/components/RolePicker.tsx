import { useStore } from "@nanostores/react";
import { Footprints, Users, VenetianMask } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { appNavigate } from "@/lib/appNavigate";
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

    // (The stuck `body{pointer-events:none}` from the picker-Dialog-over-lobby-
    // Drawer stack — v762 — is now cleared globally by
    // installBodyPointerEventsGuard; no picker-local release loop needed.)

    // v803: the dialog is ANCHORED TO THE TOP (see DialogContent below), so
    // it no longer moves when the keyboard opens/closes — the old
    // VisualViewport keyboard-inset re-centering was removed.

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

    // v452: select-then-confirm. Tapping a tile only HIGHLIGHTS it (like
    // the transit-mode chips); the "Join game" button below commits.
    const [selected, setSelected] = useState<
        "seeker" | "hider" | "coHider" | null
    >(null);

    // v784: warm the lazy HiderPage chunk the moment the hider tile is
    // highlighted, so confirming doesn't flash App.tsx's full-screen Suspense
    // spinner (the "whole UI reloads" feel) before /h paints. No-op if already
    // loaded; the dynamic import stays a separate chunk.
    useEffect(() => {
        if (selected === "hider" || selected === "coHider") {
            void import("@/pages/HiderPage");
        }
    }, [selected]);

    const confirmJoin = () => {
        if (!selected) return;
        if (selected === "hider" && hiderTaken) return;
        if (selected === "coHider" && !hiderTaken) return;
        commitName();
        playerRole.set(selected);
        // Server only knows seeker / hider / null — coHider is layered
        // on top of the hider role client-side.
        if (selected !== "coHider") setOnlineRole(selected);
        if (typeof window === "undefined") return;
        // v756: SOFT-navigate (SPA) — a window.location reload tore down the
        // live WS and let the reconnect snapshot clobber the wizard's
        // transit/size settings (the "lobby reloads when I pick hider" bug).
        // Falls back to a hard nav only if the router bridge isn't mounted.
        const onHiderPage = window.location.pathname.startsWith("/h");
        if (selected === "hider" || selected === "coHider") {
            if (!onHiderPage && !appNavigate("/h", { replace: true }))
                window.location.assign("/h");
        } else if (onHiderPage) {
            if (!appNavigate("/", { replace: true }))
                window.location.assign("/");
        }
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
                    // Force the picker's own content interactive even if the
                    // stacked lobby drawer / Radix layer left `body`
                    // pointer-events:none (see the release effect above) —
                    // `auto` on the content overrides the inherited `none`.
                    "pointer-events-auto",
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                    "flex flex-col p-0 gap-0",
                    // v803: ANCHOR TO THE TOP (override the default vertical
                    // centering: `top-[50%]` + `translate-y-[-50%]`) so the
                    // dialog stays put when the keyboard opens/closes — the
                    // name field is near the top and clears the keyboard.
                    // Cap the height + scroll so a short viewport never clips.
                    "top-4 translate-y-0 max-h-[calc(100dvh-2rem)] overflow-y-auto",
                )}
                overlayClassName="z-[1060]"
            >
                {/* Compact header — no logo flourish, so the whole
                    dialog stays short enough to clear the on-screen
                    keyboard. */}
                <div className="px-5 pt-4 pb-3 shrink-0 border-b border-border">
                    <DialogTitle className="font-inter-tight font-black uppercase text-lg tracking-tight leading-tight">
                        Pick your role
                    </DialogTitle>
                    <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
                        You can switch teams later in the lobby.
                    </DialogDescription>
                </div>

                {/* Display name — above the roles. Optional: blank lets
                    the server assign a Jet Lag cast name. */}
                <div className="px-5 pt-3 pb-1 space-y-1">
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

                {/* Role tiles — single column (v803). The top-anchored dialog
                    no longer has to stay short to clear the keyboard, so the
                    tiles stack for a clearer, roomier read. */}
                <div className="px-5 pt-3 pb-2 flex flex-col gap-2.5">
                    <button
                        type="button"
                        onClick={() => setSelected("seeker")}
                        aria-pressed={selected === "seeker"}
                        className={cn(
                            "flex flex-col items-start text-left gap-1.5 p-3 rounded-sm border-2",
                            "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                            "transition-all hover:-translate-y-[1px]",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            selected === "seeker"
                                ? "border-primary bg-primary/10"
                                : "border-border bg-secondary/40 hover:bg-accent",
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <span className="inline-flex items-center justify-center w-7 h-7 rounded-sm bg-secondary text-muted-foreground">
                                <Footprints size={16} strokeWidth={2.4} />
                            </span>
                            <span className="font-inter-tight font-black uppercase text-sm tracking-[0.12em]">
                                Seeker
                            </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-snug">
                            Ask questions, rule out the map, close in.
                        </p>
                    </button>

                    <button
                        type="button"
                        onClick={() => setSelected("hider")}
                        disabled={hiderTaken}
                        aria-pressed={selected === "hider"}
                        className={cn(
                            "flex flex-col items-start text-left gap-1.5 p-3 rounded-sm border-2",
                            "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                            "transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            hiderTaken
                                ? "opacity-50 cursor-not-allowed border-border/70 bg-secondary/20"
                                : selected === "hider"
                                  ? "border-primary bg-primary/10 hover:-translate-y-[1px]"
                                  : "border-border/70 bg-secondary/20 hover:bg-accent hover:-translate-y-[1px]",
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <span className="inline-flex items-center justify-center w-7 h-7 rounded-sm bg-secondary/60 text-muted-foreground/70">
                                <VenetianMask size={16} strokeWidth={2.4} />
                            </span>
                            <span className="font-inter-tight font-black uppercase text-sm tracking-[0.12em]">
                                Hider
                            </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-snug">
                            Answer questions, play the hider deck. One per
                            game.
                        </p>
                        {hiderTaken && (
                            <p className="text-[10px] font-semibold text-destructive leading-snug">
                                Taken by{" "}
                                {hiderHolder?.displayName || "another player"}
                            </p>
                        )}
                    </button>
                </div>

                {hiderTaken && (
                    <div className="px-5 pb-2">
                        <button
                            type="button"
                            onClick={() => setSelected("coHider")}
                            aria-pressed={selected === "coHider"}
                            className={cn(
                                "w-full flex items-center text-left gap-2.5 p-2.5 rounded-sm border-2",
                                "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                                "transition-all hover:-translate-y-[1px]",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                selected === "coHider"
                                    ? "border-primary bg-primary/10"
                                    : "border-border bg-secondary hover:bg-accent",
                            )}
                        >
                            <span className="inline-flex items-center justify-center w-7 h-7 rounded-sm bg-muted text-foreground shrink-0">
                                <Users size={16} strokeWidth={2.4} />
                            </span>
                            <span className="flex flex-col gap-0.5 min-w-0">
                                <span className="font-inter-tight font-black uppercase text-sm tracking-[0.12em]">
                                    Co-hider
                                </span>
                                <span className="text-[11px] text-muted-foreground leading-snug">
                                    Join{" "}
                                    {hiderHolder?.displayName || "the hider"}
                                    's hide — view-only; they answer and play
                                    the cards.
                                </span>
                            </span>
                        </button>
                    </div>
                )}

                {/* Confirm — disabled until a role is highlighted. */}
                <div className="px-5 pb-4">
                    <Button
                        onClick={confirmJoin}
                        disabled={!selected}
                        className="w-full font-display font-extrabold uppercase tracking-[0.02em]"
                    >
                        Join game
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export default RolePicker;
