import { useStore } from "@nanostores/react";
import { List, Map as MapIcon, Tent, Users } from "lucide-react";
import { useState } from "react";
import { Drawer as VaulDrawer } from "vaul";

import { AppSettingsDrawer } from "@/components/AppSettingsDrawer";
import { HiderHomeContent } from "@/components/HiderHome";
import { HidingCountdownBadge } from "@/components/HidingCountdownBadge";
import {
    HiderMapOptionsDrawer,
    useHiderMapOptionsActiveCount,
} from "@/components/HiderMapDisplayControls";
import { HiderQuestionLog } from "@/components/HiderQuestionLog";
import { hidingPeriodEndsAt, mapOptionsDrawerOpen } from "@/lib/gameSetup";
import { hiderInbox, hidingZone, roundFoundAt } from "@/lib/hiderRole";
import {
    lobbyManualOpen,
    participants,
} from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/**
 * True when an outside-interaction target sits inside a nested Radix modal
 * (an appConfirm AlertDialog / appPrompt Dialog) portaled ABOVE the Zone
 * drawer. Used to stop the drawer dismissing when the user cancels such a
 * dialog. The drawer content is itself `role="dialog"`, but an OUTSIDE-tap
 * target is never inside the drawer's own content, so matching `role=dialog`
 * here only catches the nested modal, never the drawer.
 */
function targetInNestedModal(target: EventTarget | null | undefined): boolean {
    return (
        target instanceof Element &&
        target.closest('[role="dialog"],[role="alertdialog"]') !== null
    );
}

/**
 * Hider-side bottom nav. Four slots, in left-to-right order (v632 —
 * brought to parity with the seeker's nav: Settings moved OUT to the
 * header, Map added, Lobby rightmost):
 *
 *   • Questions — opens a bottom drawer with the question log
 *     (HiderQuestionLog). The badge count reflects the inbox length.
 *
 *   • Zone (the hider's primary action) — opens a bottom drawer
 *     containing the full HiderHomeContent: zone picker, spot lockdown,
 *     scouting list, dice roller, hand panel, end-hiding-period button.
 *
 *   • Map — opens the `HiderMapOptionsDrawer` (basemap / reachable
 *     zones / transit overlays). Badge = active-overlay count. Replaces
 *     the old floating top-right `Layers` popover on the map.
 *
 *   • Lobby (rightmost) — opens the existing GameLobbyDialog drawer via
 *     `lobbyManualOpen`. Shows roster, room code, role rotation, and
 *     (for the host) the Edit game settings entry point.
 *
 * Settings (tutorial, rulebook, units, theme, preload) now lives in the
 * HiderTopBar's right cluster (mirrors SeekerTopBar); its
 * `AppSettingsDrawer` is still mounted here.
 *
 * All slots use Vaul drawers (bottom-sliding), matching the Lobby
 * pattern. v462: a flow row at the bottom of the hider column; the
 * shell reserves the HiderHandFan's peek-strip height as padding so
 * this nav lands directly above the (still fixed) fan.
 */
