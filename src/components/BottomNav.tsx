import { useStore } from "@nanostores/react";
import { List, MoreHorizontal, Plus, Target } from "lucide-react";
import { useState } from "react";

import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@/components/ui/sheet";
import { SidebarContext as SidebarContextL } from "@/components/ui/sidebar-l";
import { SidebarContext as SidebarContextR } from "@/components/ui/sidebar-r";
import { questions } from "@/lib/context";
import { cn } from "@/lib/utils";

import { AddQuestionDialog } from "./AddQuestionDialog";
import { OptionDrawers } from "./OptionDrawers";

/**
 * Bottom-anchored navigation bar shown only on mobile.
 * Replaces the top-corner sidebar triggers + bottom-right OptionDrawers
 * cluster, putting frequent actions in the thumb zone.
 *
 * Desktop layout is unchanged — see index.astro for the responsive switching.
 */
export const BottomNav = () => {
    const $questions = useStore(questions);
    const [moreOpen, setMoreOpen] = useState(false);

    const navBtnClass = cn(
        "relative flex-1 flex flex-col items-center justify-center gap-0.5",
        "py-2 px-1 rounded-md min-h-[48px]",
        "text-muted-foreground hover:text-foreground hover:bg-secondary",
        "active:bg-secondary/80 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    );

    const navLabelClass = "text-[10px] font-poppins font-semibold";

    return (
        <div
            className={cn(
                "md:hidden fixed bottom-0 left-0 right-0 z-[1040]",
                "bg-background/95 backdrop-blur-md border-t border-border",
                "pb-[env(safe-area-inset-bottom)]",
            )}
            data-tutorial-id="bottom-nav"
        >
            <div className="flex items-stretch px-2 py-2 gap-1">
                {/* Questions sidebar trigger */}
                <button
                    type="button"
                    onClick={() =>
                        SidebarContextL.get().setOpenMobile(true)
                    }
                    className={navBtnClass}
                    aria-label="Open questions sidebar"
                >
                    <List className="w-5 h-5" strokeWidth={2} />
                    <span className={navLabelClass}>Questions</span>
                    {$questions.length > 0 && (
                        <span
                            className={cn(
                                "absolute top-1 right-2",
                                "text-[9px] font-mono font-semibold",
                                "bg-secondary text-foreground",
                                "px-1.5 min-w-[18px] h-[18px]",
                                "rounded-full flex items-center justify-center",
                                "border border-border",
                            )}
                            aria-label={`${$questions.length} questions added`}
                        >
                            {$questions.length}
                        </span>
                    )}
                </button>

                {/* Add Question — primary CTA, wider */}
                <AddQuestionDialog>
                    <button
                        type="button"
                        className={cn(
                            "flex-[1.4] flex flex-col items-center justify-center gap-0.5",
                            "py-2 px-1 rounded-md min-h-[48px]",
                            "bg-primary text-primary-foreground",
                            "hover:bg-primary/90 active:bg-primary/80",
                            "transition-colors font-poppins",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                        aria-label="Add question"
                    >
                        <Plus className="w-5 h-5" strokeWidth={2.5} />
                        <span className="text-[10px] font-bold uppercase tracking-wider">
                            Ask
                        </span>
                    </button>
                </AddQuestionDialog>

                {/* Zone sidebar trigger */}
                <button
                    type="button"
                    onClick={() =>
                        SidebarContextR.get().setOpenMobile(true)
                    }
                    className={navBtnClass}
                    aria-label="Open hiding zone settings"
                >
                    <Target className="w-5 h-5" strokeWidth={2} />
                    <span className={navLabelClass}>Zone</span>
                </button>

                {/* Overflow — Share / Tutorial / Options */}
                <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
                    <SheetTrigger asChild>
                        <button
                            type="button"
                            className={cn(navBtnClass, "max-w-[56px]")}
                            aria-label="More options"
                        >
                            <MoreHorizontal
                                className="w-5 h-5"
                                strokeWidth={2}
                            />
                            <span className={navLabelClass}>More</span>
                        </button>
                    </SheetTrigger>
                    <SheetContent
                        side="bottom"
                        className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
                    >
                        <SheetHeader>
                            <SheetTitle>More</SheetTitle>
                            <SheetDescription>
                                Share your map, see the tutorial, or open
                                advanced options.
                            </SheetDescription>
                        </SheetHeader>
                        <div className="mt-4 pb-2 flex justify-center">
                            <OptionDrawers />
                        </div>
                    </SheetContent>
                </Sheet>
            </div>
        </div>
    );
};
