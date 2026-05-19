import { useStore } from "@nanostores/react";
import { Plus, SidebarCloseIcon } from "lucide-react";

import { cn } from "@/lib/utils";

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

    return (
        <Sidebar>
            <div className="flex items-center justify-between">
                <h2 className="ml-4 mt-4 font-poppins text-2xl">Questions</h2>
                <SidebarCloseIcon
                    className="mr-2 visible md:hidden"
                    onClick={() => {
                        SidebarContext.get().setOpenMobile(false);
                    }}
                />
            </div>
            <SidebarContent>
                {$questions.map((question) => {
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
            <SidebarGroup>
                <SidebarGroupContent>
                    <SidebarMenu data-tutorial-id="add-questions-buttons">
                        <SidebarMenuItem>
                            <AddQuestionDialog>
                                <button
                                    type="button"
                                    disabled={$isLoading}
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
                        <SidebarMenuItem>
                            <a
                                href="https://github.com/taibeled/JetLagHideAndSeek"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <SidebarMenuButton className="bg-emerald-600 transition-colors">
                                    Star this on GitHub! It&apos;s free :)
                                </SidebarMenuButton>
                            </a>
                        </SidebarMenuItem>
                        {!$autoSave && (
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    className="bg-blue-600 p-2 rounded-md font-semibold font-poppins transition-shadow duration-500"
                                    onClick={save}
                                    disabled={$isLoading}
                                >
                                    Save
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        )}
                    </SidebarMenu>
                </SidebarGroupContent>
            </SidebarGroup>
        </Sidebar>
    );
};
