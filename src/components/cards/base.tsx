import { useStore } from "@nanostores/react";
import { LockIcon, UnlockIcon } from "lucide-react";
import { useRef, useState } from "react";
import { VscChevronDown, VscShare, VscTrash } from "react-icons/vsc";

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
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarMenu,
} from "@/components/ui/sidebar-l";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { isLoading, questions } from "@/lib/context";
import { cn } from "@/lib/utils";

export const QuestionCard = ({
    children,
    questionKey,
    className,
    label,
    sub,
    category,
    collapsed,
    locked,
    setLocked,
    setCollapsed,
}: {
    children: React.ReactNode;
    questionKey: number;
    className?: string;
    label?: string;
    sub?: string;
    category?: CategoryId;
    collapsed?: boolean;
    locked?: boolean;
    setLocked?: (locked: boolean) => void;
    setCollapsed?: (collapsed: boolean) => void;
}) => {
    const [isCollapsed, setIsCollapsed] = useState(collapsed ?? false);
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);
    const copyButtonRef = useRef<HTMLButtonElement>(null);

    const categoryMeta = category ? CATEGORIES[category] : undefined;
    const CategoryIcon = categoryMeta?.icon;

    const toggleCollapse = () => {
        if (setCollapsed) {
            setCollapsed(!isCollapsed);
        }
        setIsCollapsed((prevState) => !prevState);
    };

    return (
        <>
            <SidebarGroup
                className={cn(
                    category && "border-l-[3px] border-l-[var(--cat-color)]",
                    className,
                )}
                style={
                    categoryMeta
                        ? ({
                              "--cat-color": categoryMeta.color,
                          } as React.CSSProperties)
                        : undefined
                }
            >
                <div className="relative">
                    <button
                        onClick={toggleCollapse}
                        className={cn(
                            "absolute top-2 left-2 text-white border rounded-md transition-all duration-500",
                            isCollapsed && "-rotate-90",
                        )}
                    >
                        <VscChevronDown />
                    </button>
                    <SidebarGroupLabel
                        className="ml-8 mr-8 cursor-pointer flex items-center gap-2"
                        onClick={toggleCollapse}
                    >
                        {CategoryIcon && (
                            <span
                                className="inline-flex items-center justify-center w-5 h-5 rounded shrink-0"
                                style={{
                                    backgroundColor: categoryMeta!.color,
                                }}
                                aria-hidden="true"
                            >
                                <CategoryIcon
                                    size={13}
                                    strokeWidth={2.5}
                                    className="text-white"
                                />
                            </span>
                        )}
                        <span>
                            {label} {sub && `(${sub})`}
                        </span>
                    </SidebarGroupLabel>
                    <SidebarGroupContent
                        className={cn(
                            "overflow-hidden transition-all duration-1000 max-h-[100rem]", // 100rem is arbitrary
                            isCollapsed && "max-h-0",
                        )}
                    >
                        <SidebarMenu>{children}</SidebarMenu>
                        <div className="flex gap-2 pt-2 px-2 justify-center">
                            <Dialog>
                                <DialogTrigger asChild>
                                    <Button variant="outline" size="sm">
                                        <VscShare />
                                    </Button>
                                </DialogTrigger>
                                <DialogContent>
                                    <DialogHeader>
                                        <DialogTitle className="text-2xl">
                                            Share this Question!
                                        </DialogTitle>
                                        <DialogDescription>
                                            Below you can access the JSON
                                            representing the question. Send this
                                            to another player for them to copy.
                                            They can then click &ldquo;Paste
                                            Question&rdquo; at the bottom of the
                                            &ldquo;Questions&rdquo; sidebar.
                                        </DialogDescription>
                                    </DialogHeader>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="mb-2 sm:mb-0 transition-colors"
                                        ref={copyButtonRef}
                                        onClick={() => {
                                            navigator.clipboard
                                                .writeText(
                                                    JSON.stringify(
                                                        $questions.find(
                                                            (q) =>
                                                                q.key ===
                                                                questionKey,
                                                        ),
                                                        null,
                                                        4,
                                                    ),
                                                )
                                                .then(() => {
                                                    if (copyButtonRef.current) {
                                                        copyButtonRef.current.textContent =
                                                            "Copied!";
                                                        copyButtonRef.current.classList.add(
                                                            "bg-green-500",
                                                        );
                                                        setTimeout(() => {
                                                            if (
                                                                copyButtonRef.current
                                                            ) {
                                                                copyButtonRef.current.textContent =
                                                                    "Copy to Clipboard";
                                                                copyButtonRef.current.classList.remove(
                                                                    "bg-green-500",
                                                                );
                                                            }
                                                        }, 2000);
                                                    }
                                                })
                                                .catch(() => {
                                                    if (copyButtonRef.current) {
                                                        copyButtonRef.current.textContent =
                                                            "Failed to Copy";
                                                        copyButtonRef.current.classList.add(
                                                            "bg-red-500",
                                                        );
                                                        setTimeout(() => {
                                                            if (
                                                                copyButtonRef.current
                                                            ) {
                                                                copyButtonRef.current.textContent =
                                                                    "Copy to Clipboard";
                                                                copyButtonRef.current.classList.remove(
                                                                    "bg-red-500",
                                                                );
                                                            }
                                                        }, 2000);
                                                    }
                                                });
                                        }}
                                    >
                                        Copy to Clipboard
                                    </Button>
                                    <textarea
                                        className="w-full h-[300px] bg-slate-900 text-white rounded-md p-2"
                                        readOnly
                                        value={JSON.stringify(
                                            $questions.find(
                                                (q) => q.key === questionKey,
                                            ),
                                            null,
                                            4,
                                        )}
                                    ></textarea>
                                </DialogContent>
                            </Dialog>
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={$isLoading}
                                    >
                                        <VscTrash />
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>
                                            Are you absolutely sure?
                                        </AlertDialogTitle>
                                        <AlertDialogDescription>
                                            This action cannot be undone. This
                                            will permanently delete the
                                            question.
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
                                        >
                                            Delete All Questions
                                        </AlertDialogAction>
                                        <AlertDialogAction
                                            onClick={() => {
                                                questions.set(
                                                    $questions.filter(
                                                        (q) =>
                                                            q.key !==
                                                            questionKey,
                                                    ),
                                                );
                                            }}
                                            className="mb-2 sm:mb-0"
                                        >
                                            Delete Question
                                        </AlertDialogAction>
                                    </AlertDialogFooter>
                                </AlertDialogContent>
                            </AlertDialog>
                            {locked !== undefined && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setLocked!(!locked)}
                                    disabled={$isLoading}
                                >
                                    {locked ? <LockIcon /> : <UnlockIcon />}
                                </Button>
                            )}
                        </div>
                    </SidebarGroupContent>
                </div>
            </SidebarGroup>
            <Separator className="h-1" />
        </>
    );
};
