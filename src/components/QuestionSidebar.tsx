import { useStore } from "@nanostores/react";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Drawer as VaulDrawer } from "vaul";

import { Button } from "@/components/ui/button";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { useIsMobile } from "@/hooks/use-mobile";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import {
    addQuestionSignal,
    autoSave,
    isLoading,
    questions,
    questionsDrawerOpen,
    save,
    triggerLocalRefresh,
} from "@/lib/context";
import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

import { AddQuestionDialog } from "./AddQuestionDialog";
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

    // Also disable while the hider's hiding period is running —
    // mirrors the bottom-nav New Question button so the sidebar can't
    // be used as an end-run around the rule. 1 Hz ticker drives the
    // flip the moment the timer hits zero (paused while tab hidden).
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const [now, setNow] = useState(() => Date.now());
    const hidingRunning =
        $hidingEndsAt !== null && $hidingEndsAt > now;
    useVisibleInterval(() => setNow(Date.now()), 1000, hidingRunning);

    // Mobile hosts the Questions list in a vaul drawer; the New button there
    // must NOT nest its own vaul drawer (v873) — see `newQuestionButton`.
    const mobile = useIsMobile();

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

    // Standard primary button (sentence case, normal size) — the single
    // New-question CTA. Shown in the header WHEN there are questions; when
    // the list is empty it moves INTO the empty state as the lone CTA.
    // (Don't block on `$isLoading`: that flag also goes high for ambient
    // station-finder fetches which can take many seconds. Only the
    // in-flight answer rule and the hiding-period gate warrant blocking.)
    const newButtonInner = (label: string) => (
        <Button
            type="button"
            data-tutorial-id="add-questions-buttons"
            disabled={hidingRunning || hasPendingAnswer}
            title={
                hidingRunning
                    ? "Hiding period — wait for the timer or end it manually to start asking"
                    : hasPendingAnswer
                      ? "Waiting for the hider to answer your previous question"
                      : undefined
            }
            // Mobile: this button lives INSIDE the Questions vaul drawer, so it
            // can't host its own vaul drawer (nesting orphaned the first
            // question → "not sent", v873). Close the drawer and delegate to
            // the always-mounted BottomNav AddQuestionDialog via the signal.
            // Desktop: the sidebar isn't a drawer, so the AddQuestionDialog
            // wrapper below opens it directly.
            onClick={
                mobile
                    ? () => {
                          if (hidingRunning || hasPendingAnswer) return;
                          questionsDrawerOpen.set(false);
                          addQuestionSignal.set(addQuestionSignal.get() + 1);
                      }
                    : undefined
            }
        >
            <Plus strokeWidth={2.5} />
            {label}
        </Button>
    );
    const newQuestionButton = (label: string) =>
        mobile ? (
            newButtonInner(label)
        ) : (
            <AddQuestionDialog>{newButtonInner(label)}</AddQuestionDialog>
        );

    const innerContent = (
        <>
            {/* Header matches the settings drawer's: a small
                `text-lg font-semibold` title + a muted description, on the
                same `px-6` inset. The New-question CTA sits to the right of
                the title — but ONLY when there are questions; in the empty
                state it lives inside the empty box instead. */}
            <div className="px-6 pt-4">
                <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1.5">
                        <h2 className="text-lg font-semibold leading-none tracking-tight">
                            Questions
                        </h2>
                        <p className="text-sm text-muted-foreground">
                            Everything you&apos;ve asked and how the hider
                            answered.
                        </p>
                    </div>
                    {questionsNewestFirst.length > 0 &&
                        !hidingRunning &&
                        newQuestionButton("New")}
                </div>
            </div>
            {/* Hiding-period notice: questions are locked until the hider's
                timer runs out (rulebook — seekers can't ask during hiding). */}
            {hidingRunning && (
                <div className="px-6 pt-3">
                    <div className="rounded-md border-2 border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-snug text-foreground">
                        <span className="font-poppins font-bold uppercase tracking-[0.12em] text-[11px] text-warning">
                            Hiding period
                        </span>
                        <p className="mt-1 text-muted-foreground">
                            You can&apos;t ask questions yet — the hider is on
                            their way to a hiding spot. Asking unlocks the
                            moment their timer runs out (or they end it early).
                        </p>
                    </div>
                </div>
            )}
            {/* The cards own no margin; the list insets them (px-6, matching
                the header) so their left edge lines up, and spaces them
                (gap-5) with a clear gap below the header (pt-4). */}
            <SidebarContent className="px-6 pt-4 gap-5 pb-2">
                {questionsNewestFirst.length === 0 ? (
                    // Empty state — separates "no questions yet"
                    // from "list failed to load" or "list still
                    // mounting". Mirrors the bottom-nav's primary
                    // CTA label so the next step is obvious.
                    <SidebarGroup>
                        <SidebarGroupContent>
                            <div
                                className={cn(
                                    "rounded-md border-2 border-dashed border-border",
                                    "px-4 py-8 flex flex-col items-center text-center gap-4",
                                )}
                            >
                                <div className="space-y-1.5">
                                    <div className="text-[10px] uppercase tracking-[0.08em] font-display font-extrabold text-muted-foreground">
                                        {hidingRunning
                                            ? "Waiting on the hider"
                                            : "No questions yet"}
                                    </div>
                                    <p className="text-xs text-muted-foreground leading-snug max-w-[24ch]">
                                        {hidingRunning
                                            ? "Questions unlock when the hiding period ends. Sit tight."
                                            : "Ask your first question to start narrowing down where the hider is."}
                                    </p>
                                </div>
                                {!hidingRunning &&
                                    newQuestionButton("Ask first question")}
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

    // Mobile: dedicated drawer controlled by our own atom. The upstream
    // Sidebar's own mobile branch uses an internal atom that doesn't cross
    // Astro island boundaries — see questionsDrawerOpen in src/lib/context.ts.
    if (mobile) {
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
                        <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
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
