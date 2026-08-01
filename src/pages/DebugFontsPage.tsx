import { ArrowLeft, List, Map as MapIcon, Plus, Tent, Users } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { HiderTimer } from "@/components/HiderTimer";
import { HiderUnansweredOverlay } from "@/components/HiderUnansweredOverlay";
import { PendingAnswerOverlay } from "@/components/PendingAnswerOverlay";
import {
    NAV_BTN_CLASS,
    NAV_LABEL_CLASS,
    NAV_PRIMARY_CLASS,
    NAV_PRIMARY_LABEL_CLASS,
    NavBadge,
} from "@/components/bottomNavPrimitives";
import {
    QuestionOverlayCard,
    summarizeQuestion,
} from "@/components/questionOverlayCard";
import { Button } from "@/components/ui/button";
import type { InboxEntry } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";
import type { Question } from "@/maps/schema";

/**
 * Developer FONT-SIZE lab at `/debug/fonts`.
 *
 * Unlike a static mock, this renders the REAL app components — the on-map
 * overlays (`PendingAnswerOverlay`, `HiderUnansweredOverlay`, `HiderTimer`)
 * via their `preview` props, the real bottom-nav primitives, and a real
 * `QuestionOverlayCard` dialog — so it uses the app's ACTUAL fonts (Poppins /
 * Inter Tight / M PLUS Rounded, loaded app-wide) and chrome.
 *
 * The sliders remap the actual Tailwind size utilities (`text-xs`,
 * `text-[10px]`, `text-3xl`, …) to CSS variables scoped to `.font-lab`, so
 * dragging one resizes every real element that uses that class — no component
 * changes, no global state touched.
 */

const MOCK_LAT = 51.5074;
const MOCK_LNG = -0.1278;

