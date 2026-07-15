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
import { setOnlineName, setOnlineRole } from "@/lib/multiplayer/store";
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

    // v829: the hide team is a unit of equal hiders — any number may pick
    // Hider (no more exclusive "main hider" slot / `role_taken` lockout /
    // separate co-hider option).

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

    // Persist the typed name AND push it to the server right before the
    // role click navigates away (v836). Empty string OK — the server picks a
    // cast name when it sees `""`. Using `setOnlineName` (not just the local
    // atom) is load-bearing: the lobby auto-hosts the room BEFORE this picker
    // appears, so the server already assigned a cast name from the (then
    // empty) display-name atom. Without a `setName` push, the name typed here
    // stays local-only and teammates keep seeing the cast name — the reported
    // "my name sometimes doesn't register (esp. the first game)" bug. The
    // transport queues the message and flushes it on connect, so it lands
    // even if the socket isn't open yet.
    const commitName = () => {
        setOnlineName(draftName);
    };

    // v452: select-then-confirm. Tapping a tile only HIGHLIGHTS it (like
    // the transit-mode chips); the "Join game" button below commits.
    const [selected, setSelected] = useState<"seeker" | "hider" | null>(
        null,
    );

    // v784: warm the lazy HiderPage chunk the moment the hider tile is
    // highlighted, so confirming doesn't flash App.tsx's full-screen Suspense
    // spinner (the "whole UI reloads" feel) before /h paints. No-op if already
    // loaded; the dynamic import stays a separate chunk.
    useEffect(() => {
        if (selected === "hider") {
            void import("@/pages/HiderPage");
        }
    }, [selected]);

    const confirmJoin = () => {
        if (!selected) return;
        commitName();
        playerRole.set(selected);
        setOnlineRole(selected);
        if (typeof window === "undefined") return;
        // v756: SOFT-navigate (SPA) — a window.location reload tore down the
        // live WS and let the reconnect snapshot clobber the wizard's
        // transit/size settings (the "lobby reloads when I pick hider" bug).
        // Falls back to a hard nav only if the router bridge isn't mounted.
        const onHiderPage = window.location.pathname.startsWith("/h");
        if (selected === "hider") {
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
                // v815: DON'T auto-focus the name input on open. Radix
                // Dialog grabs focus onto the first focusable (the input)
                // when it mounts, which pops the keyboard AND — layered over
                // the lobby drawer — can start a focus tug-of-war that pegs
                // the main thread (the "role picker freezes, keyboard opens
                // but the field won't type" bug). Letting the user tap the
                // field to focus it when ready avoids the mount-time grab
                // entirely; the non-modal lobby then lets the focus hold.
                onOpenAutoFocus={(e) => e.preventDefault()}
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
                        aria-pressed={selected === "hider"}
                        className={cn(
                            "flex flex-col items-start text-left gap-1.5 p-3 rounded-sm border-2",
                            "shadow-[0_2px_0_rgba(0,0,0,0.25)]",
                            "transition-all hover:-translate-y-[1px]",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            selected === "hider"
                                ? "border-primary bg-primary/10"
                                : "border-border/70 bg-secondary/20 hover:bg-accent",
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
                            Answer questions and play cards to slow the seekers
                            down.
                        </p>
                    </button>
                </div>

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
