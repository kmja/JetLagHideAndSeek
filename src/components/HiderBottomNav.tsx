import { useStore } from "@nanostores/react";
import { Inbox, List, Settings, Tent, Users } from "lucide-react";
import { useState } from "react";
import { Drawer as VaulDrawer } from "vaul";

import { AppSettingsDrawer } from "@/components/AppSettingsDrawer";
import { HiderHomeContent } from "@/components/HiderHome";
import { HiderQuestionLog } from "@/components/HiderQuestionLog";
import { moreSheetOpen } from "@/lib/gameSetup";
import { hiderInbox } from "@/lib/hiderRole";
import {
    lobbyManualOpen,
    participants,
} from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/**
 * Hider-side bottom nav. Four slots, in left-to-right order:
 *
 *   • Questions — opens a bottom drawer with the question log
 *     (HiderQuestionLog). The badge count reflects the inbox length.
 *
 *   • Zone (middle, the hider's primary action) — opens a bottom
 *     drawer containing the full HiderHomeContent: zone picker,
 *     spot lockdown, scouting list, dice roller, hand panel,
 *     end-hiding-period button. Renamed from "Settings" in v285
 *     since the panel is the hiding-zone configurator, not app
 *     settings.
 *
 *   • Lobby — opens the existing GameLobbyDialog drawer via
 *     `lobbyManualOpen`. Shows roster, room code, role rotation,
 *     and (for the host) the Edit game settings entry point.
 *
 *   • Settings (v287) — shares the seeker's AppSettingsDrawer
 *     (tutorial, rulebook, units, theme, mid-game preload
 *     preferences). Drawer is mounted at the bottom of this file.
 *
 * All slots use Vaul drawers (bottom-sliding), matching the Lobby
 * pattern. v462: a flow row at the bottom of the hider column; the
 * shell reserves the HiderHandFan's peek-strip height as padding so
 * this nav lands directly above the (still fixed) fan.
 */
export function HiderBottomNav() {
    const $inbox = useStore(hiderInbox);
    const $participants = useStore(participants);
    const [questionsOpen, setQuestionsOpen] = useState(false);
    const [zoneOpen, setZoneOpen] = useState(false);

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

                    {/* Settings — shares the seeker's drawer (tutorial,
                        rulebook, units, theme, preload preferences). */}
                    <button
                        type="button"
                        onClick={() => moreSheetOpen.set(true)}
                        className={navBtnClass}
                        aria-label="Settings"
                        title="Settings — tutorial, rulebook, units, theme, preload"
                    >
                        <Settings className="w-5 h-5" strokeWidth={2} />
                        <span className={navLabelClass}>Settings</span>
                    </button>
                </div>
            </div>

            <AppSettingsDrawer />

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
                        <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted" />
                        <div className="px-5 pt-2 pb-3 shrink-0 border-b border-border space-y-1">
                            <VaulDrawer.Title className="text-lg font-semibold leading-none tracking-tight flex items-center gap-2">
                                <Inbox className="w-4 h-4" />
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
                        className={cn(
                            "fixed inset-x-0 bottom-0 z-[1055] mt-24",
                            "flex h-auto max-h-[92vh] flex-col",
                            "rounded-t-[10px] border",
                            "bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]",
                            "pb-[env(safe-area-inset-bottom)] sm:max-w-md sm:mx-auto",
                        )}
                    >
                        <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted" />
                        <div className="px-5 pt-2 pb-3 shrink-0 border-b border-border space-y-1">
                            <VaulDrawer.Title className="text-lg font-semibold leading-none tracking-tight flex items-center gap-2">
                                <Tent className="w-4 h-4" />
                                Hiding zone
                            </VaulDrawer.Title>
                            <VaulDrawer.Description className="text-xs text-muted-foreground leading-snug">
                                Zone, spot, hand, dice — everything the
                                hider does in this round.
                            </VaulDrawer.Description>
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