function mockPending(
    id: string,
    data: Record<string, unknown>,
    key: number,
    now: number,
): Question {
    return {
        id,
        key,
        data: {
            lat: MOCK_LAT,
            lng: MOCK_LNG,
            drag: true,
            createdAt: now,
            ...data,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

function mockAnswered(
    id: string,
    data: Record<string, unknown>,
    key: number,
    now: number,
): Question {
    return {
        id,
        key,
        data: {
            lat: MOCK_LAT,
            lng: MOCK_LNG,
            drag: false,
            createdAt: now - 600_000,
            ...data,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

function mockInbox(
    id: string,
    data: Record<string, unknown>,
    now: number,
): InboxEntry {
    return {
        key: 999100,
        id,
        data: { lat: MOCK_LAT, lng: MOCK_LNG, drag: true, ...data },
        arrivedAt: now - 48_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

/** The size tokens the real components use, with their app defaults. */
const TOKENS: {
    var: string;
    cls: string;
    label: string;
    sub: string;
    def: number;
    min: number;
    max: number;
}[] = [
    { var: "--fs-9", cls: "text-[9px]", label: "text-[9px]", sub: "count badges", def: 9, min: 7, max: 16 },
    { var: "--fs-10", cls: "text-[10px]", label: "text-[10px]", sub: "eyebrows, counters", def: 10, min: 8, max: 18 },
    { var: "--fs-11", cls: "text-[11px]", label: "text-[11px]", sub: "compact labels", def: 11, min: 8, max: 18 },
    { var: "--fs-xs", cls: "text-xs", label: "text-xs", sub: "nav labels, detail, hints", def: 12, min: 9, max: 20 },
    { var: "--fs-sm", cls: "text-sm", label: "text-sm", sub: "body, banners, buttons", def: 14, min: 10, max: 22 },
    { var: "--fs-base", cls: "text-base", label: "text-base", sub: "lg button text", def: 16, min: 12, max: 24 },
    { var: "--fs-lg", cls: "text-lg", label: "text-lg", sub: "headings", def: 18, min: 13, max: 28 },
    { var: "--fs-xl", cls: "text-xl", label: "text-xl", sub: "card titles", def: 20, min: 14, max: 32 },
    { var: "--fs-2xl", cls: "text-2xl", label: "text-2xl", sub: "big labels", def: 24, min: 16, max: 40 },
    { var: "--fs-3xl", cls: "text-3xl", label: "text-3xl", sub: "live timer digits", def: 30, min: 18, max: 56 },
];

// Scoped override: within `.font-lab`, each Tailwind size class reads its
// matching CSS var (set by the sliders). The `\\[` / `\\]` escape the arbitrary
// -value class-name brackets in the emitted CSS.
const OVERRIDE_CSS = `
.font-lab .text-\\[9px\\]{font-size:var(--fs-9)!important}
.font-lab .text-\\[10px\\]{font-size:var(--fs-10)!important}
.font-lab .text-\\[11px\\]{font-size:var(--fs-11)!important}
.font-lab .text-xs{font-size:var(--fs-xs)!important}
.font-lab .text-sm{font-size:var(--fs-sm)!important}
.font-lab .text-base{font-size:var(--fs-base)!important}
.font-lab .text-lg{font-size:var(--fs-lg)!important}
.font-lab .text-xl{font-size:var(--fs-xl)!important}
.font-lab .text-2xl{font-size:var(--fs-2xl)!important}
.font-lab .text-3xl{font-size:var(--fs-3xl)!important}
`;

/** A framed cell that becomes the containing block for an overlay's
 *  fixed/absolute positioning (a non-`none` transform). */
function Cell({
    label,
    tall,
    children,
}: {
    label: string;
    tall?: boolean;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground">
                {label}
            </div>
            <div
                className={cn(
                    "relative rounded-lg border border-border overflow-hidden",
                    "bg-[hsl(var(--sidebar-background))]",
                    tall ? "h-80" : "h-72",
                )}
                style={{ transform: "translateZ(0)" }}
            >
                <div
                    className="absolute inset-0 opacity-[0.15]"
                    style={{
                        backgroundImage:
                            "linear-gradient(hsl(var(--border)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)",
                        backgroundSize: "28px 28px",
                    }}
                    aria-hidden
                />
                {children}
            </div>
        </div>
    );
}

/** The seeker bottom nav, built from the REAL shared primitives. */
function SeekerNav() {
    return (
        <div className="flex items-stretch gap-1 rounded-xl border border-border bg-[hsl(var(--background))] p-1.5">
            <div className={NAV_BTN_CLASS}>
                <List className="w-5 h-5" />
                <span className={NAV_LABEL_CLASS}>Questions</span>
                <NavBadge
                    count={3}
                    className="bg-secondary border border-border text-foreground"
                />
            </div>
            <div className={NAV_PRIMARY_CLASS}>
                <Plus className="w-6 h-6" />
                <span className={NAV_PRIMARY_LABEL_CLASS}>Ask</span>
            </div>
            <div className={NAV_BTN_CLASS}>
                <MapIcon className="w-5 h-5" />
                <span className={NAV_LABEL_CLASS}>Map</span>
                <NavBadge
                    count={2}
                    className="bg-primary border border-background text-primary-foreground"
                />
            </div>
            <div className={NAV_BTN_CLASS}>
                <Users className="w-5 h-5" />
                <span className={NAV_LABEL_CLASS}>Lobby</span>
                <NavBadge
                    count={4}
                    className="bg-secondary border border-border text-foreground"
                />
            </div>
        </div>
    );
}

/** The hider bottom nav, built from the REAL shared primitives. */
function HiderNav() {
    return (
        <div className="flex items-stretch gap-1 rounded-xl border border-border bg-[hsl(var(--background))] p-1.5">
            <div className={NAV_BTN_CLASS}>
                <List className="w-5 h-5" />
                <span className={NAV_LABEL_CLASS}>Questions</span>
                <NavBadge count={1} className="bg-primary text-primary-foreground" />
            </div>
            <div className={NAV_BTN_CLASS}>
                <Tent className="w-5 h-5" />
                <span className={NAV_LABEL_CLASS}>Zone</span>
            </div>
            <div className={NAV_BTN_CLASS}>
                <MapIcon className="w-5 h-5" />
                <span className={NAV_LABEL_CLASS}>Map</span>
            </div>
            <div className={NAV_BTN_CLASS}>
                <Users className="w-5 h-5" />
                <span className={NAV_LABEL_CLASS}>Lobby</span>
                <NavBadge count={4} className="bg-primary text-primary-foreground" />
            </div>
        </div>
    );
}

/** A real configure-question dialog card (`QuestionOverlayCard` header +
 *  real `Button`s). */
function DialogCard({ now }: { now: number }) {
    const summary = useMemo(
        () =>
            summarizeQuestion(
                mockAnswered("measuring", { type: "museum" }, 999300, now),
            ),
        [now],
    );
    return (
        <div className="mx-auto w-full max-w-sm rounded-2xl border border-border bg-[hsl(var(--background))] shadow-xl overflow-hidden">
            <div className="p-3">
                <QuestionOverlayCard
                    categoryId="measuring"
                    summary={summary}
                    categoryEyebrow
                    flat
                />
            </div>
            <div className="px-4 pb-1">
                <p className="text-sm text-muted-foreground leading-relaxed">
                    Send this question to the hider. They&apos;ll answer whether
                    they&apos;re closer to or further from their nearest museum
                    than you are.
                </p>
            </div>
            <div className="flex gap-2 p-4">
                <Button variant="secondary" className="flex-1">
                    Cancel
                </Button>
                <Button className="flex-1">Send question</Button>
            </div>
        </div>
    );
}

export function DebugFontsPage() {
    const [now] = useState(() => Date.now());
    const [theme, setTheme] = useState<"dark" | "light">("dark");

    // Slider state → CSS vars applied on the `.font-lab` wrapper.
    const [sizes, setSizes] = useState<Record<string, number>>(() =>
        Object.fromEntries(TOKENS.map((t) => [t.var, t.def])),
    );
    // Overall scale — `zoom` magnifies the WHOLE preview (type + spacing +
    // icons together), which is the "everything bigger, not just cramped text"
    // knob. The per-class sliders tune relative type sizes on top of it.
    const [scale, setScale] = useState(1);
    const labStyle = useMemo(
        () =>
            ({
                ...Object.fromEntries(
                    TOKENS.map((t) => [t.var, `${sizes[t.var]}px`]),
                ),
                zoom: scale,
            }) as React.CSSProperties,
        [sizes, scale],
    );

    const M = 60_000;

    return (
        <div
            className={cn(
                theme,
                "min-h-screen bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]",
            )}
            style={{ colorScheme: theme }}
        >
            <style>{OVERRIDE_CSS}</style>

            {/* Header */}
            <div className="sticky top-0 z-20 flex items-center gap-3 px-4 py-3 border-b border-border bg-background/95 backdrop-blur">
                <Link
                    to="/"
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md hover:bg-accent shrink-0"
                    aria-label="Back to app"
                >
                    <ArrowLeft className="w-4 h-4" />
                </Link>
                <div className="min-w-0 flex-1">
                    <div className="font-display font-extrabold uppercase text-sm leading-none tracking-wide">
                        Font-size lab
                    </div>
                    <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                        Real components + real fonts · sliders remap the actual
                        Tailwind size classes · does not touch your game
                    </div>
                </div>
                <div className="flex items-center rounded-md border border-border overflow-hidden shrink-0 text-xs font-semibold">
                    {(["dark", "light"] as const).map((t) => (
                        <button
                            key={t}
                            type="button"
                            onClick={() => setTheme(t)}
                            className={cn(
                                "px-2.5 py-1.5 capitalize transition-colors",
                                theme === t
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-background text-muted-foreground hover:bg-accent",
                            )}
                        >
                            {t}
                        </button>
                    ))}
                </div>
            </div>

            <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 p-4 md:grid-cols-[260px_1fr]">
                {/* Controls */}
                <aside className="md:sticky md:top-[68px] md:self-start rounded-xl border border-border bg-background p-4">
                    <div className="mb-3 flex items-center justify-between">
                        <div className="text-[11px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground">
                            Font-size lab
                        </div>
                        <button
                            type="button"
                            className="text-xs font-semibold text-primary hover:underline"
                            onClick={() => {
                                setSizes(
                                    Object.fromEntries(
                                        TOKENS.map((t) => [t.var, t.def]),
                                    ),
                                );
                                setScale(1);
                            }}
                        >
                            Reset
                        </button>
                    </div>

                    {/* Overall scale — type + spacing together. */}
                    <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
                        <div className="flex items-baseline justify-between gap-2">
                            <label
                                htmlFor="ui-scale"
                                className="text-sm font-bold"
                            >
                                Overall scale
                            </label>
                            <span
                                className={cn(
                                    "text-xs tabular-nums font-bold",
                                    scale === 1
                                        ? "text-muted-foreground"
                                        : "text-primary",
                                )}
                            >
                                {Math.round(scale * 100)}%
                            </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground mb-1.5">
                            Scales type AND spacing together — the "everything
                            bigger" knob.
                        </div>
                        <input
                            id="ui-scale"
                            type="range"
                            min={0.8}
                            max={1.7}
                            step={0.05}
                            value={scale}
                            onChange={(e) => setScale(Number(e.target.value))}
                            className="w-full accent-primary"
                        />
                    </div>

                    <div className="text-[11px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground mb-2">
                        Per-class fine-tuning
                    </div>
                    <div className="flex flex-col gap-3.5">
                        {TOKENS.map((t) => (
                            <div key={t.var}>
                                <div className="flex items-baseline justify-between gap-2">
                                    <label
                                        htmlFor={t.var}
                                        className="text-sm font-semibold font-mono"
                                    >
                                        {t.label}
                                    </label>
                                    <span
                                        className={cn(
                                            "text-xs tabular-nums font-bold",
                                            sizes[t.var] === t.def
                                                ? "text-muted-foreground"
                                                : "text-primary",
                                        )}
                                    >
                                        {sizes[t.var]}px
                                    </span>
                                </div>
                                <div className="text-[11px] text-muted-foreground mb-1">
                                    {t.sub} · default {t.def}px
                                </div>
                                <input
                                    id={t.var}
                                    type="range"
                                    min={t.min}
                                    max={t.max}
                                    step={1}
                                    value={sizes[t.var]}
                                    onChange={(e) =>
                                        setSizes((s) => ({
                                            ...s,
                                            [t.var]: Number(e.target.value),
                                        }))
                                    }
                                    className="w-full accent-primary"
                                />
                            </div>
                        ))}
                    </div>
                </aside>

                {/* Preview — everything below reads the `.font-lab` size vars. */}
                <div className="font-lab flex flex-col gap-7" style={labStyle}>
                    {/* Seeker */}
                    <section className="flex flex-col gap-3">
                        <h2 className="text-sm font-display font-extrabold uppercase tracking-wide">
                            Seeker view
                        </h2>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <Cell label="Pending answer · answered" tall>
                                <PendingAnswerOverlay
                                    preview={{
                                        questions: [
                                            mockAnswered(
                                                "measuring",
                                                {
                                                    type: "museum",
                                                    hiderCloser: true,
                                                },
                                                999201,
                                                now,
                                            ),
                                        ],
                                        forcePhase: "answered",
                                    }}
                                />
                            </Cell>
                            <Cell label="Pending answer · awaiting" tall>
                                <PendingAnswerOverlay
                                    preview={{
                                        questions: [
                                            mockPending(
                                                "matching",
                                                { type: "museum" },
                                                999202,
                                                now - 40_000,
                                            ),
                                        ],
                                    }}
                                />
                            </Cell>
                        </div>
                        <Cell label="Hider timer · seeking (leaderboard)" tall>
                            <HiderTimer
                                preview={{
                                    endsAt: now - 12 * M,
                                    roundLog: [
                                        {
                                            roundNumber: 1,
                                            hidingMs: 15 * M,
                                            hiderName: "Ben",
                                            foundAt: now - 30 * M,
                                        },
                                        {
                                            roundNumber: 2,
                                            hidingMs: 9 * M,
                                            hiderName: "Priya",
                                            foundAt: now - 20 * M,
                                        },
                                    ],
                                }}
                            />
                        </Cell>
                        <div>
                            <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground mb-1.5">
                                Bottom nav
                            </div>
                            <SeekerNav />
                        </div>
                    </section>

                    {/* Hider */}
                    <section className="flex flex-col gap-3">
                        <h2 className="text-sm font-display font-extrabold uppercase tracking-wide">
                            Hider view
                        </h2>
                        <Cell label="Incoming question overlay" tall>
                            <HiderUnansweredOverlay
                                preview={{
                                    inbox: [
                                        mockInbox(
                                            "measuring",
                                            { type: "park" },
                                            now,
                                        ),
                                    ],
                                }}
                            />
                        </Cell>
                        <div>
                            <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground mb-1.5">
                                Bottom nav
                            </div>
                            <HiderNav />
                        </div>
                    </section>

                    {/* Dialog */}
                    <section className="flex flex-col gap-3">
                        <h2 className="text-sm font-display font-extrabold uppercase tracking-wide">
                            Dialog · configure question
                        </h2>
                        <DialogCard now={now} />
                    </section>
                </div>
            </div>
        </div>
    );
}

export default DebugFontsPage;
