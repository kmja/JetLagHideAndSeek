import { useStore } from "@nanostores/react";
import { Inbox, List, Settings } from "lucide-react";
import { useState } from "react";

import { HiderHomeContent } from "@/components/HiderHome";
import { HiderQuestionLog } from "@/components/HiderQuestionLog";
import { ScoutedSpotsPanel } from "@/components/ScoutedSpotsPanel";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { hiderInbox } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

/**
 * Hider-side bottom nav. Two tabs:
 *
 *   • Questions — opens a side sheet with the question log
 *     (HiderQuestionLog) plus the scouted-spots manager. The badge
 *     count reflects the inbox length.
 *
 *   • Settings — opens a bottom sheet containing the full HiderHome
 *     phase content. This is where the hider commits a zone, locks
 *     a spot, ends the hiding period early, rolls dice, manages the
 *     hand, etc. The sheet is full-height so the existing scrolling
 *     layout works inside it.
 *
 * Mirrors BottomNav's structural shape (icon + label, sticky
 * bottom, safe-area aware) but with hider-flavored content. Sits
 * *above* the HiderHandFan — both are fixed, the nav at
 * `bottom-[150px]` so the hand-strip stays visible at the very
 * bottom.
 */
export function HiderBottomNav() {
    const $inbox = useStore(hiderInbox);
    const [questionsOpen, setQuestionsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);

    const inboxCount = $inbox.length;

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
                    "fixed inset-x-0 z-[1040]",
                    "bottom-[150px]",
                    "bg-background/95 backdrop-blur-md border-t border-b border-border",
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
                        onClick={() => setSettingsOpen(true)}
                        className={navBtnClass}
                        aria-label="Open hider controls and settings"
                    >
                        <Settings className="w-5 h-5" strokeWidth={2} />
                        <span className={navLabelClass}>Settings</span>
                    </button>
                </div>
            </div>

            <Sheet open={questionsOpen} onOpenChange={setQuestionsOpen}>
                <SheetContent side="right" className="w-full sm:max-w-md">
                    <SheetHeader>
                        <SheetTitle className="flex items-center gap-2">
                            <Inbox className="w-4 h-4" />
                            Questions
                        </SheetTitle>
                        <SheetDescription>
                            Your inbox and any spots you&apos;ve scouted.
                        </SheetDescription>
                    </SheetHeader>
                    <div className="mt-4 space-y-6 overflow-y-auto max-h-[calc(100dvh-7rem)] pb-6">
                        <HiderQuestionLog />
                        <ScoutedSpotsPanel />
                    </div>
                </SheetContent>
            </Sheet>

            <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
                <SheetContent
                    side="bottom"
                    className="h-[92vh] rounded-t-2xl flex flex-col"
                >
                    <SheetHeader>
                        <SheetTitle className="flex items-center gap-2">
                            <Settings className="w-4 h-4" />
                            Hider controls
                        </SheetTitle>
                        <SheetDescription>
                            Zone, spot, hand, dice — everything the hider
                            does in this round.
                        </SheetDescription>
                    </SheetHeader>
                    <div className="mt-3 flex-1 overflow-y-auto -mx-6 px-2">
                        <HiderHomeContent />
                    </div>
                </SheetContent>
            </Sheet>
        </>
    );
}

export default HiderBottomNav;
