import { useStore } from "@nanostores/react";
import { marked } from "marked";
import {
    BookOpen,
    ChevronUp,
    type LucideIcon,
    Search,
    X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Drawer as VaulDrawer } from "vaul";

import { deepColor } from "@/components/questionOverlayCard";
import RULEBOOK_MD from "@/content/rulebook.md?raw";
import { CATEGORIES } from "@/lib/categories";
import { openRulebookAt, RULEBOOK_ANCHORS, rulebookTarget } from "@/lib/rulebook";
import { applyUnitTemplates, resolvedUnits } from "@/lib/units";
import { cn } from "@/lib/utils";

/**
 * Rulebook viewer — the in-app reference for the Jet Lag: The Game *Hide + Seek*
 * rulebook, built to a best-in-class docs standard (v1044):
 *
 *   - a QUICK-REFERENCE landing (the six question types + the round phases,
 *     shown with the game's own icons) that jumps into the prose;
 *   - fast full-text SEARCH that highlights every hit in the content and lets
 *     you step through matches (prev / next, "3 of 12");
 *   - a SCROLL-SPY table of contents whose active item tracks what you're
 *     reading, on desktop (sidebar) and mobile (collapsible);
 *   - DEEP LINKS — any surface can open the reader straight at a rule via
 *     `openRulebookAt(anchor)` (`lib/rulebook.ts`).
 *
 * Source content lives in `src/content/rulebook.md`, bundled as a raw string.
 * Distances use `{{m:N}}` / `{{km:N}}` templates so the output respects the
 * user's unit preference (`lib/units.ts`).
 */

interface Section {
    id: string;
    level: number;
    title: string;
    body: string;
    parentId: string | null;
}

const SECTIONS = parseSections(RULEBOOK_MD);

/** Quick-reference: the six question types → their rulebook anchors, shown with
 *  the app's category icon + colour. Anchors are the slugified `###` headings. */
const QUESTION_REF: {
    id: keyof typeof CATEGORIES;
    anchor: string;
    blurb: string;
}[] = [
    { id: "matching", anchor: RULEBOOK_ANCHORS.matching, blurb: "Same nearest thing as the hider?" },
    { id: "measuring", anchor: RULEBOOK_ANCHORS.measuring, blurb: "Closer or further than the hider?" },
    { id: "radius", anchor: RULEBOOK_ANCHORS.radius, blurb: "Is the hider inside a radius?" },
    { id: "thermometer", anchor: RULEBOOK_ANCHORS.thermometer, blurb: "Warmer or colder after a move?" },
    { id: "tentacles", anchor: RULEBOOK_ANCHORS.tentacles, blurb: "Which of these is the hider nearest?" },
    { id: "photo", anchor: RULEBOOK_ANCHORS.photo, blurb: "Ask the hider for a photo." },
];

/** The round arc, each step linking to its section. */
const PHASE_REF: { label: string; anchor: string }[] = [
    { label: "Set up", anchor: RULEBOOK_ANCHORS.setup },
    { label: "Hiding", anchor: RULEBOOK_ANCHORS.hiding },
    { label: "Seeking", anchor: RULEBOOK_ANCHORS.seeking },
    { label: "Endgame", anchor: RULEBOOK_ANCHORS.endgame },
];

function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 60);
}

