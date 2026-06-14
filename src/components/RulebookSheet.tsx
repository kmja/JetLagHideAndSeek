import { useStore } from "@nanostores/react";
import { marked } from "marked";
import { BookOpen, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import RULEBOOK_MD from "@/content/rulebook.md?raw";
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import {
    applyUnitTemplates,
    resolvedUnits,
    unitPreference,
    type UnitPreference,
} from "@/lib/units";
import { cn } from "@/lib/utils";

/**
 * Rulebook viewer — searchable in-app reference for the Jet Lag:
 * The Game *Hide + Seek* rulebook.
 *
 * Source content lives in `src/content/rulebook.md` and is bundled
 * as a raw string via Vite's `?raw` import. We parse it once at
 * module load into a flat list of sections (one per `##`/`###`
 * heading) so search can scan plain text fast and the TOC can jump
 * to anchors without re-rendering the whole document.
 *
 * Distances in the markdown use `{{m:N}}` / `{{km:N}}` templates so
 * the rendered output respects the user's units preference (set in
 * `lib/units.ts`, default "auto" detecting from locale). Re-applies
 * on preference change.
 *
 * The component opens as a bottom Sheet on mobile / right-side Sheet
 * on desktop. The trigger is rendered by the consumer (passed as
 * `children`) so it slots cleanly into the BottomNav "More" sheet
 * without leaking its own button styling.
 */

interface Section {
    /** Stable anchor id derived from the heading text. */
    id: string;
    /** `2` for `##` (top-level section), `3` for `###`, etc. */
    level: number;
    title: string;
    /** Raw markdown body for this section, NOT including descendant
     *  sub-section bodies. Used for search and for one-section render
     *  when the user has filtered. */
    body: string;
    /** All descendant headings, flattened. Used to render the TOC
     *  nested without an extra tree pass at render time. */
    parentId: string | null;
}

const SECTIONS = parseSections(RULEBOOK_MD);

function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 60);
}

/**
 * Split a markdown document into a flat list of sections keyed by
 * heading. Each section's `body` is the markdown BETWEEN its heading
 * and the next heading of equal-or-shallower depth — sub-headings
 * remain inside the parent's body so a single `marked` render of
 * the parent shows the full subtree.
 *
 * Two heading-id collisions in the rulebook are deliberate ("Hiding
 * Zones" and "The Hider Deck" appear in both Quickstart and
 * Hiding sections); slugs disambiguate with a `-N` suffix on the
 * second occurrence so anchors stay unique.
 */
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
            // Pop parents until we find one strictly shallower than us.
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

/** Strip `**bold**`, links, code etc. for the search index. We're not
 *  trying to be a full markdown lexer — substring-match against the
 *  plain text is enough for "find rule" use cases. */
function plainText(md: string): string {
    return md
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^>\s?/gm, "")
        .replace(/\{\{[a-z]+:([\d.]+)\}\}/g, "$1");
}

interface RulebookSheetProps {
    /** What button or label the parent renders inside More / Settings.
     *  Rendered as a sibling (NOT as a SheetTrigger child) so opening
     *  the rulebook from inside a host Sheet doesn't tear it down with
     *  the host's portal — see `handleTriggerClick` for the rAF dance. */
    children: React.ReactNode;
    /** Caller can close its own surface (e.g. the More sheet) before
     *  the rulebook opens so they don't stack. */
    onBeforeOpen?: () => void;
}