export function HiderBottomNav() {
    const $inbox = useStore(hiderInbox);
    const $participants = useStore(participants);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $hidingZone = useStore(hidingZone);
    const $foundAt = useStore(roundFoundAt);
    // Once the hiding period is over with a committed zone (seeking /
    // endgame), the drawer is for exploring your zone, not picking one — so
    // the subheader changes to match. Render-time check is enough: the
    // hiding→seeking transition is store-driven (end-early / auto-commit),
    // and the drawer re-renders when opened.
    const inZoneStage =
        $hidingZone !== null &&
        $hidingEndsAt !== null &&
        Date.now() >= $hidingEndsAt &&
        $foundAt === null;
    const [questionsOpen, setQuestionsOpen] = useState(false);
    const [zoneOpen, setZoneOpen] = useState(false);
    const mapActiveCount = useHiderMapOptionsActiveCount();

    const inboxCount = $inbox.length;
    const onlineCount = $participants.filter((p) => p.online).length;

    const navBtnClass = cn(
        "relative flex flex-1 flex-col items-center justify-center gap-0.5",
        "py-2 px-1 rounded-md min-h-[48px]",
        "bg-secondary hover:bg-accent active:bg-secondary/80",
        "border border-border",
        "transition-colors font-poppins text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    );
    const navLabelClass = "text-[10px] font-poppins font-semibold";

    return (
        <>
            <div
                className={cn(
                    // v462: flow row at the bottom of the hider column
                    // (was `fixed`, shifted up by the fan height). The
                    // column now reserves the fan's peek-strip space as
                    // padding, so the nav lands directly above the fan.
                    "shrink-0 z-[1040]",
                    "bg-background/95 backdrop-blur-md border-t border-border",
                )}
            >
                <div className="flex items-stretch px-2 py-2 gap-1">
                    <button
                        type="button"
                        onClick={() => setQuestionsOpen(true)}
                        className={navBtnClass}
                        aria-label="Open questions"
                    >
                        <List className="w-5 h-5" strokeWidth={2} />
                        <span className={navLabelClass}>Questions</span>
                        {inboxCount > 0 && (
                            <span
                                className={cn(
                                    "absolute top-1 right-2",
                                    "text-[9px] font-mono font-semibold",
                                    "bg-primary text-primary-foreground",
                                    "px-1.5 min-w-[18px] h-[18px]",
                                    "rounded-full flex items-center justify-center",
                                )}
                                aria-label={`${inboxCount} questions in inbox`}
                            >
                                {inboxCount}
                            </span>
                        )}
                    </button>

                    <button
                        type="button"
                        onClick={() => setZoneOpen(true)}
                        className={navBtnClass}
                        aria-label="Open hiding zone controls"
                    >
                        <Tent className="w-5 h-5" strokeWidth={2} />
                        <span className={navLabelClass}>Zone</span>
                    </button>

                    {/* Map — opens the roomy map-options drawer (basemap /
                        reachable zones / transit). Replaces the old floating
                        top-right popover. */}
                    <button
                        type="button"
                        onClick={() => mapOptionsDrawerOpen.set(true)}
                        className={navBtnClass}
                        aria-label="Map options"
                        title="Basemap, reachable zones, transit lines"
                    >
                        <MapIcon className="w-5 h-5" strokeWidth={2} />
                        <span className={navLabelClass}>Map</span>
                        {mapActiveCount > 0 && (
                            <span
                                className={cn(
                                    "absolute top-1 right-2",
                                    "text-[9px] font-mono font-semibold",
                                    "bg-primary text-primary-foreground",
                                    "px-1.5 min-w-[18px] h-[18px]",
                                    "rounded-full flex items-center justify-center",
                                )}
                                aria-label={`${mapActiveCount} map option(s) active`}
                            >
                                {mapActiveCount}
                            </span>
                        )}
                    </button>

                    {/* Lobby (rightmost) — roster, room code, role rotation. */}
                    <button
                        type="button"
                        onClick={() => lobbyManualOpen.set(true)}
                        className={navBtnClass}
                        aria-label="Open game lobby"
                        title="Players, room code, role rotation"
                    >
                        <Users className="w-5 h-5" strokeWidth={2} />
                        <span className={navLabelClass}>Lobby</span>
                        {onlineCount > 0 && (
                            <span
                                className={cn(
                                    "absolute top-1 right-2",
                                    "text-[9px] font-mono font-semibold",
                                    "bg-primary text-primary-foreground",
                                    "px-1.5 min-w-[18px] h-[18px]",
                                    "rounded-full flex items-center justify-center",
                                )}
                                aria-label={`${onlineCount} players online`}
                            >
                                {onlineCount}
                            </span>
                        )}
                    </button>
                </div>
            </div>

            {/* Settings drawer stays mounted here; opened from the
                HiderTopBar's Settings button (moreSheetOpen). */}
            <AppSettingsDrawer />
            <HiderMapOptionsDrawer />

            {/* Questions drawer — bottom-sliding Vaul drawer, same
                shape as the Lobby. Replaces v284's side Sheet. */}
            <VaulDrawer.Root
                open={questionsOpen}
                onOpenChange={setQuestionsOpen}
                shouldScaleBackground={false}
            >
                <VaulDrawer.Portal>
                    <VaulDrawer.Overlay className="fixed inset-0 z-[1050] bg-black/60" />
                    <VaulDrawer.Content
                        className={cn(
                            "fixed inset-x-0 bottom-0 z-[1055] mt-24",
                            "flex h-auto max-h-[90vh] flex-col",
                            "rounded-t-[10px] border",
                            "bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]",
                            "pb-[env(safe-area-inset-bottom)] sm:max-w-md sm:mx-auto",
                        )}
                    >
                        <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
                        <div className="px-5 pt-2 pb-3 shrink-0 border-b border-border space-y-1">
                            <VaulDrawer.Title className="text-lg font-semibold leading-none tracking-tight">
                                Questions
                            </VaulDrawer.Title>
                            <VaulDrawer.Description className="text-xs text-muted-foreground leading-snug">
                                Your inbox of questions from the seekers.
                            </VaulDrawer.Description>
                        </div>
                        <div className="flex-1 overflow-y-auto px-5 py-3">
                            <HiderQuestionLog />
                        </div>
                    </VaulDrawer.Content>
                </VaulDrawer.Portal>
            </VaulDrawer.Root>

            {/* Zone drawer — bottom-sliding Vaul drawer for the
                hider's phase-aware action panel (zone pick / spot
                lock / hand / dice / end-hiding-period). */}
            <VaulDrawer.Root
                open={zoneOpen}
                onOpenChange={setZoneOpen}
                shouldScaleBackground={false}
            >
                <VaulDrawer.Portal>
                    <VaulDrawer.Overlay className="fixed inset-0 z-[1050] bg-black/60" />
                    <VaulDrawer.Content
                        // v786: don't dismiss the drawer when the tap lands
                        // inside a nested Radix dialog/alertdialog (e.g. the
                        // zone-commit appConfirm) portaled ABOVE it — those
                        // portal as body siblings, so vaul reads a tap on their
                        // Cancel button as an "outside" tap and would close the
                        // whole drawer. Cancelling the confirm should leave the
                        // drawer open. (An outside tap on the map/overlay still
                        // dismisses normally — that target isn't in a modal.)
                        onPointerDownOutside={(e) => {
                            if (targetInNestedModal(e.detail?.originalEvent?.target))
                                e.preventDefault();
                        }}
                        onInteractOutside={(e) => {
                            if (targetInNestedModal(e.detail?.originalEvent?.target))
                                e.preventDefault();
                        }}
                        className={cn(
                            "fixed inset-x-0 bottom-0 z-[1055] mt-24",
                            "flex h-auto max-h-[92vh] flex-col",
                            "rounded-t-[10px] border",
                            "bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]",
                            "pb-[env(safe-area-inset-bottom)] sm:max-w-md sm:mx-auto",
                        )}
                    >
                        <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
                        <div className="flex items-start gap-3 px-5 pt-2 pb-3 shrink-0 border-b border-border">
                            <div className="min-w-0 flex-1 space-y-1">
                                <VaulDrawer.Title className="text-lg font-semibold leading-none tracking-tight flex items-center gap-2">
                                    <Tent className="w-4 h-4" />
                                    Hiding zone
                                </VaulDrawer.Title>
                                <VaulDrawer.Description className="text-xs text-muted-foreground leading-snug">
                                    {inZoneStage
                                        ? "Explore your zone and find your final hiding spot."
                                        : "Select a station to hide near."}
                                </VaulDrawer.Description>
                            </div>
                            {/* Compact golden countdown next to the header —
                                replaces the big in-drawer timer block (v786). */}
                            <HidingCountdownBadge className="mt-0.5" />
                        </div>
                        <div className="flex-1 overflow-y-auto px-2">
                            <HiderHomeContent />
                        </div>
                    </VaulDrawer.Content>
                </VaulDrawer.Portal>
            </VaulDrawer.Root>
        </>
    );
}

export default HiderBottomNav;
