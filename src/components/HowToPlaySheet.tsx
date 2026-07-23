import { BookOpen } from "lucide-react";
import { useState } from "react";
import { Drawer as VaulDrawer } from "vaul";

import { CATEGORIES } from "@/lib/categories";
import { cn } from "@/lib/utils";

import { SectionPill, SizeBadge } from "./JetLagLogo";

/**
 * Quick in-app rules reference. Surfaces the rulebook's most important
 * gameplay shape so a player can spot-check during a game without
 * digging through the 247-page PDF. NOT a substitute for reading the
 * rulebook — just the cheat-sheet view of the parts the app touches.
 *
 * Triggered from the Settings drawer's first row. Renders as a VaulDrawer
 * so it inherits the swipe-to-dismiss behavior we use elsewhere.
 *
 * v1138: this component is mounted INSIDE the Settings drawer's content, so
 * it must NOT close the host — doing so unmounts the Settings content, which
 * unmounts THIS component (a child) and destroys its `open` state a moment
 * after it opens (the reported "How to play closes as soon as it opens", the
 * same close-then-open-child-unmount class we've hit before). Instead it opens
 * ON TOP of the Settings drawer with a higher z-index; its own full-screen
 * overlay covers the Settings drawer, so there's no show-through, and closing
 * it returns to Settings.
 */
