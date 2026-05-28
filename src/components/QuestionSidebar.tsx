import { useStore } from "@nanostores/react";
import { Plus } from "lucide-react";
import { Drawer as VaulDrawer } from "vaul";

import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import {
    autoSave,
    isLoading,
    questions,
    questionsDrawerOpen,
    save,
    triggerLocalRefresh,
} from "@/lib/context";

import { AddQuestionDialog } from "./AddQuestionDialog";
import { HideSeekMark } from "./JetLagLogo";
import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    PhotoQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";

export const QuestionSidebar = () => {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);
    const $autoSave = useStore(autoSave);
    const $isLoading = useStore(isLoading);
    const $mobileOpen = useStore(questionsDrawerOpen);

    // Newest-first display order. The store keeps questions in insertion
    // order so we don't mutate it — just iterate in reverse for the UI.
    const questionsNewestFirst = [...$questions].reverse();
    // Rulebook p13: one question at a time. Block the in-drawer NEW
    // QUESTION button as well while any draft (drag:true) is outstanding.
    const hasPendingAnswer = $questions.some((q) => q.data.drag === true);

    const renderQuestion = (question: (typeof $questions)[number]) => {
        switch (question.id) {
            case "radius":
                return (
                    <RadiusQuestionComponent
                        data={question.data}
                        key={question.key}
                        questionKey={question.key}
                    />
                );
            case "thermometer":
                return (
                    <ThermometerQuestionComponent
                        data={question.data}
                        key={question.key}
                        questionKey={question.key}
                    />
                );
            case "tentacles":
                return (
                    <TentacleQuestionComponent
                        data={question.data}
                        key={question.key}
                        questionKey={question.key}
                    />
                );
            case "matching":
                return (
                    <MatchingQuestionComponent
                        data={question.data}
                        key={question.key}
                        questionKey={question.key}
                    />
                );
            case "measuring":
                return (
                    <MeasuringQuestionComponent
                        data={question.data}
                        key={question.key}
                        questionKey={question.key}
                    />
                );
            case "photo":
                return (
                    <PhotoQuestionComponent
                        data={question.data}
                        key={question.key}
                        questionKey={question.key}
                    />
                );
            default:
                return null;
        }
    };

    const innerContent = (
        <>
            <h2 className="ml-4 mt-4 font-poppins text-2xl">Questions</h2>
            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu data-tutorial-id="add-questions-buttons">
                            <SidebarMenuItem>
                                <AddQuestionDialog>
                                    <button
                                        type="button"
                                        // Don't block on `$isLoading`: that
                                        // flag also goes high for ambient
                                        // station-finder fetches (rulebook
                                        // place data), which can take many
                                        // seconds. The seeker should still
                                        // be able to add a question during
                                        // those — only the in-flight
                                        // answer rule (`hasPendingAnswer`)
                                        // actually warrants blocking.
                                        disabled={hasPendingAnswer}
                                        title={
                                            hasPendingAnswer
                                                ? "Waiting for the hider to answer your previous question"
                                                : undefined
                                        }
                                        className={cn(
                                            "w-full flex items-center justify-center gap-2",
                                            "py-3 px-4 rounded-md",
                                            "bg-primary text-primary-foreground",
                                            "hover:bg-primary/90 active:bg-primary/80",
                                            "font-poppins font-bold uppercase tracking-wider text-xs",
                                            "transition-colors",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            "disabled:opacity-50 disabled:cursor-not-allowed",
                                        )}
                                    >
                                        <Plus
                                            className="w-4 h-4"
                                            strokeWidth={2.5}
                                        />
                                        New question
                                    </button>
                                </AddQuestionDialog>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
                {questionsNewestFirst.length === 0 ? (
                    // Empty state — separates "no questions yet"
                    // from "list failed to load" or "list still
                    // mounting". Mirrors the bottom-nav's primary
                    // CTA label so the next step is obvious.
                    <SidebarGroup>
                        <SidebarGroupContent>
                            <div
                                className={cn(
                                    "mx-2 my-2 rounded-md border-2 border-dashed border-border",
                                    "px-4 py-8 flex flex-col items-center text-center gap-3",
                                )}
                            >
                                <div className="opacity-60">
                                    <HideSeekMark size={56} onDark />
                                </div>
                                <div className="text-[10px] uppercase tracking-[0.08em] font-display font-extrabold text-muted-foreground">
                                    No questions yet
                                </div>
                                <p className="text-xs text-muted-foreground leading-snug max-w-[22ch]">
                                    Tap <span className="font-semibold text-foreground">NEW QUESTION</span> in
                                    the bottom nav to ask your first one.
                                </p>
                            </div>
                        </SidebarGroupContent>
                    </SidebarGroup>
                ) : (
                    questionsNewestFirst.map(renderQuestion)
                )}
            </SidebarContent>
            {!$autoSave && (
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    className="bg-blue-600 p-2 rounded-md font-semibold font-poppins transition-shadow duration-500"
                                    onClick={save}
                                    disabled={$isLoading}
                                >
                                    Save
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            )}
        </>
    );

    const isMobile = useIsMobile();

    // Mobile: dedicated drawer controlled by our own atom. The upstream
    // Sidebar's own mobile branch uses an internal atom that doesn't cross
    // Astro island boundaries — see questionsDrawerOpen in src/lib/context.ts.
    if (isMobile) {
        return (
            <VaulDrawer.Root
                open={$mobileOpen}
                onOpenChange={(o) => questionsDrawerOpen.set(o)}
                shouldScaleBackground={false}
            >
                <VaulDrawer.Portal>
                    <VaulDrawer.Overlay className="fixed inset-0 z-[1040] bg-black/60" />
                    <VaulDrawer.Content className="fixed inset-x-0 bottom-0 z-[1045] mt-24 flex h-auto max-h-[80vh] flex-col rounded-t-[10px] border bg-sidebar text-sidebar-foreground">
                        <VaulDrawer.Title className="sr-only">
                            Questions
                        </VaulDrawer.Title>
                        <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted" />
                        <div className="flex flex-col w-full overflow-y-auto">
                            {innerContent}
                        </div>
                    </VaulDrawer.Content>
                </VaulDrawer.Portal>
            </VaulDrawer.Root>
        );
    }

    // Desktop: existing collapsible sidebar (toggled by SidebarTriggerL in
    // the top-left).
    return <Sidebar>{innerContent}</Sidebar>;
};
