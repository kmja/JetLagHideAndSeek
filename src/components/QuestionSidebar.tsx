import { useStore } from "@nanostores/react";
import { SidebarCloseIcon } from "lucide-react";

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

    return (
        <Sidebar>
            <div className="ml-4 mt-4 mr-2">
                <div className="flex items-center justify-between">
                    <h2 className="font-poppins text-xl font-semibold">
                        Questions
                    </h2>
                    <div className="flex items-center gap-3">
                        {$questions.length > 0 && (
                            <span className="text-xs text-muted-foreground font-mono">
                                <span className="text-foreground">
                                    {$questions.length}
                                </span>{" "}
                                added
                            </span>
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