export function HowToPlaySheet() {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn(
                    "w-full flex items-center justify-center gap-2",
                    "px-3 py-2 rounded-md",
                    "bg-secondary hover:bg-accent border border-border",
                    "text-sm font-semibold text-foreground transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
            >
                <BookOpen className="w-4 h-4" />
                How to play
            </button>
            <VaulDrawer.Root
                open={open}
                onOpenChange={setOpen}
                shouldScaleBackground={false}
            >
            <VaulDrawer.Portal>
                <VaulDrawer.Overlay className="fixed inset-0 z-[1052] bg-black/60" />
                <VaulDrawer.Content
                    className={cn(
                        "fixed inset-x-0 bottom-0 z-[1053]",
                        "mt-24 flex h-auto max-h-[85vh] flex-col",
                        "rounded-t-[10px] border bg-background text-foreground",
                        "pb-[env(safe-area-inset-bottom)]",
                    )}
                >
                    <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
                    <div className="overflow-y-auto px-6 pt-4 pb-6 space-y-5">
                        <header>
                            <SectionPill>Rulebook cheat-sheet</SectionPill>
                            <VaulDrawer.Title className="mt-2 font-inter-tight font-black uppercase text-2xl tracking-tight leading-tight">
                                How to play
                            </VaulDrawer.Title>
                            <VaulDrawer.Description className="text-sm text-muted-foreground mt-1">
                                The rules this app cares about, condensed.
                                Read the full rulebook for everything else.
                            </VaulDrawer.Description>
                        </header>

                        <section className="space-y-2">
                            <SectionPill>Overview</SectionPill>
                            <ol className="list-decimal pl-5 space-y-1 text-sm">
                                <li>
                                    One player uses public transit to get
                                    to a hiding spot.
                                </li>
                                <li>
                                    The other players seek by asking
                                    questions from the six categories.
                                </li>
                                <li>
                                    Each answer rewards the hider with cards
                                    from the hider deck.
                                </li>
                                <li>
                                    Once found, another player hides.
                                </li>
                                <li>
                                    Whoever hid the longest wins.
                                </li>
                            </ol>
                        </section>

                        <section className="space-y-2">
                            <SectionPill>Game sizes</SectionPill>
                            <ul className="space-y-2 text-sm">
                                <li className="flex items-start gap-3">
                                    <SizeBadge size="small" />
                                    <span>
                                        Single town / small city. Hiding
                                        period <strong>30 min</strong>,
                                        hiding zone <strong>500 m</strong>.
                                        Game lasts 4–8 hours.
                                    </span>
                                </li>
                                <li className="flex items-start gap-3">
                                    <SizeBadge size="medium" />
                                    <span>
                                        Major city / metro. Hiding period{" "}
                                        <strong>60 min</strong>, hiding zone{" "}
                                        <strong>500 m</strong>. Game lasts
                                        about a day.
                                    </span>
                                </li>
                                <li className="flex items-start gap-3">
                                    <SizeBadge size="large" />
                                    <span>
                                        Region / country. Hiding period{" "}
                                        <strong>180 min</strong>, hiding zone{" "}
                                        <strong>1 km</strong>. Game lasts
                                        2–4 days.
                                    </span>
                                </li>
                            </ul>
                        </section>

                        <section className="space-y-2">
                            <SectionPill>Question categories</SectionPill>
                            <p className="text-xs text-muted-foreground">
                                Cost = how many cards the hider draws and
                                keeps after answering.
                            </p>
                            <ul className="text-sm divide-y divide-border rounded-md border border-border overflow-hidden">
                                <CatRow
                                    color={CATEGORIES.matching.color}
                                    label="Matching"
                                    template="Is your nearest ___ the same as mine?"
                                    cost="draw 3, keep 1"
                                />
                                <CatRow
                                    color={CATEGORIES.measuring.color}
                                    label="Measuring"
                                    template="Closer or further to ___ than me?"
                                    cost="draw 3, keep 1"
                                />
                                <CatRow
                                    color={CATEGORIES.radius.color}
                                    label="Radar"
                                    template="Are you within ___ of me?"
                                    cost="draw 2, keep 1"
                                />
                                <CatRow
                                    color={CATEGORIES.thermometer.color}
                                    label="Thermometer"
                                    template="After traveling ___, am I hotter or colder?"
                                    cost="draw 2, keep 1"
                                />
                                <CatRow
                                    color={CATEGORIES.photo.color}
                                    label="Photo"
                                    template="Send me a photo of ___."
                                    cost="draw 1, keep 1"
                                />
                                <CatRow
                                    color={CATEGORIES.tentacles.color}
                                    label="Tentacles"
                                    template="Within ___ km of me, which ___ are you nearest to?"
                                    cost="draw 4, keep 2"
                                    note="Not in Small games"
                                />
                            </ul>
                        </section>

                        <section className="space-y-2">
                            <SectionPill>House rules</SectionPill>
                            <ul className="text-sm space-y-1.5 list-disc pl-5">
                                <li>
                                    <strong>No Google Street View.</strong>{" "}
                                    The only research tool that's banned.
                                </li>
                                <li>
                                    <strong>One question at a time.</strong>{" "}
                                    Wait for the hider's answer before
                                    asking the next.
                                </li>
                                <li>
                                    <strong>Answer within 5 min</strong> (10
                                    min for photo questions, 20 min in Large
                                    games). Past the window the hider's
                                    clock pauses and they get no card.
                                </li>
                                <li>
                                    <strong>Repeat questions cost 2×</strong>{" "}
                                    (then 3×, 4×). Same question can always
                                    be re-asked.
                                </li>
                            </ul>
                        </section>

                        <section className="space-y-2">
                            <SectionPill>End game</SectionPill>
                            <p className="text-sm">
                                Once seekers enter the hider's hiding zone{" "}
                                <em>and</em> are off transit, the end game
                                begins. The hider must stop in one publicly
                                accessible hiding spot. The hider is found
                                when seekers are within{" "}
                                <strong>2 meters</strong> and have spotted
                                them.
                            </p>
                        </section>

                        <p className="text-xs text-muted-foreground italic">
                            Page references throughout the app cite the
                            metric-edition rulebook © Wendover Productions
                            LLC.
                        </p>
                    </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
            </VaulDrawer.Root>
        </>
    );
}

function CatRow({
    color,
    label,
    template,
    cost,
    note,
}: {
    color: string;
    label: string;
    template: string;
    cost: string;
    note?: string;
}) {
    return (
        <li className="flex items-start gap-2 p-2 bg-secondary/30">
            <span
                aria-hidden
                className="mt-1 w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ background: color }}
            />
            <div className="min-w-0 flex-1">
                <div className="font-inter-tight font-bold uppercase tracking-wide text-xs">
                    {label}
                </div>
                <div className="text-[11px] text-muted-foreground italic leading-snug">
                    {template}
                </div>
                <div className="text-[11px] text-foreground/80 mt-0.5">
                    {cost}
                    {note ? ` · ${note}` : ""}
                </div>
            </div>
        </li>
    );
}

export default HowToPlaySheet;
