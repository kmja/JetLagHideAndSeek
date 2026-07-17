import { useStore } from "@nanostores/react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CardTile } from "@/components/CardTile";
import { type GameSize,gameSize } from "@/lib/gameSetup";
import { type Card, uniqueCardTemplates } from "@/lib/hiderDeck";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";

/**
 * Developer gallery of every unique hider-deck card, at `/debug/cards`.
 *
 * Renders one of each distinct template — every time-bonus tier, every
 * powerup, every curse — in the same `CardTile` chrome the hand fan
 * and HandCarousel use. Lets a designer or developer eyeball every
 * card surface on one screen without having to draw a full deck and
 * hope to flip them all.
 *
 * Side-effect-free: `CardTile` is a pure renderer (no Overpass
 * fetches, no atom writes, no question store touches). Visiting this
 * page can't pollute a live game. The previous version of this page
 * accidentally rendered *question* cards, which transitively kicked
 * off `findTentacleLocations()` calls at JSX construction time and
 * stacked a dozen failure toasts — the hider-deck cards have none of
 * that surface.
 */
export function DebugCardsPage() {
    // Game size only affects the time-bonus minute lookup on each
    // card's face. The toggle lets us preview "Time bonus · 5" in all
    // three rulebook variants (2 / 3 / 5 min) without flipping atoms.
    const $gameSize = useStore(gameSize);
    const [previewSize, setPreviewSize] = useState<GameSize>($gameSize);
    // Grid (all cards at a glance) vs Carousel (one card at full size).
    // Initial view is deep-linkable via `?view=carousel`.
    const [view, setView] = useState<"grid" | "carousel">(() =>
        new URLSearchParams(window.location.search).get("view") === "carousel"
            ? "carousel"
            : "grid",
    );

    const cards = useMemo(() => uniqueCardTemplates(), []);
    const byKind = useMemo(() => groupByKind(cards), [cards]);

    return (
        <div className="min-h-screen bg-background text-foreground">
            <header className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border px-4 py-3 flex items-center gap-3">
                <a
                    href="/"
                    className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back
                </a>
                <h1 className="font-poppins font-bold text-base">
                    Card gallery
                </h1>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground bg-secondary/60 rounded px-1.5 py-0.5">
                    {APP_VERSION}
                </span>
            </header>

            <div className="max-w-3xl mx-auto px-3 py-4 space-y-6 pb-24">
                <p className="text-xs text-muted-foreground leading-snug">
                    Every unique hider-deck card — one per distinct
                    template — in the same chrome the fan and hand
                    carousel use. Read-only: nothing here writes to your
                    real game.
                </p>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            Game size preview
                        </span>
                        <div className="inline-flex rounded-md border border-border overflow-hidden">
                            {(["small", "medium", "large"] as const).map(
                                (s) => (
                                    <button
                                        key={s}
                                        type="button"
                                        onClick={() => setPreviewSize(s)}
                                        className={cn(
                                            "px-2.5 py-1 text-xs font-poppins font-semibold",
                                            "transition-colors capitalize",
                                            previewSize === s
                                                ? "bg-primary text-primary-foreground"
                                                : "bg-secondary/60 text-foreground hover:bg-secondary",
                                        )}
                                    >
                                        {s}
                                    </button>
                                ),
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            View
                        </span>
                        <div className="inline-flex rounded-md border border-border overflow-hidden">
                            {(["grid", "carousel"] as const).map((v) => (
                                <button
                                    key={v}
                                    type="button"
                                    onClick={() => setView(v)}
                                    className={cn(
                                        "px-2.5 py-1 text-xs font-poppins font-semibold",
                                        "transition-colors capitalize",
                                        view === v
                                            ? "bg-primary text-primary-foreground"
                                            : "bg-secondary/60 text-foreground hover:bg-secondary",
                                    )}
                                >
                                    {v}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {view === "grid" ? (
                    <>
                        <Section
                            title={`Time bonus (${byKind.timeBonus.length})`}
                            cards={byKind.timeBonus}
                            previewSize={previewSize}
                        />
                        <Section
                            title={`Powerups (${byKind.powerup.length})`}
                            cards={byKind.powerup}
                            previewSize={previewSize}
                        />
                        <Section
                            title={`Curses (${byKind.curse.length})`}
                            cards={byKind.curse}
                            previewSize={previewSize}
                        />
                    </>
                ) : (
                    <Carousel cards={cards} previewSize={previewSize} />
                )}
            </div>
        </div>
    );
}

/**
 * Full-size single-card carousel — steps through every unique template
 * (time-bonus → powerups → curses) one at a time at a large size, so a
 * card can be eyeballed exactly as it looks in the hand. Prev/next
 * buttons + left/right arrow keys; a compact dot strip jumps anywhere.
 */
function Carousel({
    cards,
    previewSize,
}: {
    cards: Card[];
    previewSize: GameSize;
}) {
    const [i, setI] = useState(0);
    const n = cards.length;
    const go = (d: number) => setI((p) => ((p + d) % n + n) % n);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "ArrowLeft") go(-1);
            else if (e.key === "ArrowRight") go(1);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [n]);

    if (n === 0) return null;
    const card = cards[i];

    return (
        <div className="flex flex-col items-center gap-4">
            <div className="text-xs font-mono text-muted-foreground text-center">
                {card.name}
                <span className="ml-2 opacity-60">
                    {i + 1} / {n}
                </span>
            </div>
            <div className="flex items-center gap-2 sm:gap-4 w-full justify-center">
                <button
                    type="button"
                    onClick={() => go(-1)}
                    aria-label="Previous card"
                    className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full border border-border bg-secondary/60 text-foreground hover:bg-secondary transition-colors"
                >
                    <ChevronLeft className="w-5 h-5" />
                </button>
                <div className="w-[min(80vw,340px)] shrink-0">
                    <CardTile
                        card={card}
                        gameSize={previewSize}
                        selectionIndicator="none"
                    />
                </div>
                <button
                    type="button"
                    onClick={() => go(1)}
                    aria-label="Next card"
                    className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full border border-border bg-secondary/60 text-foreground hover:bg-secondary transition-colors"
                >
                    <ChevronRight className="w-5 h-5" />
                </button>
            </div>
            <div className="flex flex-wrap gap-1.5 justify-center max-w-md">
                {cards.map((c, idx) => (
                    <button
                        key={c.id}
                        type="button"
                        onClick={() => setI(idx)}
                        aria-label={`Go to ${c.name}`}
                        className={cn(
                            "w-2 h-2 rounded-full transition-colors",
                            idx === i
                                ? "bg-primary"
                                : "bg-muted hover:bg-muted-foreground/40",
                        )}
                    />
                ))}
            </div>
        </div>
    );
}

function Section({
    title,
    cards,
    previewSize,
}: {
    title: string;
    cards: Card[];
    previewSize: GameSize;
}) {
    if (cards.length === 0) return null;
    return (
        <section className="space-y-2">
            <h2 className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                {title}
            </h2>
            {/* Grid of full-size CardTile instances. The HandFan
                miniaturises these to fit the rest screen; here we let
                them breathe at their natural size so each line of copy
                is legible. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {cards.map((card) => (
                    <div key={card.id} className="space-y-1">
                        <div className="text-[10px] text-muted-foreground/70 font-mono px-1 truncate">
                            {card.name}
                        </div>
                        <CardTile
                            card={card}
                            gameSize={previewSize}
                            selectionIndicator="none"
                        />
                    </div>
                ))}
            </div>
        </section>
    );
}

function groupByKind(cards: Card[]): {
    timeBonus: Card[];
    powerup: Card[];
    curse: Card[];
} {
    const out = { timeBonus: [] as Card[], powerup: [] as Card[], curse: [] as Card[] };
    for (const c of cards) {
        if (c.kind === "time-bonus") out.timeBonus.push(c);
        else if (c.kind === "powerup") out.powerup.push(c);
        else out.curse.push(c);
    }
    return out;
}

export default DebugCardsPage;