function parseSections(md: string): Section[] {
    const lines = md.split("\n");
    const out: Section[] = [];
    const usedIds = new Set<string>();
    let current: Section | null = null;
    const parentStack: Array<{ id: string; level: number }> = [];

    const flush = () => {
        if (current) {
            current.body = current.body.replace(/\s+$/, "");
            out.push(current);
        }
    };

    for (const line of lines) {
        const m = line.match(/^(#{1,6})\s+(.+)$/);
        if (m) {
            flush();
            const level = m[1].length;
            const title = m[2].trim();
            while (
                parentStack.length > 0 &&
                parentStack[parentStack.length - 1].level >= level
            ) {
                parentStack.pop();
            }
            const parentId =
                parentStack.length > 0
                    ? parentStack[parentStack.length - 1].id
                    : null;
            let id = slugify(title) || `section-${out.length}`;
            let suffix = 1;
            const base = id;
            while (usedIds.has(id)) {
                suffix++;
                id = `${base}-${suffix}`;
            }
            usedIds.add(id);
            current = { id, level, title, body: "", parentId };
            parentStack.push({ id, level });
            continue;
        }
        if (current) {
            current.body += (current.body ? "\n" : "") + line;
        }
    }
    flush();
    return out;
}

/** Strip markdown for the search index — substring match is enough. */
function plainText(md: string): string {
    return md
        // Drop inline HTML / SVG diagram markup so tag/attr names (path,
        // circle, rect, fill…) don't pollute search; the SVG's own <text>
        // labels survive as their content.
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^>\s?/gm, "")
        .replace(/\{\{[a-z]+:([\d.]+)\}\}/g, "$1");
}

/** Wrap every case-insensitive occurrence of `q` inside `root`'s text nodes in
 *  a `<mark class="rb-hit">`. Returns the created marks in document order. */
function highlightMatches(root: HTMLElement, q: string): HTMLElement[] {
    if (!q) return [];
    const marks: HTMLElement[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
        const t = n as Text;
        // Never wrap a <mark> inside an SVG (invalid there) — skip diagram
        // text nodes.
        if (t.parentElement?.closest("svg")) continue;
        if (t.nodeValue && t.nodeValue.toLowerCase().includes(q)) targets.push(t);
    }
    for (const t of targets) {
        const text = t.nodeValue ?? "";
        const lower = text.toLowerCase();
        const frag = document.createDocumentFragment();
        let i = 0;
        let idx = lower.indexOf(q, i);
        while (idx !== -1) {
            if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
            const mark = document.createElement("mark");
            mark.className = "rb-hit";
            mark.textContent = text.slice(idx, idx + q.length);
            frag.appendChild(mark);
            marks.push(mark);
            i = idx + q.length;
            idx = lower.indexOf(q, i);
        }
        if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
        t.replaceWith(frag);
    }
    return marks;
}

/**
 * A lightweight rulebook TRIGGER — wraps any button/child and opens the shared
 * singleton `RulebookSheet` (mounted once at the App level). Use this for a
 * manual "open the rulebook" entry point; deep-links from game surfaces should
 * call `openRulebookAt(anchor)` directly. `onBeforeOpen` lets a parent close its
 * own drawer first (e.g. the settings sheet).
 */
export function RulebookTrigger({
    children,
    onBeforeOpen,
}: {
    children: React.ReactNode;
    onBeforeOpen?: () => void;
}) {
    return (
        <span
            onClick={() => {
                onBeforeOpen?.();
                openRulebookAt("");
            }}
            className="contents"
            role="button"
            tabIndex={-1}
        >
            {children}
        </span>
    );
}

/**
 * The rulebook drawer itself — a SINGLETON driven entirely by the shared
 * `rulebookTarget` atom, so ANY surface (settings button, a "learn more" link on
 * a question / curse / power-up card) can open it via `openRulebookAt(anchor)`.
 * Mount exactly ONCE, app-level. Takes no props.
 */
export function RulebookSheet() {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeId, setActiveId] = useState<string | null>(null);
    const [showTop, setShowTop] = useState(false);
    const [hits, setHits] = useState<{ count: number; index: number }>({
        count: 0,
        index: 0,
    });
    const units = useStore(resolvedUnits);
    const $target = useStore(rulebookTarget);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const articleRef = useRef<HTMLElement | null>(null);
    const markRefs = useRef<HTMLElement[]>([]);

    const searchIndex = useMemo(
        () =>
            SECTIONS.map((s) => ({
                section: s,
                haystack: (s.title + "\n" + plainText(s.body)).toLowerCase(),
            })),
        [],
    );

    const q = query.trim().toLowerCase();
    const matchedIds = useMemo(() => {
        if (!q) return null;
        const matches = new Set<string>();
        for (const { section, haystack } of searchIndex) {
            if (haystack.includes(q)) matches.add(section.id);
        }
        const byId = new Map(SECTIONS.map((s) => [s.id, s]));
        for (const id of [...matches]) {
            let cur = byId.get(id);
            while (cur?.parentId) {
                matches.add(cur.parentId);
                cur = byId.get(cur.parentId);
            }
        }
        return matches;
    }, [q, searchIndex]);

    const tocSections = useMemo(
        () =>
            matchedIds
                ? SECTIONS.filter((s) => matchedIds.has(s.id))
                : SECTIONS.filter((s) => s.level <= 3),
        [matchedIds],
    );

    const handleJump = useCallback((id: string) => {
        setActiveId(id);
        const el = scrollRef.current?.querySelector<HTMLElement>(
            `[data-section-id="${id}"]`,
        );
        if (el && scrollRef.current) {
            scrollRef.current.scrollTo({
                top: el.offsetTop - 8,
                behavior: "smooth",
            });
        }
    }, []);

    const rendered = useMemo(() => {
        if (!open) return "";
        const fullMd = SECTIONS.map((s) => {
            const heading = "#".repeat(s.level) + " " + s.title;
            return `<section data-section-id="${s.id}" id="${s.id}">\n\n${heading}\n\n${s.body}\n\n</section>`;
        }).join("\n\n");
        const withUnits = applyUnitTemplates(fullMd, units);
        return marked.parse(withUnits, { async: false }) as string;
    }, [open, units]);

    // A pending deep-link anchor, held in a ref so the reset-on-open effect
    // knows NOT to scroll back to the top (which used to clobber the jump).
    const pendingJumpRef = useRef<string | null>(null);

    // Deep-link: opening via `openRulebookAt(anchor)` opens the sheet and jumps.
    // The content renders lazily once `open` flips AND the drawer plays an open
    // animation, so a single mid-animation smooth scroll got reset. We poll for
    // the target section, then INSTANT-scroll and RE-ASSERT it a few times
    // across the open animation so it lands and stays.
    useEffect(() => {
        if ($target === null) return;
        const anchor = $target;
        rulebookTarget.set(null);
        pendingJumpRef.current = anchor || null;
        setOpen(true);
        if (!anchor) return;
        setQuery("");
        let tries = 0;
        const timers: number[] = [];
        const scrollTo = (el: HTMLElement) => {
            if (scrollRef.current) {
                scrollRef.current.scrollTo({ top: el.offsetTop - 8 });
                setActiveId(anchor);
            }
        };
        const tryJump = () => {
            const el = scrollRef.current?.querySelector<HTMLElement>(
                `[data-section-id="${anchor}"]`,
            );
            if (el) {
                scrollTo(el);
                // Re-assert across the drawer open animation (~300ms) so the
                // landing isn't undone by layout settling.
                for (const d of [120, 260, 420]) {
                    timers.push(
                        window.setTimeout(() => {
                            const e2 = scrollRef.current?.querySelector<HTMLElement>(
                                `[data-section-id="${anchor}"]`,
                            );
                            if (e2) scrollTo(e2);
                        }, d),
                    );
                }
                pendingJumpRef.current = null;
            } else if (tries++ < 40) {
                timers.push(window.setTimeout(tryJump, 50));
            } else {
                pendingJumpRef.current = null;
            }
        };
        timers.push(window.setTimeout(tryJump, 60));
        return () => timers.forEach((t) => window.clearTimeout(t));
    }, [$target]);

    // Reset on open — but DON'T scroll to the top if a deep-link jump is
    // pending (that race is what made deep links "not work").
    useEffect(() => {
        if (open) {
            setQuery("");
            if (!pendingJumpRef.current) {
                requestAnimationFrame(() =>
                    scrollRef.current?.scrollTo({ top: 0 }),
                );
            }
        }
    }, [open]);

    // Scroll-spy: the active section is the last one whose top has passed the
    // reading line. Also drives the "back to top" affordance. rAF-throttled.
    useEffect(() => {
        if (!open) return;
        const root = scrollRef.current;
        if (!root) return;
        let raf = 0;
        const compute = () => {
            raf = 0;
            const els = Array.from(
                root.querySelectorAll<HTMLElement>("[data-section-id]"),
            );
            const y = root.scrollTop + 80;
            let cur: string | null = null;
            for (const el of els) {
                if (el.offsetTop <= y) cur = el.getAttribute("data-section-id");
                else break;
            }
            setActiveId(cur);
            setShowTop(root.scrollTop > 600);
        };
        const onScroll = () => {
            if (!raf) raf = requestAnimationFrame(compute);
        };
        root.addEventListener("scroll", onScroll, { passive: true });
        compute();
        return () => {
            root.removeEventListener("scroll", onScroll);
            if (raf) cancelAnimationFrame(raf);
        };
    }, [open, rendered]);

    // Highlight search hits in the content + collect them for prev/next.
    useEffect(() => {
        const art = articleRef.current;
        if (!art) return;
        // Clear old marks.
        art.querySelectorAll("mark.rb-hit").forEach((m) => {
            m.replaceWith(document.createTextNode(m.textContent ?? ""));
        });
        art.normalize();
        markRefs.current = [];
        if (!q) {
            setHits({ count: 0, index: 0 });
            return;
        }
        const marks = highlightMatches(art, q);
        markRefs.current = marks;
        setHits({ count: marks.length, index: marks.length ? 0 : 0 });
        if (marks.length) scrollToHit(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [q, rendered]);

    const scrollToHit = useCallback((index: number) => {
        const marks = markRefs.current;
        if (!marks.length) return;
        const clamped = ((index % marks.length) + marks.length) % marks.length;
        marks.forEach((m, i) =>
            m.classList.toggle("rb-hit-active", i === clamped),
        );
        const el = marks[clamped];
        const root = scrollRef.current;
        if (el && root) {
            root.scrollTo({
                top: root.scrollTop + el.getBoundingClientRect().top -
                    root.getBoundingClientRect().top - root.clientHeight / 2.6,
                behavior: "smooth",
            });
        }
        setHits((h) => ({ ...h, index: clamped }));
    }, []);

    const showQuickRef = !q;

    return (
        <>
            <VaulDrawer.Root
                open={open}
                onOpenChange={setOpen}
                shouldScaleBackground={false}
            >
                <VaulDrawer.Portal>
                    <VaulDrawer.Overlay className="fixed inset-0 z-[1055] bg-black/60" />
                    <VaulDrawer.Content
                        className={cn(
                            "fixed inset-x-0 bottom-0 z-[1060]",
                            "flex flex-col h-[92vh] sm:h-[88vh]",
                            "rounded-t-2xl border bg-background text-foreground",
                            "pb-[env(safe-area-inset-bottom)]",
                        )}
                    >
                        <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
                        <div className="px-4 pt-3 pb-2 border-b border-border shrink-0">
                            <VaulDrawer.Title className="flex items-center gap-2 text-lg font-semibold">
                                <BookOpen className="w-5 h-5" />
                                Hide + Seek Rulebook
                            </VaulDrawer.Title>
                            <VaulDrawer.Description className="sr-only">
                                Searchable transcription of the official rulebook.
                            </VaulDrawer.Description>
                            <div className="mt-2 flex items-center gap-2">
                                <div className="relative flex-1">
                                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <input
                                        type="search"
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                        placeholder="Search the rulebook…"
                                        className={cn(
                                            "w-full pl-8 pr-8 py-1.5 rounded-md text-sm",
                                            "bg-secondary border border-border",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        )}
                                    />
                                    {query && (
                                        <button
                                            type="button"
                                            aria-label="Clear search"
                                            onClick={() => setQuery("")}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                                {/* Match stepper — appears once a search has hits. */}
                                {q && hits.count > 0 && (
                                    <div className="flex items-center gap-1 shrink-0 text-xs tabular-nums text-muted-foreground">
                                        <span className="min-w-[3.5rem] text-center">
                                            {hits.index + 1} of {hits.count}
                                        </span>
                                        <button
                                            type="button"
                                            aria-label="Previous match"
                                            onClick={() => scrollToHit(hits.index - 1)}
                                            className="rounded border border-border px-1.5 py-1 hover:bg-accent"
                                        >
                                            ↑
                                        </button>
                                        <button
                                            type="button"
                                            aria-label="Next match"
                                            onClick={() => scrollToHit(hits.index + 1)}
                                            className="rounded border border-border px-1.5 py-1 hover:bg-accent"
                                        >
                                            ↓
                                        </button>
                                    </div>
                                )}
                            </div>
                            {q && hits.count === 0 && (
                                <p className="text-xs text-muted-foreground mt-1">
                                    No matches for “{query.trim()}”.
                                </p>
                            )}
                        </div>

                        <div className="flex-1 flex min-h-0 relative">
                            <nav
                                className={cn(
                                    "hidden md:block w-64 shrink-0 overflow-y-auto",
                                    "border-r border-border bg-secondary/30 py-3",
                                )}
                            >
                                <TableOfContents
                                    sections={tocSections}
                                    activeId={activeId}
                                    onJump={handleJump}
                                />
                            </nav>

                            <div className="flex-1 flex flex-col min-w-0">
                                <details className="md:hidden border-b border-border bg-secondary/30 px-4 py-2 text-sm">
                                    <summary className="font-semibold cursor-pointer">
                                        Contents
                                    </summary>
                                    <div className="mt-2">
                                        <TableOfContents
                                            sections={tocSections}
                                            activeId={activeId}
                                            onJump={(id) => {
                                                handleJump(id);
                                                (
                                                    scrollRef.current?.closest(
                                                        "details",
                                                    ) as HTMLDetailsElement | null
                                                )?.removeAttribute("open");
                                            }}
                                        />
                                    </div>
                                </details>

                                <div
                                    ref={scrollRef}
                                    className="flex-1 overflow-y-auto px-4 sm:px-6 py-4"
                                >
                                    <div className="max-w-3xl mx-auto">
                                        {showQuickRef && (
                                            <QuickReference onJump={handleJump} />
                                        )}
                                        <article
                                            ref={articleRef}
                                            className="rulebook-content"
                                            dangerouslySetInnerHTML={{
                                                __html: rendered,
                                            }}
                                        />
                                    </div>
                                </div>

                                {/* Back to top — appears after scrolling. */}
                                {showTop && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            scrollRef.current?.scrollTo({
                                                top: 0,
                                                behavior: "smooth",
                                            })
                                        }
                                        aria-label="Back to top"
                                        className={cn(
                                            "absolute bottom-4 right-4 z-10",
                                            "flex items-center gap-1.5 rounded-full pl-3 pr-3.5 py-2",
                                            "bg-primary text-primary-foreground shadow-lg",
                                            "text-xs font-semibold hover:opacity-90 transition-opacity",
                                        )}
                                    >
                                        <ChevronUp className="w-4 h-4" />
                                        Top
                                    </button>
                                )}
                            </div>
                        </div>
                    </VaulDrawer.Content>
                </VaulDrawer.Portal>
            </VaulDrawer.Root>
        </>
    );
}

/**
 * Quick-reference landing — the six question types (game icons + one-liner) and
 * the round phases, each a jump into the prose. This is the "learn as you play"
 * entry point board-game rules apps lead with, instead of a wall of text.
 */
function QuickReference({ onJump }: { onJump: (id: string) => void }) {
    return (
        <div className="mb-6">
            <p className="text-[11px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground mb-2">
                Question types
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {QUESTION_REF.map((qr) => {
                    const cat = CATEGORIES[qr.id];
                    const Icon = cat.icon as LucideIcon;
                    // v1067: match the in-game QuestionOverlayCard chrome — a
                    // solid deepened-colour icon block + a big bold UPPERCASE
                    // label in the deepened category colour + the blurb as the
                    // detail line, so the rulebook quick-ref reads as the same
                    // system as the on-map / add-question cards.
                    const deep = deepColor(cat.color);
                    return (
                        <button
                            key={qr.id}
                            type="button"
                            onClick={() => onJump(qr.anchor)}
                            className={cn(
                                "flex items-stretch text-left rounded-lg overflow-hidden",
                                "border border-border bg-sidebar-accent hover:brightness-110 transition-all shadow-sm",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            <span
                                className="w-12 shrink-0 grid place-items-center text-white"
                                style={{ backgroundColor: deep }}
                                aria-hidden="true"
                            >
                                <Icon className="w-6 h-6" />
                            </span>
                            <span className="px-2.5 py-2 min-w-0">
                                <span
                                    className="block text-sm font-black uppercase tracking-tight leading-tight"
                                    style={{ color: deep }}
                                >
                                    {cat.label}
                                </span>
                                <span className="block text-[11px] text-muted-foreground leading-snug mt-0.5">
                                    {qr.blurb}
                                </span>
                            </span>
                        </button>
                    );
                })}
            </div>

            <p className="text-[11px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground mt-4 mb-2">
                How a round flows
            </p>
            <div className="flex items-center flex-wrap gap-1.5">
                {PHASE_REF.map((p, i) => (
                    <span key={p.anchor} className="flex items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => onJump(p.anchor)}
                            className={cn(
                                "rounded-full px-3 py-1 text-xs font-semibold",
                                "border border-border bg-secondary/40 hover:bg-secondary transition-colors",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            {p.label}
                        </button>
                        {i < PHASE_REF.length - 1 && (
                            <span className="text-muted-foreground">→</span>
                        )}
                    </span>
                ))}
            </div>
            <hr className="mt-6 border-border" />
        </div>
    );
}

interface TableOfContentsProps {
    sections: Section[];
    activeId: string | null;
    onJump: (id: string) => void;
}

function TableOfContents({ sections, activeId, onJump }: TableOfContentsProps) {
    return (
        <ul className="space-y-0.5 text-sm">
            {sections.map((s) => (
                <li key={s.id}>
                    <button
                        type="button"
                        onClick={() => onJump(s.id)}
                        className={cn(
                            "w-full text-left px-3 py-1 rounded transition-colors border-l-2",
                            activeId === s.id
                                ? "bg-accent text-foreground font-semibold border-primary"
                                : "text-muted-foreground border-transparent hover:bg-accent",
                            s.level === 2 && "font-semibold text-foreground",
                            s.level === 3 && "pl-6 text-xs",
                            s.level === 4 && "pl-9 text-xs",
                        )}
                    >
                        {s.title}
                    </button>
                </li>
            ))}
        </ul>
    );
}

export default RulebookSheet;
