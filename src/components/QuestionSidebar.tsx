import { useStore } from "@nanostores/react";
import { SidebarCloseIcon, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { toast } from "react-toastify";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
    Sidebar,
    SidebarContent,
    SidebarContext,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { decodeAnswerFromUrl } from "@/lib/shareLinks";
import {
    autoSave,
    isLoading,
    questions,
    save,
    triggerLocalRefresh,
} from "@/lib/context";

import { AddQuestionDialog } from "./AddQuestionDialog";
import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";

export const QuestionSidebar = () => {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);
    const $autoSave = useStore(autoSave);
    const $isLoading = useStore(isLoading);

    const lastQuestion = $questions[$questions.length - 1];
    const lastCategoryMeta =
        lastQuestion && lastQuestion.id in CATEGORIES
            ? CATEGORIES[lastQuestion.id as CategoryId]
            : null;

    // On first mount, check whether the URL carries an answer from a hider.
    // Match it to a question by key, merge the answer into the question's
    // data, then clear the URL so it doesn't reapply on refresh.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const params = new URLSearchParams(window.location.search);
        const incoming = decodeAnswerFromUrl(params);
        if (!incoming) return;

        const list = questions.get();
        const matchIdx = list.findIndex((q) => q.key === incoming.key);
        if (matchIdx < 0) {
            toast.warning(
                "Got an answer, but no matching question in your list. " +
                    "Maybe it was deleted?",
                { autoClose: 4000 },
            );
        } else {
            const updated = [...list];
            updated[matchIdx] = {
                ...updated[matchIdx],
                data: {
                    ...updated[matchIdx].data,
                    ...incoming.answer,
                },
            } as (typeof updated)[number];
            questions.set(updated);
            toast.success("Hider's answer applied", { autoClose: 2000 });
        }

        // Clear the ?a= param so a refresh doesn't re-apply.
        const url = new URL(window.location.href);
        url.searchParams.delete("a");
        window.history.replaceState({}, "", url.toString());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <Sidebar>
            <div className="ml-4 mt-4 mr-2">
                <div className="flex items-center justify-between">
                    <h2 className="font-poppins text-xl font-semibold">
                        Questions
                    </h2>
                    <div className="flex items-center gap-2">
                        {$questions.length > 0 && (
                            <span className="text-xs text-muted-foreground font-mono">
                                <span className="text-foreground">
                                    {$questions.length}
                                </span>{" "}
                                added
                            </span>
                        )}
                        {$questions.length > 0 && (
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 hover:bg-destructive/10 hover:text-destructive transition-colors"
                                        title="Delete all questions"
                                        aria-label="Delete all questions"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>
                                            Delete all questions?
                                        </AlertDialogTitle>
                                        <AlertDialogDescription>
                                            This will permanently remove every
                                            question in your list. This action
                                            cannot be undone.
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>
                                            Cancel
                                        </AlertDialogCancel>
                                        <AlertDialogAction
                                            onClick={() => {
                                                questions.set([]);
                                            }}
                                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                        >
                                            Delete All
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                        )}
                        <SidebarCloseIcon
                            className="visible md:hidden cursor-pointer hover:text-muted-foreground transition-colors"
                            onClick={() => {
                                SidebarContext.get().setOpenMobile(false);
                            }}
                        />
                    </div>
                </div>
                {lastCategoryMeta && (
                    <div className="mt-1 flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">
                            Last asked:
                        </span>
                        <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-poppins font-bold uppercase tracking-wider"
                            style={{
                                backgroundColor: `${lastCategoryMeta.color}26`,
                                color: lastCategoryMeta.color,
                            }}
                        >
                            {lastCategoryMeta.label}
                        </span>
                    </div>
                )}
            </div>
            <SidebarGroup className="pb-0">
                <SidebarGroupContent>
                    <SidebarMenu data-tutorial-id="add-questions-buttons">
                        <SidebarMenuItem>
                            <AddQuestionDialog>
                                <SidebarMenuButton disabled={$isLoading}>
                                    Add Question
                                </SidebarMenuButton>
                            </AddQuestionDialog>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
            <SidebarContent>
                {[...$questions].reverse().map((question) => {
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
                        default:
                            return null;
                    }
                })}
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
        </Sidebar>
    );
};