export function RulebookSheet({ children, onBeforeOpen }: RulebookSheetProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeId, setActiveId] = useState<string | null>(null);
    const units = useStore(resolvedUnits);
    const pref = useStore(unitPreference);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    // Pre-build the search index once. plainText() runs over ~25 KB
    // of markdown — fast but worth memoizing across re-renders so a
    // keystroke doesn't re-strip the whole document.
    const searchIndex = useMemo(
        () =>
            SECTIONS.map((s) => ({
                section: s,
                haystack: (
                    s.title +
                    "\n" +
                    plainText(s.body)
                ).toLowerCase(),
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
        // Bubble parents up so the TOC shows the path to every hit.
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

    const handleJump = (id: string) => {
        setActiveId(id);
        const el = scrollRef.current?.querySelector<HTMLElement>(
            `[data-section-id="${id}"]`,
        );
        if (el && scrollRef.current) {
            // scrollIntoView would scroll the page; we want only the
            // sheet's internal scroller to move.
            scrollRef.current.scrollTo({
                top: el.offsetTop - 8,
                behavior: "smooth",
            });
        }
    };

    // Render markdown once per (preference, open) — `units` changing
    // (and `pref` driving it) is the only reason to re-render content
    // while the sheet is open.
    const rendered = useMemo(() => {
        if (!open) return "";
        const fullMd = SECTIONS.map((s) => {
            const heading = "#".repeat(s.level) + " " + s.title;
            return `<section data-section-id="${s.id}" id="${s.id}">\n\n${heading}\n\n${s.body}\n\n</section>`;
        }).join("\n\n");
        const withUnits = applyUnitTemplates(fullMd, units);
        return marked.parse(withUnits, { async: false }) as string;
    }, [open, units]);

    // When opening, reset scroll + query for a predictable first
    // impression.
    useEffect(() => {
        if (open) {
            setQuery("");
            requestAnimationFrame(() => {
                scrollRef.current?.scrollTo({ top: 0 });
            });
        }
    }, [open]);

    // Open via a sibling trigger, NOT <SheetTrigger asChild>: when the
    // rulebook button lives inside a host Sheet (the "More" sheet),
    // synchronously calling onOpenChange on the host AND opening this
    // sheet in the same React tick caused the host's portal to unmount
    // mid-open and tear this one down with it. Calling onBeforeOpen
    // first, then deferring setOpen(true) to the next frame, lets the
    // host's close animation start before our portal mounts — so we
    // mount under the body root cleanly rather than as a transient
    // child of a dying portal subtree. Mirrors HowToPlaySheet's
    // pattern, which had the same bug for the same reason.
    const handleTriggerClick = () => {
        if (onBeforeOpen) {
            onBeforeOpen();
            requestAnimationFrame(() => setOpen(true));
        } else {
            setOpen(true);
        }
    };

    return (
        <>
            <span onClick={handleTriggerClick} className="contents">
                {children}
            </span>
            <Sheet open={open} onOpenChange={setOpen}>
                <SheetContent
                side="bottom"
                className="h-[92vh] sm:h-[88vh] rounded-t-2xl flex flex-col p-0"
            >
                <SheetHeader className="px-4 pt-4 pb-2 border-b border-border">
                    <SheetTitle className="flex items-center gap-2">
                        <BookOpen className="w-5 h-5" />
                        Hide + Seek Rulebook
                    </SheetTitle>
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
                        <UnitsSelect value={pref} onChange={unitPreference.set} />
                    </div>
                    {q && matchedIds && (
                        <p className="text-xs text-muted-foreground mt-1">
                            {[...matchedIds].filter(
                                (id) =>
                                    !SECTIONS.find((s) => s.id === id)
                                        ?.parentId ||
                                    searchIndex
                                        .find((e) => e.section.id === id)
                                        ?.haystack.includes(q),
                            ).length}{" "}
                            section{matchedIds.size === 1 ? "" : "s"} match
                        </p>
                    )}
                </SheetHeader>

                <div className="flex-1 flex min-h-0">
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
                        {/* Mobile-only TOC at the top of the scroller —
                            collapsible details so it doesn't push the
                            content way down. */}
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
                                        // Collapse after pick on mobile.
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
                            <article
                                className="rulebook-content max-w-3xl mx-auto"
                                dangerouslySetInnerHTML={{ __html: rendered }}
                            />
                        </div>
                    </div>
                </div>
                </SheetContent>
            </Sheet>
        </>
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
                            "w-full text-left px-3 py-1 rounded transition-colors",
                            "hover:bg-accent",
                            activeId === s.id
                                ? "bg-accent text-foreground font-semibold"
                                : "text-muted-foreground",
                            s.level === 2 &&
                                "font-semibold text-foreground pl-3",
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

interface UnitsSelectProps {
    value: UnitPreference;
    onChange: (v: UnitPreference) => void;
}

function UnitsSelect({ value, onChange }: UnitsSelectProps) {
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value as UnitPreference)}
            className={cn(
                "text-xs py-1.5 px-2 rounded-md border border-border bg-secondary",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            aria-label="Units"
            title="Distance units used throughout the app"
        >
            <option value="metric">Metric (m, km)</option>
            <option value="imperial">Imperial (ft, mi)</option>
        </select>
    );
}

export default RulebookSheet;
